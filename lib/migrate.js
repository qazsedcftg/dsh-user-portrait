/**
 * One-time repair of historical data written before the basis marker existed.
 *
 * Two things were wrong and only one of them is fixed by new code:
 *
 * 1. Ledger rows written before the marker carry no `statement`. Treating "no
 *    marker" as "the user's words" made every conclusion from history look like
 *    the user's own statement. This pass re-derives the basis from the evidence:
 *    the row's quote is looked up in the actual session transcript.
 * 2. Profile entries inherited that label. Once the ledger is corrected, entries
 *    are re-derived from their sources (`user` / `assistant` / `mixed`) and their
 *    confidence is re-clamped.
 *
 * It runs once per data directory, records itself in the state file, and keeps a
 * copy of the previous ledger beside it.
 *
 * @module dsh-user-portrait/migrate
 */

import { readFile } from 'node:fs/promises';

import { classifyEvidenceBasis, foldTurns, repairProfileBasis } from './extract.js';

/** Bumped when the repair itself changes in a way that must run again. */
export const EVIDENCE_BASIS_VERSION = 2;

/** Bumped when the blacklist turn-backfill changes. */
export const BLACKLIST_BACKFILL_VERSION = 1;

/**
 * Rebuild the turn half of the blacklist from the deletion audit log.
 *
 * Before turn keys existed, a permanent delete only pinned the rows it managed to
 * remove. If the ledger had already been compacted (or the model had reworded the
 * evidence), that removed nothing and pinned nothing — which is why a discard area
 * full of deleted conclusions left a blacklist with almost no entries and why a
 * re-digest brought them all back.
 *
 * `deleted.log` still records every purge with its `sources`, so the turns those
 * conclusions came from can be pinned now. This is deliberately one-shot.
 *
 * @param options - store and logger.
 * @returns `{ skipped, turns, records }`.
 */
export async function backfillBlacklistTurns(options) {
  const { store, log } = options;
  const force = options.force === true;
  const state = await store.readState();
  if (!force && Number(state.blacklistTurnBackfillVersion ?? 0) >= BLACKLIST_BACKFILL_VERSION) {
    return { skipped: true, turns: 0, records: 0 };
  }
  let lines = [];
  try {
    lines = (await readFile(store.paths.deletedLog, 'utf8')).split('\n').filter((line) => line.trim() !== '');
  } catch {
    lines = [];
  }
  const turns = new Set();
  let records = 0;
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.action !== 'purge') continue;
    records += 1;
    for (const source of record.sources ?? []) {
      if (source?.sessionId === undefined || source?.turn === undefined) continue;
      turns.add(`${source.sessionId}#${source.turn}`);
    }
  }
  const blacklist = await store.readBlacklist();
  await store.writeBlacklist({
    keys: blacklist.keys,
    turns: [...blacklist.turns, ...turns],
    pinnedKeys: blacklist.pinnedKeys,
    pinnedTurns: [...blacklist.pinnedTurns, ...turns],
  });
  await store.updateState((next) => {
    next.blacklistTurnBackfillVersion = BLACKLIST_BACKFILL_VERSION;
    next.blacklistTurnBackfillAt = Date.now();
    next.blacklistTurnBackfill = { records, turns: turns.size };
  });
  if (log !== undefined) log(`blacklist backfill: ${records} purge record(s) -> ${turns.size} pinned turn(s)`);
  return { skipped: false, turns: turns.size, records };
}

/** Human-readable turn text, normalized once per turn. */
function indexTurns(sessionId, events) {
  const map = new Map();
  let turns;
  try {
    turns = foldTurns(events);
  } catch {
    return map;
  }
  for (const turn of turns) {
    const lines = (turn.userTexts ?? []).map((text) => String(text ?? '').trim()).filter((text) => text !== '');
    const normalized = lines
      .join('\n')
      .toLowerCase()
      .replace(/[\s，。、；：！？,.;:!?“”"'（）()《》〈〉【】\[\]—\-…·|/\\]+/gu, '');
    map.set(`${sessionId}#${turn.turn}`, { normalized, lines });
  }
  return map;
}

/**
 * Run the repair when this data directory has not had it yet.
 *
 * @param options - store, transcript reader, logger, and an optional force flag.
 * @returns a small report; `skipped` is true when nothing was done.
 */
export async function migrateEvidenceBasis(options) {
  const { store, readSessionEvents, log } = options;
  const force = options.force === true;
  const state = await store.readState();
  if (!force && Number(state.evidenceBasisVersion ?? 0) >= EVIDENCE_BASIS_VERSION) {
    return { skipped: true };
  }

  const rows = await store.readEvidence();
  const legacy = rows.filter((row) => row?.statement !== 'user' && row?.statement !== 'assistant' && row?.statement !== 'mixed');
  if (legacy.length === 0) {
    await store.updateState((next) => {
      next.evidenceBasisVersion = EVIDENCE_BASIS_VERSION;
      next.evidenceBasisMigratedAt = Date.now();
      next.evidenceBasisMigration = { total: rows.length, legacy: 0 };
    });
    return { skipped: false, legacy: 0, rows: rows.length };
  }

  // Read only the sessions that actually own legacy rows.
  const turnIndex = new Map();
  const sessionIds = [...new Set(legacy.map((row) => row.sessionId).filter((id) => typeof id === 'string' && id !== ''))];
  let unreadableSessions = 0;
  let readableTurns = 0;
  for (const sessionId of sessionIds) {
    try {
      const events = await readSessionEvents(sessionId);
      for (const [key, value] of indexTurns(sessionId, events)) {
        turnIndex.set(key, value);
        readableTurns += 1;
      }
    } catch {
      unreadableSessions += 1;
    }
  }

  // Guard: with no readable transcript at all there is nothing to verify against,
  // and rewriting the ledger on a transient failure would corrupt every basis. Skip
  // and retry on the next start instead.
  if (readableTurns === 0) {
    log(
      `evidence basis migration skipped: no transcript readable (${sessionIds.length} session(s), ${unreadableSessions} failed)`,
    );
    return { skipped: true, reason: 'no transcripts readable', sessions: sessionIds.length };
  }

  const { rows: rewritten, stats } = classifyEvidenceBasis(rows, turnIndex);
  await store.rewriteEvidence(rewritten);

  const profile = await store.profile(true);
  const { profile: repaired, stats: profileStats } = repairProfileBasis(profile, rewritten);
  await store.saveProfile(repaired);

  await store.updateState((next) => {
    next.evidenceBasisVersion = EVIDENCE_BASIS_VERSION;
    next.evidenceBasisMigratedAt = Date.now();
    next.evidenceBasisMigration = {
      total: stats.total,
      legacy: legacy.length,
      user: stats.user,
      assistant: stats.assistant,
      remaining: stats.remaining,
      unreadableSessions,
      profileChanged: profileStats.changed,
    };
  });

  log(
    `evidence basis migration: ${legacy.length} legacy row(s) re-derived ` +
      `(${stats.user} user / ${stats.assistant} assistant, ${unreadableSessions} unreadable session(s)); ` +
      `profile: ${profileStats.user} user / ${profileStats.assistant} assistant / ${profileStats.mixed} mixed ` +
      `(${profileStats.changed} changed)`,
  );
  return {
    skipped: false,
    legacy: legacy.length,
    evidence: stats,
    profile: profileStats,
    unreadableSessions,
  };
}



