/**
 * Durable portrait storage: atomic JSON writes, append-only evidence ledger,
 * per-session digests, and the pending-work state file.
 *
 * All writes go through one promise chain so concurrent background jobs cannot
 * interleave a read-modify-write on the same file.
 *
 * @module dsh-user-portrait/store
 */

import { appendFile, copyFile, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { createProfile, DIMENSION_GROUPS, DIMENSIONS, evidenceKey, normalizeProfile } from './schema.js';
import { buildDerivedRollup } from './extract.js';

const LEDGER_MAX_ROWS = 20000;

/**
 * One serialized store over a resolved directory layout.
 */
export class PortraitStore {
  #paths;
  #chain = Promise.resolve();
  #profile = undefined;
  #ledgerCount = undefined;

  /**
   * @param paths - layout from `layout(dataDir)`.
   */
  constructor(paths) {
    this.#paths = paths;
    /**
     * Notified after every profile write.
     *
     * The panel used to poll the whole snapshot every 20 seconds just to notice a
     * change. This hook lets the Host push the new state instead, so the panel can
     * stay completely silent until something is actually written.
     */
    this.onProfileSaved = undefined;
  }

  /** The resolved directory layout. */
  get paths() {
    return this.#paths;
  }

  /**
   * Run one exclusive read-modify-write against the store.
   * @param operation - receives nothing, returns the operation's value.
   * @returns the operation's value.
   */
  #exclusive(operation) {
    const run = this.#chain.then(operation, operation);
    // Keep the chain alive after a rejection so later writes still run.
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Read the cached profile, loading it from disk once per process.
   * @param force - re-read from disk even when cached.
   * @returns the normalized profile document.
   */
  async profile(force = false) {
    if (!force && this.#profile !== undefined) return this.#profile;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.#paths.profile, 'utf8'));
    } catch {
      parsed = undefined;
    }
    this.#profile = normalizeProfile(parsed);
    return this.#profile;
  }

  /**
   * Read the already-loaded profile without any I/O.
   *
   * The prompt registry calls a section's text provider synchronously, so a
   * caller that needs the profile during prompt assembly must use this instead
   * of awaiting `profile()`. The cache is refreshed by every load and save.
   *
   * @returns the cached profile, or undefined before the first load.
   */
  cachedProfile() {
    return this.#profile;
  }

  /**
   * Persist the profile and regenerate its human-readable Markdown twin.
   * @param profile - the document to write.
   */
  async saveProfile(profile) {
    profile.updatedAt = Date.now();
    this.#profile = profile;
    await atomicWrite(this.#paths.profile, `${JSON.stringify(profile, null, 2)}\n`);
    await atomicWrite(this.#paths.profileMarkdown, renderProfileMarkdown(profile, DIMENSIONS));
    try {
      this.onProfileSaved?.(profile);
    } catch {
      // A listener that throws must never fail the write that already succeeded.
    }
    return profile;
  }

  /**
   * Apply one exclusive mutation to the profile and persist the result.
   * @param mutate - receives the loaded profile, returns nothing.
   * @returns the saved profile.
   */
  updateProfile(mutate) {
    return this.#exclusive(async () => {
      const profile = await this.profile(true);
      mutate(profile);
      return this.saveProfile(profile);
    });
  }

  /**
   * Append evidence rows, skipping keys already present in the ledger indices.
   * @param rows - evidence rows to record.
   * @returns the rows actually appended.
   */
  async appendEvidence(rows) {
    if (rows.length === 0) return [];
    const known = await this.ledgerKeys();
    const fresh = [];
    for (const row of rows) {
      const key = evidenceKey(row);
      if (known.has(key)) continue;
      known.add(key);
      fresh.push({ ...row, key });
    }
    if (fresh.length === 0) return [];
    const text = fresh.map((row) => JSON.stringify(row)).join('\n');
    await appendFile(this.#paths.evidence, `${text}\n`, 'utf8');
    this.#ledgerCount = undefined;
    await this.#compactLedgerIfNeeded();
    return fresh;
  }

  /**
   * Replace the evidence ledger without keeping a copy.
   *
   * Used by the purge path: deleting a conclusion also removes the evidence that
   * only it used. That removal is recorded in `deleted.log`, which is the audit
   * trail — not a restore point.
   *
   * @param rows - the complete new ledger.
   * @returns the number of rows written.
   */
  async writeEvidence(rows) {
    return this.#exclusive(async () => {
      const body = rows.map((row) => JSON.stringify(row)).join('\n');
      await atomicWrite(this.#paths.evidence, body === '' ? '' : `${body}\n`);
      this.#ledgerCount = rows.length;
      return rows.length;
    });
  }

  /**
   * Copy the evidence ledger beside itself before a destructive rewrite.
   * @param label - suffix identifying the operation.
   * @returns the backup path.
   */
  async backupEvidence(label) {
    const target = `${this.#paths.evidence}.${label}`;
    await copyFile(this.#paths.evidence, target).catch(() => undefined);
    return target;
  }

  /**
   * Append one line to the deletion audit log.
   * @param record - what was deleted and what it cost.
   * @returns the record written.
   */
  async appendDeletedLog(record) {
    await appendFile(this.#paths.deletedLog, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  /**
   * Replace the evidence ledger wholesale.
   *
   * Only the one-time basis migration uses this, and it is genuinely destructive:
   * the previous file is copied beside the ledger first (`*.before-basis-migration`)
   * so the rewrite can be inspected or reverted by hand.
   *
   * @param rows - the complete new ledger.
   * @returns the number of rows written.
   */
  async rewriteEvidence(rows) {
    return this.#exclusive(async () => {
      await copyFile(this.#paths.evidence, `${this.#paths.evidence}.before-basis-migration`).catch(() => undefined);
      const body = rows.map((row) => JSON.stringify(row)).join('\n');
      await atomicWrite(this.#paths.evidence, body === '' ? '' : `${body}\n`);
      this.#ledgerCount = rows.length;
      return rows.length;
    });
  }

  /**
   * Every evidence key currently on disk.
   * @returns the key set.
   */
  async ledgerKeys() {
    const keys = new Set();
    for (const row of await this.readEvidence()) keys.add(row.key ?? evidenceKey(row));
    return keys;
  }

  /**
   * Read the evidence ledger, newest row last.
   * @param limit - maximum rows to return, counted from the end of the ledger.
   * @returns evidence rows.
   */
  async readEvidence(limit = 0) {
    let text;
    try {
      text = await readFile(this.#paths.evidence, 'utf8');
    } catch {
      return [];
    }
    const rows = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        // A torn final line from an interrupted write is simply skipped.
      }
    }
    if (limit > 0 && rows.length > limit) return rows.slice(rows.length - limit);
    return rows;
  }

  /** Keep the append-only ledger bounded without losing its newest rows. */
  async #compactLedgerIfNeeded() {
    if (this.#ledgerCount === undefined) {
      this.#ledgerCount = (await this.readEvidence()).length;
      if (this.#ledgerCount <= LEDGER_MAX_ROWS) return;
    }
    if (this.#ledgerCount <= LEDGER_MAX_ROWS) return;
    const rows = await this.readEvidence();
    const kept = rows.slice(rows.length - Math.floor(LEDGER_MAX_ROWS / 2));
    await atomicWrite(this.#paths.evidence, `${kept.map((row) => JSON.stringify(row)).join('\n')}\n`);
    this.#ledgerCount = kept.length;
  }

  /**
   * Read one session digest.
   * @param sessionId - session identity.
   * @returns the digest, or undefined when this session was never digested.
   */
  async readSession(sessionId) {
    try {
      return JSON.parse(await readFile(this.sessionPath(sessionId), 'utf8'));
    } catch {
      return undefined;
    }
  }

  /**
   * Write one session digest plus its Markdown view.
   * @param digest - the digest document.
   */
  async writeSession(digest) {
    digest.updatedAt = Date.now();
    await atomicWrite(this.sessionPath(digest.sessionId), `${JSON.stringify(digest, null, 2)}\n`);
    await atomicWrite(join(this.#paths.views, `${safeId(digest.sessionId)}.md`), renderSessionMarkdown(digest));
  }

  /**
   * Every session digest currently stored, most recently updated last.
   * @returns digest documents.
   */
  async listSessions() {
    let names;
    try {
      names = await readdir(this.#paths.sessions);
    } catch {
      return [];
    }
    const digests = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        digests.push(JSON.parse(await readFile(join(this.#paths.sessions, name), 'utf8')));
      } catch {
        // A digest that cannot be parsed is treated as absent.
      }
    }
    digests.sort((left, right) => (left.updatedAt ?? 0) - (right.updatedAt ?? 0));
    return digests;
  }

  /**
   * Append one turn digest line for a session.
   * @param sessionId - session identity.
   * @param turn - the turn digest row.
   */
  async appendTurn(sessionId, turn) {
    const path = join(this.#paths.turns, `${safeId(sessionId)}.jsonl`);
    await appendFile(path, `${JSON.stringify(turn)}\n`, 'utf8');
  }

  /**
   * Merge one freshly digested turn into its session document.
   *
   * The turn list is the session's own record of what was asked and answered,
   * so it is rebuilt from the per-turn file rather than from the caller.
   *
   * @param request - session identity and header metadata.
   * @param digest - the normalized turn digest that was just recorded.
   */
  async updateSessionFromTurn(request, digest) {
    const turns = await this.readTurns(request.sessionId);
    const existing = await this.readSession(request.sessionId);
    const list = dedupeTurns(turns);
    await this.writeSession({
      sessionId: request.sessionId,
      createdAt: existing?.createdAt ?? request.header?.createdAt ?? digest.at,
      cwd: existing?.cwd ?? request.header?.cwd,
      turnCount: list.length,
      rollup: existing?.rollup ?? buildDerivedRollup(list),
      turns: list,
    });
  }

  /**
   * Replace one session's roll-up, preserving its recorded turns.
   * @param sessionId - session identity.
   * @param rollup - the roll-up to store.
   * @returns true when a session record was updated.
   */
  async updateSessionRollup(sessionId, rollup) {
    const existing = await this.readSession(sessionId);
    if (existing === undefined) return false;
    await this.writeSession({ ...existing, rollup });
    return true;
  }

  /**
   * Read recorded turn digests for one session.
   * @param sessionId - session identity.
   * @param limit - maximum rows counted from the end; 0 returns all.
   * @returns turn rows in ascending turn order.
   */
  async readTurns(sessionId, limit = 0) {
    let text;
    try {
      text = await readFile(join(this.#paths.turns, `${safeId(sessionId)}.jsonl`), 'utf8');
    } catch {
      return [];
    }
    const rows = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        // Skip torn lines.
      }
    }
    return limit > 0 && rows.length > limit ? rows.slice(rows.length - limit) : rows;
  }

  /**
   * Read the background-work state file.
   * @returns the state document.
   */
  async readState() {
    try {
      const parsed = JSON.parse(await readFile(this.#paths.state, 'utf8'));
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch {
      // Fall through to a fresh state document.
    }
    return { processedSessions: [], backfill: null };
  }

  /**
   * Read the blacklist.
   *
   * Two layers: `pinned` keys came from permanently deleted conclusions and are
   * never derived away; `keys` is the full blacklist (pinned plus rows supporting
   * conclusions that are currently not active).
   *
   * @returns `{ keys: string[], pinned: string[], updatedAt: number }`.
   */
  async readBlacklist() {
    try {
      const parsed = JSON.parse(await readFile(this.#paths.blacklist, 'utf8'));
      const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
      const keys = strings(parsed?.keys);
      // Older files only had `keys`; treat them as pinned so a reconcile never
      // resurrects rows a purge had deliberately silenced.
      const pinnedKeys = Array.isArray(parsed?.pinnedKeys)
        ? strings(parsed.pinnedKeys)
        : Array.isArray(parsed?.pinned)
          ? strings(parsed.pinned)
          : [...keys];
      return {
        keys,
        turns: strings(parsed?.turns),
        pinnedKeys,
        pinnedTurns: strings(parsed?.pinnedTurns),
        updatedAt: Number(parsed?.updatedAt) || 0,
      };
    } catch {
      return { keys: [], turns: [], pinnedKeys: [], pinnedTurns: [], updatedAt: 0 };
    }
  }

  /**
   * Replace the blacklist.
   *
   * Accepts either a full document or a bare key array (the older call shape).
   *
   * @param document - `{ keys, turns, pinnedKeys, pinnedTurns }` or a key array.
   * @param pinnedKeys - used only with the array shape.
   * @returns the stored document.
   */
  async writeBlacklist(document, pinnedKeys = []) {
    const source = Array.isArray(document)
      ? { keys: document, pinnedKeys }
      : document !== null && typeof document === 'object'
        ? document
        : {};
    const sorted = (value) => [...new Set(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [])].sort();
    const stored = {
      keys: sorted(source.keys),
      turns: sorted(source.turns),
      pinnedKeys: sorted(source.pinnedKeys),
      pinnedTurns: sorted(source.pinnedTurns),
      updatedAt: Date.now(),
    };
    await atomicWrite(this.#paths.blacklist, `${JSON.stringify(stored, null, 2)}\n`);
    return stored;
  }

  /**
   * Serialize a state mutation against every other store write.
   * @param mutate - receives the state document, returns nothing.
   */
  updateState(mutate) {
    return this.#exclusive(async () => {
      const state = await this.readState();
      mutate(state);
      await atomicWrite(this.#paths.state, `${JSON.stringify(state, null, 2)}\n`);
      return state;
    });
  }

  /**
   * Record what the browser half reported about itself.
   *
   * The panel runs in the renderer, where a failure is invisible from here: the
   * slot service isolates a throwing entry, so a blank pane leaves nothing in any
   * Host log. The client therefore posts its own registration facts and mount
   * results to this store, which keeps the last few reports on disk for
   * inspection.
   *
   * @param report - the client's self-report, already size-checked by the route.
   * @returns the stored document.
   */
  async writeClientReport(report) {
    return this.#exclusive(async () => {
      const entry = {
        at: Date.now(),
        ...report,
      };
      let previous = [];
      try {
        const parsed = JSON.parse(await readFile(this.#paths.clientReport, 'utf8'));
        if (Array.isArray(parsed?.reports)) previous = parsed.reports;
      } catch {
        // No report yet, or an unreadable one: start a fresh history.
      }
      const reports = [...previous, entry].slice(-10);
      const document = { updatedAt: entry.at, reports };
      await atomicWrite(this.#paths.clientReport, `${JSON.stringify(document, null, 2)}\n`);
      return document;
    });
  }

  /**
   * Read the recorded client self-reports.
   * @returns the stored document, or an empty history.
   */
  async readClientReport() {
    try {
      const parsed = JSON.parse(await readFile(this.#paths.clientReport, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.reports)) return parsed;
    } catch {
      // Fall through to an empty history.
    }
    return { updatedAt: 0, reports: [] };
  }

  /**
   * Resolve the digest path for a session.
   * @param sessionId - session identity.
   * @returns the absolute file path.
   */
  sessionPath(sessionId) {
    return join(this.#paths.sessions, `${safeId(sessionId)}.json`);
  }
}

/**
 * Make an arbitrary session id safe as a file name.
 * @param sessionId - raw session identity.
 * @returns a filesystem-safe stem.
 */export function safeId(sessionId) {
  const cleaned = String(sessionId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  if (cleaned === '') return createHash('sha1').update(String(sessionId)).digest('hex').slice(0, 16);
  return cleaned;
}

/**
 * Keep only the newest row per turn number, in ascending turn order.
 * @param turns - turn rows in append order.
 * @returns the deduplicated rows.
 */
export function dedupeTurns(turns) {
  const byTurn = new Map();
  for (const turn of turns) {
    if (turn === null || typeof turn !== 'object' || !Number.isFinite(turn.turn)) continue;
    byTurn.set(turn.turn, turn);
  }
  return [...byTurn.values()].sort((left, right) => left.turn - right.turn);
}

/**
 * Replace a file's contents atomically through a temporary sibling.
 * @param path - destination path.
 * @param content - complete new contents.
 */
export async function atomicWrite(path, content) {
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(temporary, content, 'utf8');
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Render one dimension entry as a Markdown bullet.
 * @param entry - portrait entry.
 * @returns a single Markdown line.
 */
function renderEntry(entry) {
  const sources = entry.sources ?? [];
  const where = sources.length > 0
    ? ` — 来源: ${sources.slice(0, 4).map((source) => `${source.sessionId}${source.turn === undefined ? '' : `#T${source.turn}`}`).join(', ')}${sources.length > 4 ? ` 等 ${sources.length} 处` : ''}`
    : '';
  const note = entry.note === undefined || entry.note === '' ? '' : `（${entry.note}）`;
  // The statement rides beside the confidence: a reader of the Markdown file must
  // be able to tell the user's own words from an inference drawn from the reply —
  // and when a conclusion merged both, it says so.
  const basis =
    entry.statement === 'assistant' ? '模型应答' : entry.statement === 'mixed' ? '用户的话 & 模型应答' : '用户的话';
  return `- ${entry.text}${note} · 依据 ${basis} · 置信度 ${entry.confidence} · 首次 ${formatTime(entry.firstSeenAt)} · 最近确认 ${formatTime(entry.lastConfirmedAt)}${where}`;
}

/**
 * Render the whole profile as Markdown.
 * @param profile - profile document.
 * @param dimensions - dimension catalog to title the sections.
 * @returns the Markdown document.
 */
export function renderProfileMarkdown(profile, dimensions) {
  const catalog = dimensions ?? [];
  const lines = [
    '# 人物画像',
    '',
    `- 更新时间: ${formatTime(profile.updatedAt)}`,
    `- 已提炼轮次: ${profile.synthesizedTurns}`,
    '',
  ];
  let currentGroup = '';
  for (const dimension of catalog) {
    if (dimension.group !== undefined && dimension.group !== currentGroup) {
      currentGroup = dimension.group;
      const group = DIMENSION_GROUPS.find((candidate) => candidate.id === dimension.group);
      if (group !== undefined) lines.push(`# ${group.label}`, '');
    }
    const entries = profile.dimensions?.[dimension.id] ?? [];
    lines.push(`## ${dimension.label}`, '');
    if (entries.length === 0) {
      lines.push('_暂无证据_', '');
      continue;
    }
    for (const entry of entries) {
      if (entry.status !== 'active') continue;
      lines.push(renderEntry(entry));
    }
    const retired = entries.filter((entry) => entry.status !== 'active');
    if (retired.length > 0) {
      lines.push('', `<details><summary>已废弃 / 已取代（${retired.length}）</summary>`, '');
      for (const entry of retired) lines.push(`- ~~${entry.text}~~ · ${entry.status} · ${entry.note ?? ''}`);
      lines.push('', '</details>');
    }
    lines.push('');
  }
  if ((profile.notes ?? []).length > 0) {
    lines.push('## 用户备注', '');
    for (const note of profile.notes) lines.push(`- [${formatTime(note.at)}] ${note.text}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Render one session digest as Markdown.
 * @param digest - session digest document.
 * @returns the Markdown document.
 */
export function renderSessionMarkdown(digest) {
  const lines = [
    `# 会话 ${digest.sessionId}`,
    '',
    `- 开始: ${formatTime(digest.createdAt)}`,
    `- 最近活动: ${formatTime(digest.updatedAt ?? digest.createdAt)}`,
    `- 轮次数: ${digest.turnCount ?? (digest.turns ?? []).length}`,
    digest.cwd === undefined ? '' : `- 工作目录: ${digest.cwd}`,
    '',
  ].filter((line) => line !== undefined);
  const turns = digest.turns ?? [];
  if (turns.length === 0) lines.push('_暂无逐轮摘要_', '');
  for (const turn of turns) {
    lines.push(`## 第 ${turn.turn} 轮 · ${formatTime(turn.at)}`, '');
    lines.push(`**我问的问题**: ${turn.userAsk ?? '（未记录）'}`, '');
    if ((turn.userKeyPoints ?? []).length > 0) {
      lines.push('**要点**');
      for (const point of turn.userKeyPoints) lines.push(`- ${point}`);
      lines.push('');
    }
    lines.push(`**你的回答**: ${turn.assistantSummary ?? '（未记录）'}`, '');
    if ((turn.corrections ?? []).length > 0) {
      lines.push('**我的纠正 / 偏好表达**');
      for (const correction of turn.corrections) lines.push(`- [${correction.kind ?? '偏好'}] ${correction.text}`);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Format an epoch millisecond reading for a human reader.
 * @param value - epoch milliseconds.
 * @returns a local timestamp, or `未知` when absent.
 */
export function formatTime(value) {
  if (!Number.isFinite(value)) return '未知';
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A brand-new in-memory profile, used before the first disk read completes.
 * @returns an empty profile document.
 */
export function emptyProfile() {
  return createProfile();
}


