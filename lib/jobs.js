/**
 * Background extraction driver. Owns the work queue, the per-session turn
 * watermark, the synthesis cadence, and the one-shot history backfill.
 *
 * Nothing here blocks a live conversation: every model call runs in its own
 * subagent session and every failure is contained to a status field.
 *
 * @module dsh-user-portrait/jobs
 */

import {
  blacklistForProfile,
  buildSessionPrompt,
  buildSynthesisPrompt,
  buildTurnPrompt,
  enforceEntryCaps,
  filterBlacklisted,
  foldTurns,
  isDigestible,
  mergeSynthesis,
  normalizeEntryCap,
  normalizeSessionRollup,
  normalizeTurnDigest,
  planTimelineCompaction,
  safeParse,
  selectSynthesisSource,
  sourceIndexOf,
} from './extract.js';
import {
  clampCharLimit,
  DEFAULT_ENTRY_CAP,
  DIMENSION_GROUPS,
  DIMENSIONS,
} from './schema.js';

/**
 * Dimensions grouped for synthesis: one model call per group.
 *
 * The daily group is small enough to merge in one call; each technical dimension
 * gets its own. That granularity is the point — a reply for one dimension cannot
 * overrun the output budget (which used to discard the entire synthesis), and a
 * failure costs one dimension instead of the whole profile.
 */
const SYNTHESIS_SCOPES = DIMENSION_GROUPS.flatMap((group) =>
  group.id === 'daily'
    ? [DIMENSIONS.filter((dimension) => dimension.group === group.id)]
    : DIMENSIONS.filter((dimension) => dimension.group === group.id).map((dimension) => [dimension]),
);

/** Upper bound on turns digested for one historical session. */
const BACKFILL_TURNS_PER_SESSION = 24;

/** A run older than this is treated as dead, so the button never locks forever. */
const BACKFILL_STALE_MS = 30 * 60 * 1000;

/** Rows kept per protected turn when the timeline is compacted. */
const TIMELINE_ROWS_PER_TURN = 2;

/**
 * How long a scoped turn synthesis waits before running.
 *
 * Pure coalescing: a burst of turns inside this window folds in one round of
 * calls instead of one round per turn. Long enough to merge a rapid exchange,
 * short enough that the panel is current by the time the user looks at it.
 */
const TURN_SYNTHESIS_DELAY_MS = 3000;

/**
 * Build synthesis scopes for a specific set of dimensions.
 *
 * Touched daily dimensions share one call (they are small); every touched
 * technical dimension gets its own, matching {@link SYNTHESIS_SCOPES} so a reply
 * cannot overrun the output budget.
 *
 * @param dimensionIds - dimension ids touched by fresh evidence.
 * @returns scopes ready for {@link PortraitEngine.synthesize}.
 */
export function scopesForDimensions(dimensionIds) {
  const wanted = new Set(Array.isArray(dimensionIds) ? dimensionIds : []);
  const scopes = [];
  const daily = DIMENSIONS.filter((dimension) => dimension.group === 'daily' && wanted.has(dimension.id));
  if (daily.length > 0) scopes.push(daily);
  for (const dimension of DIMENSIONS) {
    if (dimension.group !== 'tech' || !wanted.has(dimension.id)) continue;
    scopes.push([dimension]);
  }
  return scopes;
}

/**
 * Drive one job at a time so background work stays quiet.
 */
export class JobRunner {
  #queue = [];
  #running = false;
  #disposed = false;
  #status = {
    running: undefined,
    pending: 0,
    completed: 0,
    failed: 0,
    lastError: undefined,
    lastCompletedAt: undefined,
  };

  /**
   * @param options - injected capabilities and tunables.
   */
  constructor(options) {
    this.options = options;
  }

  /** A snapshot of background work, for tools and the review panel. */
  get status() {
    return { ...this.#status, pending: this.#queue.length };
  }

  /**
   * Enqueue one job.
   * @param label - human-readable job label.
   * @param run - the job body.
   */
  push(label, run) {
    if (this.#disposed) return;
    if (this.#queue.length >= this.options.maxQueue) return;
    this.#queue.push({ label, run });
    void this.#pump();
  }

  /** Stop accepting work and drop what is queued. */
  dispose() {
    this.#disposed = true;
    this.#queue.length = 0;
  }

  async #pump() {
    if (this.#running || this.#disposed) return;
    const job = this.#queue.shift();
    if (job === undefined) return;
    this.#running = true;
    this.#status.running = job.label;
    try {
      await job.run();
      this.#status.completed += 1;
      this.#status.lastCompletedAt = Date.now();
    } catch (error) {
      this.#status.failed += 1;
      this.#status.lastError = error instanceof Error ? error.message : String(error);
      this.options.log(`job failed (${job.label}): ${this.#status.lastError}`);
    } finally {
      this.#running = false;
      this.#status.running = undefined;
      if (this.#queue.length > 0) void this.#pump();
    }
  }
}

/**
 * The extraction coordinator: turns session logs into digests and portrait
 * evidence, and folds portrait evidence into the profile document.
 */
export class PortraitEngine {
  /**
   * @param options - store, runner, model caller, config, and logger.
   */
  constructor(options) {
    this.store = options.store;
    this.runner = options.runner;
    this.config = options.config;
    this.log = options.log;
    this.askModel = options.askModel;
    this.listSessions = options.listSessions;
    this.readSessionEvents = options.readSessionEvents;
    /**
     * Reports whether this engine instance is still the live one.
     *
     * A plugin reload hands background work to a new instance while the old job
     * keeps running (it must: the host reloads on every file change, and killing
     * the job there was the "user-portrait disposed" failure). This gate lets the
     * superseded job stop before spending another model call.
     */
    this.isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
    this.watermarks = new Map();
    this.turnsSinceSynthesis = 0;
    this.lastSynthesisAt = 0;
    this.synthesisInFlight = false;
    /** Dimensions waiting for the coalescing window to close. */
    this.pendingDimensions = new Set();
    /** Pending coalescing timer, when one is armed. */
    this.synthesisTimer = undefined;
    this.backfill = { active: false, total: 0, done: 0, startedAt: 0, finishedAt: 0, error: undefined };
    this.skippedSessions = new Set();
  }

  /**
   * Load persisted watermarks so a restart resumes instead of re-digesting.
   */
  async hydrate() {
    const state = await this.store.readState();
    for (const [sessionId, record] of Object.entries(state.watermarks ?? {})) {
      if (record !== null && typeof record === 'object') this.watermarks.set(sessionId, { ...record });
    }
    this.turnsSinceSynthesis = Number.isFinite(state.turnsSinceSynthesis) ? state.turnsSinceSynthesis : 0;
    this.skippedSessions = new Set(Array.isArray(state.skippedSessions) ? state.skippedSessions : []);
    this.lastSynthesisAt = Number.isFinite(state.lastSynthesisAt) ? state.lastSynthesisAt : 0;
  }

  /** Persist the live watermarks and cadence counters. */
  async persist() {
    const watermarks = {};
    for (const [sessionId, record] of this.watermarks) watermarks[sessionId] = record;
    await this.store.updateState((state) => {
      state.watermarks = watermarks;
      state.turnsSinceSynthesis = this.turnsSinceSynthesis;
      state.lastSynthesisAt = this.lastSynthesisAt;
      state.skippedSessions = [...this.skippedSessions];
    });
  }

  /**
   * Digest one turn of a session, then run synthesis when the cadence says so.
   * @param request - session identity, header, and the events of that turn.
   */
  digestTurn(request) {
    this.runner.push(`turn-digest ${request.sessionId}#${request.turn.turn}`, async () => {
      const watermark = this.watermarks.get(request.sessionId) ?? { lastTurn: 0, digests: 0 };
      if (request.turn.turn <= (watermark.lastTurn ?? 0)) return;
      const prompt = buildTurnPrompt(request, this.config.limits);
      const reply = await this.askModel({ label: `portrait-turn-${request.turn.turn}`, prompt });
      const parsed = safeParse(reply);
      const charLimit = await this.#charLimit();
      const digest = normalizeTurnDigest(parsed, request.turn, { textLimit: charLimit });
      await this.store.appendTurn(request.sessionId, digest);
      const evidenceRows = digest.evidence.map((item) => ({
        kind: 'dimension',
        dimension: item.dimension,
        statement: item.statement,
        text: item.text,
        confidence: item.confidence,
        source: item.source,
        sessionId: request.sessionId,
        turn: digest.turn,
        at: digest.at,
      }));
      for (const correction of digest.corrections) {
        // A correction is only the user's own words when the digest grounded it
        // against their turn (`basis` + the matched `source` line); otherwise it is
        // the model's paraphrase of its own reply and must not be presented as the
        // user's statement.
        const basis = correction.basis === 'assistant' ? 'assistant' : 'user';
        evidenceRows.push({
          kind: 'preference',
          dimension: dimensionForPreference(correction.kind),
          statement: basis,
          text: correction.text,
          confidence: basis === 'assistant' ? 'low' : 'high',
          source: typeof correction.source === 'string' && correction.source !== '' ? correction.source : digest.userAsk,
          sessionId: request.sessionId,
          turn: digest.turn,
          at: digest.at,
        });
      }
      const recorded = await this.store.appendEvidence(await this.#dropBlacklisted(evidenceRows));
      const next = {
        lastTurn: request.turn.turn,
        digests: (watermark.digests ?? 0) + 1,
        updatedAt: Date.now(),
      };
      this.watermarks.set(request.sessionId, next);
      this.turnsSinceSynthesis += 1;
      await this.store.updateSessionFromTurn(request, digest);
      await this.persist();
      this.log(
        `turn digested: ${request.sessionId} T${digest.turn} (+${recorded.length} evidence, ${digest.evidence.length} dimension rows)`,
      );
      // Every finished turn folds its own evidence in, but only for the dimensions
      // that evidence actually touches: a typical turn touches one or two, so this
      // is one or two small calls instead of the five-call full synthesis. No fresh
      // evidence means nothing to fold, and nothing is called at all.
      const touched = [...new Set(recorded.map((row) => row.dimension).filter((dimension) => typeof dimension === 'string' && dimension !== ''))];
      if (touched.length === 0) {
        this.log('synthesis skipped (turn): no fresh evidence');
        return;
      }
      if (this.config.synthesizeEveryTurns > 0 && this.turnsSinceSynthesis >= this.config.synthesizeEveryTurns) {
        this.turnsSinceSynthesis = 0;
        this.scheduleTurnSynthesis(touched);
      }
    });
  }

  /**
   * Queue a scoped synthesis for the dimensions one turn touched.
   *
   * Bursts are coalesced: a new turn arriving inside the window joins the pending
   * set instead of starting a second call, so rapid back-and-forth costs one round
   * of calls rather than one per turn.
   *
   * @param dimensions - dimension ids touched by the turn's fresh evidence.
   * @returns nothing.
   */
  scheduleTurnSynthesis(dimensions) {
    for (const dimension of dimensions) this.pendingDimensions.add(dimension);
    if (this.synthesisTimer !== undefined) return;
    this.synthesisTimer = setTimeout(() => {
      this.synthesisTimer = undefined;
      const pending = [...this.pendingDimensions];
      this.pendingDimensions.clear();
      const scope = scopesForDimensions(pending);
      if (scope.length === 0) return;
      void this.synthesize('turn', { scope }).catch((error) =>
        this.log(`turn synthesis failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    }, Math.max(0, Number(this.config.turnSynthesisDelayMs ?? TURN_SYNTHESIS_DELAY_MS)));
    this.synthesisTimer.unref?.();
  }

  /**
   * Fold fresh evidence into the profile, one dimension group at a time.
   *
   * A single whole-profile rewrite asked the model to echo every entry in every
   * dimension; on a real profile that reply overran the output budget, and a
   * capped reply is discarded whole — so the profile never appeared at all. Each
   * call here carries only its own group, so the reply stays small, and a group
   * that fails costs only that group.
   *
   * @param trigger - why synthesis ran, recorded in the log.
   * @param options - optional `scope`: the dimensions to fold (defaults to all).
   * @returns the combined merge report, or undefined when synthesis was skipped.
   */
  async synthesize(trigger, options = {}) {
    if (this.synthesisInFlight) return undefined;
    this.synthesisInFlight = true;
    try {
      const scopes =
        Array.isArray(options.scope) && options.scope.length > 0
          ? options.scope.filter((scope) => Array.isArray(scope) && scope.length > 0)
          : SYNTHESIS_SCOPES;
      let profile = await this.store.profile(true);
      const cutoff = profile.lastSynthesisAt ?? 0;
      // Blacklisted rows never reach the model: a retired conclusion's evidence is
      // still in the ledger (only permanent deletes remove it), so this is what makes
      // "废弃后不再计入提炼" true for synthesis as well as for fresh digests.
      const blacklistDoc = await this.store.readBlacklist();
      const blacklist = new Set(blacklistDoc.keys);
      const blacklistTurns = new Set(blacklistDoc.turns ?? []);
      // Read the budget once: the same document supplies the text limit for merges and
      // the count ceiling afterwards.
      const state = await this.store.readState();
      const capDocument = normalizeEntryCap(state.entryCap);
      const rows = selectSynthesisSource(await this.store.readEvidence(), blacklist, blacklistTurns);
      if (blacklist.size > 0) {
        this.log(`synthesis source excludes ${blacklist.size} blacklisted evidence key(s)`);
      }
      const pending = rows.filter((row) => (row.at ?? 0) > cutoff);
      const source = pending.length > 0 ? pending : rows.slice(-40);
      // A scoped run (one turn's worth of evidence) has nothing to prove: the
      // per-turn path already checked that fresh evidence exists.
      const scoped = Array.isArray(options.scope) && options.scope.length > 0;
      if (!scoped && source.length < this.config.minEvidenceForSynthesis) {
        this.log(`synthesis skipped (${trigger}): only ${source.length} evidence rows (need ${this.config.minEvidenceForSynthesis})`);
        return undefined;
      }

      const totals = { acceptedEntries: 0, preservedEntries: 0, combinedEntries: 0 };
      const failed = [];
      // One index of the ledger for every group: it is what gives each stored
      // source its time and excerpt without asking the model to echo them.
      const sourceIndex = sourceIndexOf(rows);
      for (const scope of scopes) {
        if (!this.isCurrent()) {
          this.log(`synthesis stopped (${trigger}): this instance was superseded`);
          break;
        }
        const batch = source.filter((row) => scope.some((dimension) => dimension.id === row.dimension));
        const hasExisting = scope.some((dimension) => (profile.dimensions?.[dimension.id] ?? []).length > 0);
        // A group with neither evidence nor existing entries has nothing to do.
        if (batch.length === 0 && !hasExisting) continue;
        const prompt = buildSynthesisPrompt(profile, batch.slice(-this.config.limits.synthesisEvidence), scope);
        const label = `portrait-synthesis-${scope.map((dimension) => dimension.id).join('-')}`;
        let reply;
        try {
          reply = await this.askModel({ label, prompt });
        } catch (error) {
          failed.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        const parsed = safeParse(reply);
        if (parsed === undefined) {
          failed.push(`${label}: reply was not parsable JSON`);
          continue;
        }
        const { profile: merged, report } = mergeSynthesis(profile, parsed, Date.now(), { sourceIndex, textLimit: capDocument.charLimit });
        if (report.accepted !== true) {
          failed.push(`${label}: ${report.reason}`);
          continue;
        }
        profile = merged;
        totals.acceptedEntries += report.acceptedEntries ?? 0;
        totals.preservedEntries += report.preservedEntries ?? 0;
        totals.combinedEntries += report.combinedEntries ?? 0;
      }

      if (failed.length === SYNTHESIS_SCOPES.length) {
        this.log(`synthesis failed (${trigger}): every group failed — ${failed.join('; ')}`);
        return undefined;
      }

      profile.lastSynthesisAt = Date.now();
      profile.synthesizedTurns = (profile.synthesizedTurns ?? 0) + 1;

      // The conclusion budget is applied after every group is merged: the cap spans
      // dimensions (whole portrait or a whole group), so it cannot live inside one
      // group's merge pass. Overflow folds into the most related conclusion of the
      // same dimension, and whatever cannot be folded is dropped and reported.
      const capped = enforceEntryCaps(profile, capDocument);
      profile = capped.profile;
      const overflow = {
        limit: capped.limits,
        counts: capped.counts,
        merged: capped.merged,
        dropped: capped.dropped,
      };
      if (capped.merged.length > 0 || capped.dropped.length > 0) {
        this.log(
          `entry cap applied: ${capped.merged.length} folded, ${capped.dropped.length} dropped ` +
            `(mode=${capped.limits.mode}, counts=${JSON.stringify(capped.counts)})`,
        );
      }

      await this.store.saveProfile(profile);
      // Synthesis can retire a conclusion (superseded by a contradictory one). The
      // derived blacklist layer must follow that immediately, not wait for the next
      // manual edit, otherwise the superseded evidence keeps feeding the next run.
      await this.#reconcileBlacklist(profile);
      this.turnsSinceSynthesis = 0;
      this.lastSynthesisAt = profile.lastSynthesisAt;
      await this.persist();
      this.log(
        `synthesis applied (${trigger}): ${totals.acceptedEntries} entries accepted, ${totals.combinedEntries} folded into existing conclusions, ${totals.preservedEntries} preserved` +
          (failed.length > 0 ? `; ${failed.length} group(s) failed: ${failed.join('; ')}` : ''),
      );
      return { ...totals, failed, overflow };
    } finally {
      this.synthesisInFlight = false;
    }
  }

  /**
   * The configured per-conclusion character limit.
   *
   * Read once per digest / synthesis rather than kept in a field, so a change made
   * in the panel applies to the next turn without a restart.
   *
   * @returns the clamped limit.
   */
  async #charLimit() {
    const state = await this.store.readState();
    return clampCharLimit(state?.entryCap?.charLimit, DEFAULT_ENTRY_CAP.charLimit);
  }
  /**
   * Recompute the derived blacklist layer after a profile change.
   *
   * The same rule the panel's entry actions apply: pinned keys survive, and every
   * row supporting a non-active conclusion is silenced unless an active conclusion
   * still cites it.
   *
   * @param profile - the profile just saved.
   * @returns the key count after reconciliation.
   */
  async #reconcileBlacklist(profile) {
    const rows = await this.store.readEvidence();
    const current = await this.store.readBlacklist();
    const desired = blacklistForProfile(profile, rows, current.pinnedKeys, current.pinnedTurns);
    const sortedCurrent = [...current.keys].sort();
    const sortedTurns = [...(current.turns ?? [])].sort();
    const same =
      desired.keys.length === sortedCurrent.length &&
      desired.turns.length === sortedTurns.length &&
      desired.keys.every((key, index) => key === sortedCurrent[index]) &&
      desired.turns.every((key, index) => key === sortedTurns[index]);
    if (!same) await this.store.writeBlacklist(desired);
    return desired.keys.length;
  }

  /**
   * Remove evidence rows the user has blacklisted by deleting a conclusion.
   *
   * The check happens as rows are written, because that is the only moment a
   * re-digest of an old session can bring deleted evidence back.
   *
   * @param rows - the evidence rows a digest just produced.
   * @returns the rows that may still be recorded.
   */
  async #dropBlacklisted(rows) {
    const blacklist = await this.store.readBlacklist();
    if (blacklist.keys.length === 0 && (blacklist.turns ?? []).length === 0) return rows;
    const kept = filterBlacklisted(rows, new Set(blacklist.keys), new Set(blacklist.turns ?? []));
    if (kept.length !== rows.length) {
      this.log(`blacklist skipped ${rows.length - kept.length} evidence row(s) from a deleted conclusion`);
    }
    return kept;
  }

  /**
   * Digest a whole session into a roll-up record.
   * @param sessionId - session identity.
   * @param header - the session header.
   */
  digestSession(sessionId, header) {
    this.runner.push(`session-digest ${sessionId}`, async () => {
      const turns = await this.store.readTurns(sessionId);
      if (turns.length < this.config.sessionRollupMinTurns) return;
      const reply = await this.askModel({ prompt: buildSessionPrompt(sessionId, turns), label: `portrait-session-${sessionId}` });
      const parsed = safeParse(reply);
      if (parsed === undefined) {
        this.log(`session roll-up skipped: ${sessionId} (unparsable reply)`);
        return;
      }
      const rollup = { ...normalizeSessionRollup(parsed), source: 'model' };
      const digest = await this.store.readSession(sessionId);
      await this.store.writeSession({
        sessionId,
        createdAt: header?.createdAt ?? digest?.createdAt ?? turns[0]?.at ?? Date.now(),
        cwd: header?.cwd ?? digest?.cwd,
        turnCount: turns.length,
        rollup,
        turns,
      });
      this.log(`session digested: ${sessionId} (${turns.length} turns)`);
    });
  }

  /**
   * Start the one-shot history backfill over every stored session.
   * @param options - `force` re-processes sessions already digested.
   * @returns the backfill plan.
   */
  async startBackfill(options = {}) {
    if (this.backfill.active) {
      // A run that never settles (a model call that hangs) would otherwise lock this
      // button forever and leave the progress banner on screen. Treat an unreasonably
      // old run as dead and start a fresh one.
      const age = Date.now() - (this.backfill.startedAt ?? 0);
      if (age < BACKFILL_STALE_MS) return this.backfill;
      this.log(`backfill considered stale after ${Math.round(age / 60000)} min; starting a fresh run`);
      this.backfill.active = false;
    }
    const sessions = await this.listSessions();
    const state = await this.store.readState();
    const processed = new Set(state.processedSessions ?? []);
    const targets = [];
    for (const record of sessions) {
      const header = record.header ?? record;
      const sessionId = String(header.id ?? '');
      if (sessionId === '') continue;
      if (header.origin === 'subagent') continue;
      if (!options.force && processed.has(sessionId)) continue;
      if (this.skippedSessions.has(sessionId) && !options.force) continue;
      targets.push({ sessionId, header, live: record.live === true });
    }
    // Newest first: the most recent context is the most representative.
    targets.sort((left, right) => (right.header.createdAt ?? 0) - (left.header.createdAt ?? 0));
    this.backfill = { active: true, total: targets.length, done: 0, startedAt: Date.now(), finishedAt: 0, error: undefined };
    void this.#runBackfill(targets, options);
    return this.backfill;
  }

  async #runBackfill(targets, options) {
    try {
      for (const target of targets) {
        if (!this.isCurrent()) {
          this.log('backfill stopped: this instance was superseded');
          break;
        }
        if (this.runner.status.pending > 200) {
          // Let the queue drain so a huge history cannot exhaust memory.
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        await this.#backfillOne(target, options);
        this.backfill.done += 1;
      }
    } catch (error) {
      this.backfill.error = error instanceof Error ? error.message : String(error);
      this.log(`backfill stopped: ${this.backfill.error}`);
    } finally {
      this.backfill.active = false;
      this.backfill.finishedAt = Date.now();
      this.log(`backfill finished: ${this.backfill.done}/${this.backfill.total}`);
      // Only the live instance folds the result: a superseded one would merge a
      // stale view of the profile over the newer one.
      if (this.isCurrent()) await this.synthesize('backfill');
      // After a re-run, work out what the timeline could shed. This is a preview:
      // the panel decides whether to apply it.
      if (this.isCurrent()) await this.#previewTimelinePlan();
    }
  }

  /**
   * Recompute the compaction preview and expose it on the next describe().
   * @returns the plan stats.
   */
  async #previewTimelinePlan() {
    const profile = await this.store.profile();
    const rows = await this.store.readEvidence();
    const plan = planTimelineCompaction(profile, rows, TIMELINE_ROWS_PER_TURN);
    this.lastTimelinePlan = plan.stats;
    if (plan.stats.removedRows > 0) {
      this.log(
        `timeline compaction available: ${plan.stats.removedRows} unused row(s) across ` +
          `${plan.stats.removedTurns} turn(s); confirm in the panel to remove`,
      );
    }
    return plan.stats;
  }

  async #backfillOne(target, options) {
    let events;
    try {
      events = await this.readSessionEvents(target.sessionId);
    } catch (error) {
      this.log(`backfill skipped ${target.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      this.skippedSessions.add(target.sessionId);
      return;
    }
    const folded = foldTurns(events).filter((turn) => turn.endedAt !== undefined && isDigestible(turn));
    if (folded.length === 0) {
      this.skippedSessions.add(target.sessionId);
      await this.store.updateState((state) => {
        state.processedSessions = uniquePush(state.processedSessions, target.sessionId);
        state.skippedSessions = [...this.skippedSessions];
      });
      return;
    }
    const selected = folded.slice(-BACKFILL_TURNS_PER_SESSION);
    const watermark = this.watermarks.get(target.sessionId) ?? { lastTurn: 0, digests: 0 };
    if (!options.force && watermark.lastTurn >= selected[selected.length - 1].turn) {
      await this.markProcessed(target.sessionId);
      return;
    }
    const collected = [];
    const textLimit = await this.#charLimit();
    for (const turn of selected) {
      if (!options.force && turn.turn <= (watermark.lastTurn ?? 0)) continue;
      const prompt = buildTurnPrompt({ sessionId: target.sessionId, cwd: target.header?.cwd, turn }, this.config.limits);
      const reply = await this.askModel({ label: `portrait-backfill-${turn.turn}`, prompt });
      collected.push(normalizeTurnDigest(safeParse(reply), turn, { textLimit }));
    }
    if (collected.length === 0) {
      await this.markProcessed(target.sessionId);
      return;
    }
    for (const digest of collected) await this.store.appendTurn(target.sessionId, digest);
    const rows = [];
    for (const digest of collected) {
      for (const item of digest.evidence) {
        rows.push({
          kind: 'dimension',
          dimension: item.dimension,
          statement: item.statement,
          text: item.text,
          confidence: item.confidence,
          source: item.source,
          sessionId: target.sessionId,
          turn: digest.turn,
          at: digest.at,
        });
      }
      for (const correction of digest.corrections) {
        // Verified basis only: an unverified correction is a model paraphrase.
        const basis = correction.basis === 'assistant' ? 'assistant' : 'user';
        rows.push({
          kind: 'preference',
          dimension: dimensionForPreference(correction.kind),
          statement: basis,
          text: correction.text,
          confidence: basis === 'assistant' ? 'low' : 'high',
          source: typeof correction.source === 'string' && correction.source !== '' ? correction.source : digest.userAsk,
          sessionId: target.sessionId,
          turn: digest.turn,
          at: digest.at,
        });
      }
    }
    // The backfill path writes rows itself, so it needs the same blacklist guard as
    // the per-turn digest: re-digesting history must not revive deleted conclusions.
    await this.store.appendEvidence(await this.#dropBlacklisted(rows));
    const last = collected[collected.length - 1];
    this.watermarks.set(target.sessionId, {
      lastTurn: last.turn,
      digests: (watermark.digests ?? 0) + collected.length,
      updatedAt: Date.now(),
    });
    await this.store.writeSession({
      sessionId: target.sessionId,
      createdAt: target.header?.createdAt ?? collected[0].at,
      cwd: target.header?.cwd,
      turnCount: collected.length,
      turns: collected,
    });
    await this.markProcessed(target.sessionId);
    await this.persist();
    this.log(`backfilled ${target.sessionId}: ${collected.length} turns, ${rows.length} evidence rows`);
  }

  async markProcessed(sessionId) {
    await this.store.updateState((state) => {
      state.processedSessions = uniquePush(state.processedSessions, sessionId);
    });
  }

  /** A snapshot of extraction progress, for tools and the review panel. */
  async describe() {
    const profile = await this.store.profile();
    const evidence = await this.store.readEvidence();
    const sessions = await this.store.listSessions();
    let entries = 0;
    for (const dimension of Object.values(profile.dimensions ?? {})) {
      for (const entry of dimension) if (entry.status === 'active') entries += 1;
    }
    return {
      entries,
      evidence: evidence.length,
      digests: sessions.length,
      turnsSinceSynthesis: this.turnsSinceSynthesis,
      lastSynthesisAt: profile.lastSynthesisAt ?? 0,
      backfill: { ...this.backfill },
      // Filled in after a backfill/redigest run: the panel offers the cleanup as a
      // preview ("can remove N rows") instead of deleting evidence behind its back.
      timelinePlan: this.lastTimelinePlan ?? null,
      jobs: this.runner.status,
      dataDir: this.store.paths.root,
    };
  }
}

/**
 * Pick a dimension for a preference-shaped statement.
 * @param kind - the correction kind produced by the digest model.
 * @returns a dimension id.
 */
function dimensionForPreference(kind) {
  const text = typeof kind === 'string' ? kind : '';
  if (text.includes('红线') || text.includes('边界')) return 'boundary';
  if (text.includes('纠正') || text.includes('不满')) return 'friction';
  if (text.includes('沟通') || text.includes('语气') || text.includes('表达')) return 'personality';
  if (text.includes('风格') || text.includes('节奏') || text.includes('习惯')) return 'workstyle';
  if (text.includes('价值') || text.includes('优先') || text.includes('取舍')) return 'workstyle';
  return 'friction';
}

/**
 * Append a value to an array when it is not already present.
 * @param list - existing array, possibly undefined.
 * @param value - value to append.
 * @returns the array with the value present.
 */
function uniquePush(list, value) {
  const array = Array.isArray(list) ? list : [];
  if (!array.includes(value)) array.push(value);
  return array;
}















