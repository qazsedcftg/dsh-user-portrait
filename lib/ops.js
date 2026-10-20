/**
 * Portrait operations. One implementation serves three callers: the agent
 * tools, the review panel's HTTP routes, and the background engine.
 *
 * @module dsh-user-portrait/ops
 */

import {
  clampCharLimit,
  DEFAULT_ENTRY_CAP,
  DIMENSION_GROUPS,
  DIMENSIONS,
  DIMENSION_IDS,
  ENTRY_TEXT_LIMIT,
  entryId,
  evidenceKey,
  groupOfDimension,
  resolveDimensionId,
  normalizeProfile,
} from './schema.js';
import { emptyProfile, formatTime } from './store.js';
import { blacklistForProfile, normalizeEntryCap, planTimelineCompaction, rowSupportsEntry, turnKey } from './extract.js';
import { normalizeSessionMode, resolveSessionMode } from './session-modes.js';

/** Rows kept per protected turn when the timeline is compacted. */
const TIMELINE_ROWS_PER_TURN = 2;

/**
 * Read one query-string value.
 * @param params - parsed query parameters.
 * @param key - parameter name.
 * @returns the value, or undefined.
 */
function param(params, key) {
  const value = params.get(key);
  return value === null || value === '' ? undefined : value;
}

/**
 * The portrait operations bound to one store and engine.
 */
export class PortraitOps {
  /**
   * @param options - store, engine, config, and logger.
   */
  constructor(options) {
    this.store = options.store;
    this.engine = options.engine;
    this.config = options.config;
    this.log = options.log;
    /**
     * Live cache of the per-session portrait switches.
     *
     * The prompt section is rendered synchronously, so it reads this Map instead of
     * the state file; every write here is persisted in the same step.
     */
    this.modes = options.modes instanceof Map ? options.modes : new Map();
  }

  /**
   * The portrait switches that apply to one session.
   * @param sessionId - the session identity.
   * @returns `{ enabled, daily, tech }`.
   */
  async sessionMode(sessionId) {
    return resolveSessionMode(this.modes, typeof sessionId === 'string' ? sessionId : '', '');
  }

  /**
   * Change one session's switches.
   *
   * Only the fields present in the request change, so the popover can flip one
   * toggle without restating the others.
   *
   * @param request - `session` plus any of `enabled`, `daily`, `tech`.
   * @returns the stored mode.
   */
  async setSessionMode(request) {
    const sessionId = typeof request?.session === 'string' ? request.session : '';
    if (sessionId === '') return { ok: false, error: 'session 不能为空' };
    const current = resolveSessionMode(this.modes, sessionId, '');
    const next = normalizeSessionMode({
      enabled: request.enabled ?? current.enabled,
      daily: request.daily ?? current.daily,
      tech: request.tech ?? current.tech,
    });
    this.modes.set(sessionId, next);
    await this.store.updateState((state) => {
      const modes = state.sessionModes !== null && typeof state.sessionModes === 'object' && !Array.isArray(state.sessionModes)
        ? state.sessionModes
        : {};
      modes[sessionId] = next;
      state.sessionModes = modes;
    });
    return { ok: true, action: 'setSessionMode', mode: next };
  }

  /**
   * Render the portrait as text, optionally narrowed to one dimension.
   * @param options - `dimension` and `status` filters, and `includeRetired`.
   * @returns the rendered text and a machine-readable summary.
   */
  async read(options = {}) {
    const profile = await this.store.profile();
    const dimensionFilter = resolveDimensionId(options.dimension);
    const wantRetired = options.includeRetired === true;
    const lines = [];
    let active = 0;
    let retired = 0;
    let currentGroup = '';
    for (const dimension of DIMENSIONS) {
      if (dimensionFilter !== undefined && dimension.id !== dimensionFilter) continue;
      if (dimension.group !== currentGroup) {
        currentGroup = dimension.group;
        const group = DIMENSION_GROUPS.find((candidate) => candidate.id === dimension.group);
        if (group !== undefined) lines.push(`# ${group.label}`, '');
      }
      const entries = profile.dimensions?.[dimension.id] ?? [];
      const shown = entries.filter((entry) => entry.status === 'active' || wantRetired);
      active += entries.filter((entry) => entry.status === 'active').length;
      retired += entries.filter((entry) => entry.status !== 'active').length;
      lines.push(`## ${dimension.label} (${dimension.id})`);
      if (shown.length === 0) {
        lines.push('（暂无证据）', '');
        continue;
      }
      for (const entry of shown) {
        const sources = (entry.sources ?? [])
          .slice(0, 5)
          .map((source) => `${source.sessionId}${source.turn === undefined ? '' : `#T${source.turn}`}`)
          .join(', ');
        // The statement and the source count are part of the conclusion: the
        // reader must know whether this rests on the user's words, on an inference,
        // or on both, and how much backing it has. The raw excerpt stays in the
        // evidence ledger and out of the rendered portrait.
        const basis =
          entry.statement === 'assistant'
            ? '依据/模型应答'
            : entry.statement === 'mixed'
              ? '依据/用户的话&模型应答'
              : '依据/用户的话';
        const count = (entry.sources ?? []).length;
        lines.push(
          `- [${entry.confidence}/${entry.status}/${basis}${count === 0 ? '' : `·来源${count}处`}] ${entry.text}` +
            (entry.note === undefined || entry.note === '' ? '' : ` —— ${entry.note}`) +
            (sources === '' ? '' : ` （出处: ${sources}）`),
        );
      }
      lines.push('');
    }
    if ((profile.notes ?? []).length > 0 && dimensionFilter === undefined) {
      lines.push('## 用户手动备注（最高优先级）', '');
      for (const note of profile.notes) lines.push(`- [${formatTime(note.at)}] ${note.text}`);
      lines.push('');
    }
    const header = [
      `人物画像 · 更新于 ${formatTime(profile.updatedAt)} · 已提炼 ${profile.synthesizedTurns} 次 · active 条目 ${active} 条（另有已废弃 ${retired} 条）`,
      `数据目录: ${this.store.paths.root}`,
      '',
    ];
    return { text: [...header, ...lines].join('\n'), profile };
  }

  /**
   * List session records and their per-turn summaries.
   * @param options - `sessionId` for one session, `limit` for how many sessions.
   * @returns the rendered text and structured rows.
   */
  async history(options = {}) {
    const limit = Number.isFinite(options.limit) ? Math.min(Math.max(1, options.limit), 50) : 10;
    const sessions = options.sessionId === undefined
      ? (await this.store.listSessions()).slice(-limit).reverse()
      : [await this.store.readSession(options.sessionId)].filter(Boolean);
    if (sessions.length === 0) {
      return { text: '还没有任何会话记录。可用 `portrait_maintain` 的 `backfill` 动作回填历史会话。', sessions: [] };
    }
    const lines = [`记录在案的会话 ${sessions.length} 个（最近在前）：`, ''];
    for (const session of sessions) {
      const rollup = session.rollup ?? {};
      lines.push(`### ${session.sessionId}`);
      lines.push(
        `- 时间: ${formatTime(session.createdAt)} → ${formatTime(session.updatedAt ?? session.createdAt)} · 轮次 ${session.turnCount ?? (session.turns ?? []).length}`,
      );
      if (rollup.topic !== undefined && rollup.topic !== '') lines.push(`- 主题: ${rollup.topic}`);
      if (rollup.overview !== undefined && rollup.overview !== '') lines.push(`- 概要: ${rollup.overview}`);
      if ((rollup.outcomes ?? []).length > 0) lines.push(`- 产出: ${rollup.outcomes.join('；')}`);
      if ((rollup.unresolved ?? []).length > 0) lines.push(`- 遗留: ${rollup.unresolved.join('；')}`);
      const turns = options.includeTurns === false ? [] : (session.turns ?? []);
      for (const turn of turns) {
        lines.push(`  - T${turn.turn}【我问】${turn.userAsk ?? '（未记录）'}`);
        if ((turn.userKeyPoints ?? []).length > 0) lines.push(`    要点: ${turn.userKeyPoints.join('；')}`);
        lines.push(`    【你答】${turn.assistantSummary ?? '（未记录）'}`);
        if ((turn.corrections ?? []).length > 0) {
          lines.push(`    纠正: ${turn.corrections.map((item) => item.text).join('；')}`);
        }
      }
      lines.push('');
    }
    return { text: lines.join('\n'), sessions };
  }

  /**
   * Search durable evidence and turn summaries.
   * @param options - `query` text and `limit`.
   * @returns the rendered text and matched rows.
   */
  async search(options = {}) {
    const query = typeof options.query === 'string' ? options.query.trim() : '';
    if (query === '') return { text: '请给出要检索的关键词。', matches: [] };
    const limit = Number.isFinite(options.limit) ? Math.min(Math.max(1, options.limit), 100) : 30;
    const needle = query.toLowerCase();
    const matches = [];
    for (const row of await this.store.readEvidence()) {
      const haystack = `${row.text ?? ''} ${row.source ?? ''} ${row.sessionId ?? ''}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      matches.push({ where: 'evidence', ...row });
    }
    for (const session of await this.store.listSessions()) {
      for (const turn of session.turns ?? []) {
        const haystack = [
          turn.userAsk ?? '',
          (turn.userKeyPoints ?? []).join(' '),
          turn.assistantSummary ?? '',
          (turn.corrections ?? []).map((item) => item.text).join(' '),
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) continue;
        matches.push({ where: 'turn', sessionId: session.sessionId, turn: turn.turn, text: turn.userAsk, at: turn.at });
      }
    }
    const capped = matches.slice(-limit);
    if (capped.length === 0) return { text: `没有找到与「${query}」相关的记录。`, matches: [] };
    const lines = [`与「${query}」相关的记录 ${capped.length} 条：`, ''];
    for (const match of capped) {
      const when = formatTime(match.at);
      if (match.where === 'evidence') {
        lines.push(`- [画像证据/${match.dimension ?? '-'}/${match.confidence ?? '-'}] ${match.text} （${match.sessionId ?? '-'}${match.turn === undefined ? '' : `#T${match.turn}`}, ${when}）`);
      } else {
        lines.push(`- [逐轮记录/${match.sessionId}#T${match.turn}] ${match.text ?? ''} （${when}）`);
      }
      if (typeof match.source === 'string' && match.source !== '') lines.push(`    原文: ${match.source}`);
    }
    return { text: lines.join('\n'), matches: capped };
  }

  /**
   * Apply a manual correction. Manual edits are authoritative by contract: a
   * note records the reason and shields the entry from later model rewrites.
   * @param request - the correction to apply.
   * @returns a status document.
   */
  async update(request) {
    const action = typeof request.action === 'string' ? request.action : '';
    if (action === 'setEntryCap') return await this.setEntryCap(request);
    if (action === 'setSessionMode') return await this.setSessionMode(request);
    if (action === 'clearBlacklist') return await this.clearBlacklist();
    if (action === 'addEntry') {
      const dimension = resolveDimensionId(request.dimension);
      if (dimension === undefined) return { ok: false, error: 'dimension 无效' };
      const text = typeof request.text === 'string' ? request.text.trim() : '';
      if (text === '') return { ok: false, error: 'text 不能为空' };
      const charLimit = await this.#charLimit();
      const now = Date.now();
      await this.store.updateProfile((profile) => {
        const list = profile.dimensions[dimension] ?? (profile.dimensions[dimension] = []);
        list.push({
          text: text.slice(0, charLimit),
          // A hand-written entry is the user stating something about themselves,
          // so it is a `user` statement at the top confidence — and `manual`
          // shields it from later model rewrites entirely.
          statement: 'user',
          confidence: request.confidence === 'low' || request.confidence === 'medium' ? request.confidence : 'high',
          status: 'active',
          sources: [],
          note: typeof request.note === 'string' ? request.note.slice(0, 300) : undefined,
          manual: true,
          firstSeenAt: now,
          lastConfirmedAt: now,
        });
      });
      return { ok: true, action };
    }
    if (action === 'addNote') {
      const text = typeof request.text === 'string' ? request.text.trim() : '';
      if (text === '') return { ok: false, error: 'text 不能为空' };
      await this.store.updateProfile((profile) => {
        profile.notes.push({ text: text.slice(0, 500), at: Date.now() });
      });
      return { ok: true, action };
    }
    if (action === 'removeNote') {
      await this.store.updateProfile((profile) => {
        profile.notes = profile.notes.filter((note) => note.at !== request.at);
      });
      return { ok: true, action };
    }
    if (action === 'updateEntry' || action === 'setStatus' || action === 'setConfidence' || action === 'removeEntry') {
      let touched = false;
      let touchedId = '';
      // Read once, outside the mutation: the editable text limit is user-configurable.
      const charLimitForEdit = await this.#charLimit();
      await this.store.updateProfile((profile) => {
        for (const id of DIMENSION_IDS) {
          const list = profile.dimensions[id] ?? [];
          const index = findEntryIndex(id, list, request);
          if (index === -1) continue;
          touched = true;
          // Re-stamp with the stable id (migrating a row written by an older
          // build), so the panel's next snapshot and this entry agree.
          list[index] = { ...list[index], id: entryId(id, list[index]) };
          touchedId = list[index].id;
          const entry = list[index];
          if (action === 'removeEntry') {
            // "Delete" from the panel means "move it to the 废弃 area", not "erase
            // it": the conclusion leaves the dimension and stays restorable.
            // Dropping the row would lose the evidence trail and make the user's
            // own action irreversible.
            entry.status = 'retired';
            entry.deletedAt = Date.now();
            entry.manual = true;
            entry.lastConfirmedAt = Date.now();
            continue;
          }
          if (typeof request.text === 'string' && request.text.trim() !== '') {
            // Same adjustable limit as the model's conclusions, read before the mutation.
            entry.text = request.text.trim().slice(0, charLimitForEdit);
          }
          if (typeof request.note === 'string') entry.note = request.note.trim().slice(0, 300);
          if (request.status === 'active' || request.status === 'superseded' || request.status === 'retired') {
            entry.status = request.status;
            // Restoring clears the delete mark, so the row becomes a normal active
            // conclusion again instead of a half-retired one.
            if (request.status === 'active') delete entry.deletedAt;
          }
          if (request.confidence === 'low' || request.confidence === 'medium' || request.confidence === 'high') {
            // Setting confidence by hand is the user's own judgement, so the
            // statement policy no longer applies to this row (it is `manual`).
            entry.confidence = request.confidence;
          }
          entry.manual = true;
          entry.lastConfirmedAt = Date.now();
        }
      });
      // A conclusion that just left the active set contributes its evidence to the
      // blacklist; restoring it takes those keys out again. Reconciling here (rather
      // than waiting for the next synthesis) makes retire/restore feel immediate.
      await this.syncBlacklist();
      return touched ? { ok: true, action, id: touchedId } : { ok: false, error: `没有找到 id 为 ${request.id} 的条目` };
    }
    if (action === 'purgeEntry') {
      // Only the 废弃 area reaches this: delete the conclusion for good, together
      // with the evidence that exists for it alone. It is irreversible by design,
      // so the panel asks twice before sending it.
      return await this.purgeEntry(request);
    }
    if (action === 'clearDiscard') {
      // One click empties the holding pen: every non-active conclusion is deleted
      // for good, with its own evidence. The panel asks twice before sending it.
      return await this.clearDiscard();
    }
    return { ok: false, error: `未知 action: ${action}` };
  }

  /**
   * Permanently remove one entry and the evidence that only it used.
   *
   * Evidence is shared: several conclusions can quote the same turn. A row is
   * removed only when no OTHER conclusion still points at its turn, and when the
   * row actually supports the entry being deleted — otherwise the neighbouring
   * conclusions would lose their provenance as a side effect.
   *
   * Every purge writes one line to `deleted.log` (text, basis, sources, counts) so
   * an irreversible action still leaves a readable trace. The log is not a backup:
   * nothing reads it back into the profile.
   *
   * @param request - `id` plus the optional `matchText` fallback.
   * @returns the status document.
   */
  async purgeEntry(request) {
    const profile = await this.store.profile(true);
    let target;
    let dimensionId;
    for (const id of DIMENSION_IDS) {
      const list = profile.dimensions?.[id] ?? [];
      const index = findEntryIndex(id, list, request);
      if (index === -1) continue;
      target = list[index];
      dimensionId = id;
      break;
    }
    if (target === undefined) return { ok: false, error: `没有找到 id 为 ${request.id} 的条目` };

    const keyOf = (source) => `${source?.sessionId ?? ''}#${source?.turn ?? ''}`;
    const targetKeys = new Set((target.sources ?? []).map(keyOf));
    // Turns another conclusion still cites are off limits.
    const sharedKeys = new Set();
    const others = [];
    for (const id of DIMENSION_IDS) {
      for (const entry of profile.dimensions?.[id] ?? []) {
        if (entry === target) continue;
        others.push(entry);
        for (const source of entry.sources ?? []) {
          const key = keyOf(source);
          if (targetKeys.has(key)) sharedKeys.add(key);
        }
      }
    }
    const removableKeys = new Set([...targetKeys].filter((key) => !sharedKeys.has(key)));
    // A hand-written conclusion carries no `sources`, so turn matching cannot find
    // its evidence. Fall back to text: the rows it is made of, minus any row another
    // conclusion still claims.
    const byTurn = targetKeys.size > 0;

    const rows = await this.store.readEvidence();
    const kept = [];
    const removedKeys = [];
    // Turns this conclusion is made of. Even when no row is removed (the ledger was
    // already compacted, or the model reworded it), the turn is still pinned: a later
    // re-digest must not resurrect the conclusion. Turns cited by an active
    // conclusion are exempt, so deleting one conclusion cannot gut another.
    const targetTurns = new Set([...targetKeys]);
    if (!byTurn) {
      for (const row of rows) {
        if (rowSupportsEntry(row, target.text) && !others.some((other) => rowSupportsEntry(row, other.text))) {
          targetTurns.add(keyOf(row));
        }
      }
    }
    const activeTurns = new Set();
    for (const other of others) {
      if (other.status !== 'active') continue;
      for (const source of other.sources ?? []) activeTurns.add(keyOf(source));
    }
    const pinnedTurns = [...targetTurns].filter((key) => !activeTurns.has(key));

    for (const row of rows) {
      const supported = rowSupportsEntry(row, target.text);
      const removable = byTurn
        ? removableKeys.has(keyOf(row)) && supported
        : supported && !others.some((other) => rowSupportsEntry(row, other.text));
      if (!removable) {
        kept.push(row);
        continue;
      }
      removedKeys.push(evidenceKey(row));
    }
    if (removedKeys.length > 0) await this.store.writeEvidence(kept);
    {
      // Pinning is what makes a permanent delete permanent: these rows and turns
      // never come back into extraction, whatever the profile later says.
      const blacklist = await this.store.readBlacklist();
      await this.store.writeBlacklist({
        keys: [...blacklist.keys, ...removedKeys],
        turns: [...blacklist.turns, ...pinnedTurns],
        pinnedKeys: [...blacklist.pinnedKeys, ...removedKeys],
        pinnedTurns: [...blacklist.pinnedTurns, ...pinnedTurns],
      });
    }

    await this.store.updateProfile((current) => {
      for (const id of DIMENSION_IDS) {
        const list = current.dimensions?.[id] ?? [];
        const index = list.findIndex((entry) => entryId(id, entry) === entryId(dimensionId, target));
        if (index === -1) continue;
        list.splice(index, 1);
      }
    });

    const record = {
      at: Date.now(),
      action: 'purge',
      dimension: dimensionId,
      text: target.text,
      statement: target.statement ?? 'user',
      confidence: target.confidence,
      sources: target.sources ?? [],
      removedEvidence: removedKeys.length,
      sharedEvidenceKept: sharedKeys.size,
      blacklisted: removedKeys.length,
      blacklistedTurns: pinnedTurns.length,
    };
    await this.store.appendDeletedLog(record);
    this.log(
      `entry purged: ${dimensionId} ${JSON.stringify(target.text).slice(0, 40)} ` +
        `(${removedKeys.length} evidence row(s) removed and blacklisted, ${sharedKeys.size} shared turn(s) kept)`,
    );
    return {
      ok: true,
      action: 'purgeEntry',
      removedEvidence: removedKeys.length,
      sharedEvidence: sharedKeys.size,
      blacklisted: removedKeys.length,
      blacklistedTurns: pinnedTurns.length,
    };
  }

  /**
   * The configured per-conclusion character limit.
   * @returns the clamped limit.
   */
  async #charLimit() {
    const state = await this.store.readState();
    return clampCharLimit(state?.entryCap?.charLimit, DEFAULT_ENTRY_CAP.charLimit);
  }

  /**
   * Replace the conclusion budget.
   * @param request - `cap` document (`mode`, `total`, `daily`, `tech`, `charLimit`).
   * @returns the stored cap plus current usage.
   */
  async setEntryCap(request) {
    const cap = normalizeEntryCap(request?.cap ?? request);
    await this.store.updateState((state) => {
      state.entryCap = cap;
    });
    return { ok: true, action: 'setEntryCap', cap };
  }

  /**
   * Empty the evidence blacklist, so blacklisted rows may be extracted again.
   * @returns the new count.
   */
  async clearBlacklist() {
    // Only the pinned layer is the user's to drop. Keys derived from conclusions that
    // are still not active are recomputed from the profile immediately: clearing the
    // list must not quietly resurrect a retired conclusion's evidence.
    await this.store.writeBlacklist({ keys: [], turns: [], pinnedKeys: [], pinnedTurns: [] });
    const count = await this.syncBlacklist();
    return { ok: true, action: 'clearBlacklist', count };
  }

  /**
   * Recompute the blacklist from the current portrait.
   *
   * Pinned keys and pinned turns (from permanent deletes and timeline compactions)
   * always survive. Everything else is derived: evidence and turns belonging to a
   * conclusion that is not active are silenced, and restoring that conclusion removes
   * them again. Anything an active conclusion still cites is never silenced.
   *
   * @returns the effective row-key count after reconciliation.
   */
  async syncBlacklist() {
    const profile = await this.store.profile();
    const rows = await this.store.readEvidence();
    const current = await this.store.readBlacklist();
    const desired = blacklistForProfile(profile, rows, current.pinnedKeys, current.pinnedTurns);
    const sorted = (list) => [...list].sort();
    const same =
      desired.keys.length === current.keys.length &&
      desired.turns.length === current.turns.length &&
      desired.keys.every((key, index) => key === sorted(current.keys)[index]) &&
      desired.turns.every((key, index) => key === sorted(current.turns)[index]);
    if (!same) await this.store.writeBlacklist(desired);
    return desired.keys.length;
  }

  /**
   * Physically delete every conclusion in the 废弃 area.
   *
   * Each row is purged through the same path as a single delete, so evidence is
   * removed and pinned, the audit log gets one line per conclusion, and the
   * blacklist stays consistent.
   *
   * @returns how many conclusions were removed.
   */
  async clearDiscard() {
    const profile = await this.store.profile(true);
    const targets = [];
    for (const id of DIMENSION_IDS) {
      for (const entry of profile.dimensions?.[id] ?? []) {
        if (entry?.status === 'active') continue;
        targets.push({ dimension: id, id: entryId(id, entry), text: entry.text });
      }
    }
    let removed = 0;
    for (const target of targets) {
      const result = await this.purgeEntry({ id: target.id, matchText: target.text });
      if (result.ok === true) removed += 1;
    }
    await this.syncBlacklist();
    this.log(`discard cleared: ${removed}/${targets.length} non-active conclusion(s) deleted for good`);
    return { ok: true, action: 'clearDiscard', removed, total: targets.length };
  }

  /**
   * Store one browser-half self-report.
   * @param report - the client's diagnostics payload.
   * @returns the stored document.
   */
  async report(report) {
    return this.store.writeClientReport(report);
  }

  /**
   * Read the browser half's stored self-reports.
   * @returns the stored document plus the data directory it landed in.
   */
  async reportView() {
    const document = await this.store.readClientReport();
    return { dataDir: this.store.paths.root, ...document };
  }

  /**
   * Trigger a background job.
   * @param action - `backfill`, `synthesizeNow`, or `redigest`.
   * @returns a status document.
   */
  async maintain(action) {
    if (action === 'backfill' || action === 'redigest') {
      const plan = await this.engine.startBackfill({ force: action === 'redigest' });
      return { ok: true, action, plan };
    }
    if (action === 'synthesizeNow') {
      const report = await this.engine.synthesize('manual');
      return report === undefined
        ? { ok: false, error: '证据不足或模型返回不可解析，本次未合并' }
        : { ok: true, action, report };
    }
    if (action === 'timelinePlan') {
      // Preview only: counts what a compaction would remove, writes nothing.
      return { ok: true, action, stats: (await this.#timelinePlan()).stats };
    }
    if (action === 'compactTimeline') {
      return await this.compactTimeline();
    }
    return { ok: false, error: `未知 action: ${action}` };
  }

  /**
   * Compute a timeline compaction plan against the current profile and ledger.
   * @returns `{ keep, remove, stats }`.
   */
  async #timelinePlan() {
    const profile = await this.store.profile();
    const rows = await this.store.readEvidence();
    return planTimelineCompaction(profile, rows, TIMELINE_ROWS_PER_TURN);
  }

  /**
   * Drop evidence the portrait does not use, after a preview.
   *
   * Backs the ledger up first (`evidence.jsonl.before-timeline-compaction`), writes
   * one audit line, then rewrites the ledger with the rows the plan keeps. Pinned
   * blacklist keys are untouched: deleting the row does not lift its silence.
   *
   * @returns the plan stats plus the backup path.
   */
  async compactTimeline() {
    const plan = await this.#timelinePlan();
    if (plan.remove.length === 0) {
      return { ok: true, action: 'compactTimeline', stats: plan.stats, removed: 0, backup: null };
    }
    const profile = await this.store.profile();
    // A compaction is a delete too: the rows it drops must be pinned, or the next
    // re-digest simply recreates them — that is exactly how the blacklist lost its
    // teeth before. A turn whose rows are all gone is pinned as a turn as well, so a
    // reworded re-extraction cannot slip past the row keys.
    const keptTurns = new Set(plan.keep.map((row) => turnKey(row)));
    const orphanTurns = [...new Set(plan.remove.map((row) => turnKey(row)))].filter((key) => !keptTurns.has(key));
    const activeTurns = new Set();
    for (const id of DIMENSION_IDS) {
      for (const entry of profile.dimensions?.[id] ?? []) {
        if (entry.status !== 'active') continue;
        for (const source of entry.sources ?? []) activeTurns.add(turnKey(source));
      }
    }
    const pinnedTurns = orphanTurns.filter((key) => !activeTurns.has(key));
    const removedKeys = plan.remove.map((row) => evidenceKey(row));
    const blacklist = await this.store.readBlacklist();
    await this.store.writeBlacklist({
      keys: [...blacklist.keys, ...removedKeys],
      turns: [...blacklist.turns, ...pinnedTurns],
      pinnedKeys: [...blacklist.pinnedKeys, ...removedKeys],
      pinnedTurns: [...blacklist.pinnedTurns, ...pinnedTurns],
    });
    const backup = await this.store.backupEvidence('before-timeline-compaction');
    await this.store.writeEvidence(plan.keep);
    await this.store.appendDeletedLog({
      at: Date.now(),
      action: 'compactTimeline',
      removed: plan.remove.length,
      kept: plan.keep.length,
      stats: plan.stats,
      blacklistedKeys: removedKeys.length,
      blacklistedTurns: pinnedTurns.length,
      backup,
    });
    this.log(
      `timeline compacted: ${plan.stats.removedRows} row(s) removed from ${plan.stats.removedTurns} unused turn(s), ` +
        `${plan.stats.keptRows} kept, ${pinnedTurns.length} turn(s) pinned (backup: ${backup})`,
    );
    return { ok: true, action: 'compactTimeline', stats: plan.stats, removed: plan.stats.removedRows, backup };
  }

  /**
   * A cheap version marker for the live profile.
   *
   * Used by the SSE handshake: the panel compares it with what it already shows to
   * decide whether an update was missed while it was disconnected.
   *
   * @returns the profile timestamp and active-entry count.
   */
  async version() {
    const profile = await this.store.profile();
    let entries = 0;
    for (const list of Object.values(profile?.dimensions ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) if (entry?.status === 'active') entries += 1;
    }
    return { updatedAt: profile?.updatedAt ?? 0, entries };
  }

  /**
   * The complete panel payload: profile, progress, and recent records.
   * @returns a JSON-serializable snapshot.
   */
  async snapshot() {
    const profile = await this.store.profile(true);
    const description = await this.engine.describe();
    const sessions = (await this.store.listSessions()).slice(-20).reverse();
    const evidence = await this.store.readEvidence();
    const state = await this.store.readState();
    const blacklist = await this.store.readBlacklist();
    const caps = normalizeEntryCap(state.entryCap);
    return {
      ok: true,
      groups: DIMENSION_GROUPS,
      dimensions: DIMENSIONS,
      profile: decorateEntries(profile),
      progress: description,
      /** The conclusion budget plus how much of it is used right now. */
      caps: { ...caps, usage: countAgainstCaps(profile, caps) },
      /** Rows the user removed for good; extraction must not revive them. */
      blacklist: { count: blacklist.keys.length, turns: (blacklist.turns ?? []).length, updatedAt: blacklist.updatedAt },
      /** Where the 反馈与建议 button points; empty means "not configured yet". */
      feedbackUrl: typeof this.config?.feedbackUrl === 'string' ? this.config.feedbackUrl.trim() : '',
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        turnCount: session.turnCount,
        cwd: session.cwd,
        rollup: session.rollup ?? {},
        turns: (session.turns ?? []).slice(-6),
      })),
      evidence: evidence.slice(-80).reverse(),
      dataDir: this.store.paths.root,
      updatedAt: Date.now(),
    };
  }
}

/**
 * Count active conclusions against the budget.
 *
 * Manual conclusions are the user's own words, so they are reported separately and
 * never count toward the cap.
 *
 * @param profile - the profile document.
 * @param caps - the normalized cap document.
 * @returns `{ total, daily, tech, manual }` counts.
 */
function countAgainstCaps(profile, caps) {
  const counts = { total: 0, daily: 0, tech: 0, manual: 0 };
  for (const id of DIMENSION_IDS) {
    for (const entry of profile?.dimensions?.[id] ?? []) {
      if (entry?.status !== 'active') continue;
      if (entry.manual === true) {
        counts.manual += 1;
        continue;
      }
      counts.total += 1;
      counts[groupOfDimension(id)] += 1;
    }
  }
  return counts;
}

/**
 * Attach a stable id to every entry so the panel can address one row.
 * @param profile - the profile document.
 * @returns a copy with entry ids.
 */
function decorateEntries(profile) {
  const safe = normalizeProfile(profile);
  const dimensions = {};
  for (const id of DIMENSION_IDS) {
    dimensions[id] = (safe.dimensions[id] ?? []).map((entry) => ({
      ...entry,
      // Derived from the text, so it survives a background merge that reorders or
      // grows the list — an id the panel is holding keeps pointing at its entry.
      id: entryId(id, entry),
    }));
  }
  return { ...safe, dimensions };
}

/**
 * Address one entry by id, tolerating an id captured before a merge.
 *
 * A stale id is not necessarily a wrong request: the panel renders a snapshot,
 * synthesis runs in the background and can merge or reorder entries, and the row
 * the user clicked may still exist under a different id. Two things make that
 * recoverable:
 *
 * - The stored id may be a POSITIONAL one written by an older build
 *   (`dimension:index:firstSeenAt`). Those are never compared against; the
 *   text-derived id is computed on the spot, which is stable regardless of what
 *   the file happens to carry.
 * - When the id still misses, the row's own text (sent by the panel) is the
 *   second authority.
 *
 * @param dimensionId - the dimension being searched.
 * @param list - its entries.
 * @param request - the update request (`id`, optionally `matchText`).
 * @returns the index of the addressed entry, or -1.
 */
function findEntryIndex(dimensionId, list, request) {
  const wanted = typeof request.id === 'string' ? request.id : '';
  const direct = list.findIndex((entry) => entryId(dimensionId, entry) === wanted || entry.id === wanted);
  if (direct !== -1) return direct;
  const byText = typeof request.matchText === 'string' ? request.matchText.trim() : '';
  if (byText === '') return -1;
  return list.findIndex((entry) => entry.text === byText);
}

/**
 * Route one HTTP request to the portrait operations.
 *
 * Read requests carry a `view` query parameter, mutations carry a JSON body
 * with an `action`. The panel and the agent tools therefore share exactly one
 * implementation per operation.
 */
export class PortraitHttp {
  /**
   * @param ops - the bound operations.
   */
  constructor(ops, options = {}) {
    this.ops = ops;
    /**
     * Optional emitter carrying `profile` events.
     *
     * When present, `?view=stream` keeps an SSE connection open and forwards one
     * event per profile write, so the panel never has to poll. Without it the route
     * simply reports that streaming is unavailable and the panel stays silent.
     */
    this.events = options.events;
  }

  /**
   * Handle one request.
   * @param req - the incoming request.
   * @param res - the response to write.
   */
  async handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET') {
        if (url.searchParams.get('view') === 'stream') {
          await this.#stream(req, res);
          return;
        }
        const payload = await this.#read(url.searchParams);
        sendJson(res, 200, payload);
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const action = body?.action;
        if (action === 'update') {
          // The panel sends the operation in `op`; the tool path sends it as `action`.
          const request = { ...body, action: body.op ?? body.sub ?? body.operation };
          sendJson(res, 200, await this.ops.update(request));
          return;
        }
        if (action === 'maintain') {
          sendJson(res, 200, await this.ops.maintain(body.op));
          return;
        }
        if (action === 'search') {
          const result = await this.ops.search({ query: body.query, limit: body.limit });
          sendJson(res, 200, { ok: true, text: result.text, matches: result.matches });
          return;
        }
        if (action === 'history') {
          const result = await this.ops.history({ sessionId: body.sessionId, limit: body.limit });
          sendJson(res, 200, { ok: true, text: result.text, sessions: result.sessions });
          return;
        }
        if (action === 'report') {
          // The browser half's self-report. It is the only channel that survives
          // the slot service isolating a failed pane, so a blank panel can still
          // leave a trace.
          const report = body.report !== null && typeof body.report === 'object' ? body.report : undefined;
          if (report === undefined || Array.isArray(report)) {
            sendJson(res, 400, { ok: false, error: 'report 缺失或不是对象' });
            return;
          }
          const text = JSON.stringify(report);
          if (text.length > 16000) {
            sendJson(res, 400, { ok: false, error: 'report 过大' });
            return;
          }
          const document = await this.ops.report(JSON.parse(text));
          sendJson(res, 200, { ok: true, stored: document.reports.length });
          return;
        }
        sendJson(res, 400, { ok: false, error: `未知 action: ${String(action)}` });
        return;
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Keep an SSE connection open and push one event per profile write.
   *
   * This is what replaces the panel's polling loop: the browser holds a stream, the
   * Host writes only when something changed, and quiet periods cost nothing. The
   * hello event carries the current version so a reconnecting panel can tell
   * whether it missed an update.
   *
   * @param req - the streaming request.
   * @param res - the response to hold open.
   * @returns nothing once the stream is set up.
   */
  async #stream(req, res) {
    if (this.events === undefined || typeof this.events.on !== 'function') {
      sendJson(res, 503, { ok: false, error: 'stream unavailable' });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    const send = (event, data) => {
      if (closed) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        closed = true;
      }
    };
    const version = await this.ops.version().catch(() => undefined);
    send('hello', version ?? { updatedAt: 0 });
    const onProfile = (info) => send('profile', info ?? { updatedAt: Date.now() });
    // Keeps intermediaries from dropping an idle stream. It carries no data, so the
    // panel still renders nothing until a real profile write arrives.
    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write(': keep-alive\n\n');
      } catch {
        closed = true;
      }
    }, 30000);
    heartbeat.unref?.();
    this.events.on('profile', onProfile);
    const cleanup = () => {
      closed = true;
      clearInterval(heartbeat);
      this.events.off?.('profile', onProfile);
    };
    req.on?.('close', cleanup);
    req.on?.('aborted', cleanup);
    res.on?.('close', cleanup);
  }

  async #read(params) {
    const view = param(params, 'view') ?? 'snapshot';
    if (view === 'snapshot') return this.ops.snapshot();
    if (view === 'sessionMode') {
      // The composer's portrait switch reads the mode for one session.
      return { ok: true, mode: await this.ops.sessionMode(param(params, 'session')) };
    }
    if (view === 'report') {
      return { ok: true, ...(await this.ops.reportView()) };
    }
    if (view === 'profile') {
      const result = await this.ops.read({
        dimension: param(params, 'dimension'),
        includeRetired: param(params, 'includeRetired') === 'true',
      });
      return { ok: true, text: result.text, profile: decorateEntries(result.profile) };
    }
    if (view === 'history') {
      const result = await this.ops.history({
        sessionId: param(params, 'sessionId'),
        limit: Number(param(params, 'limit') ?? 10),
      });
      return { ok: true, text: result.text, sessions: result.sessions };
    }
    if (view === 'search') {
      const result = await this.ops.search({ query: param(params, 'q'), limit: Number(param(params, 'limit') ?? 30) });
      return { ok: true, text: result.text, matches: result.matches };
    }
    return { ok: false, error: `未知 view: ${view}` };
  }
}

/**
 * Write a JSON response.
 * @param res - the response to write.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

/**
 * Read a small JSON request body.
 * @param req - the incoming request.
 * @returns the parsed body, or undefined.
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 262144) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * An empty profile, exported so callers need not import the schema module.
 * @returns a fresh profile document.
 */
export function blankProfile() {
  return emptyProfile();
}











