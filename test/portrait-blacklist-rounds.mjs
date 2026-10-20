/**
 * Blacklist round-trip check on a COPY of the real portrait data.
 *
 * The live data is never touched: it is copied to a temp directory first. Three
 * rounds exercise the paths that were broken:
 *
 * 1. retire → restore (derived layer, keys + turns),
 * 2. purge a conclusion whose rows are already gone (the "cleared 50, blacklist
 *    stayed at 3" case),
 * 3. timeline compaction (rows it drops must be pinned).
 *
 * Then the audit-log backfill is run and the effective blacklist is verified against
 * the synthesis filter.
 */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PLUGIN_ROOT, portraitDataDir, skip } from './_paths.mjs';

const PLUGIN = PLUGIN_ROOT;
const REAL = portraitDataDir();
if (REAL === undefined) skip('no real portrait data to replay; set PORTRAIT_DATA or DSH_HOME');

const { PortraitStore } = await import(pathToFileURL(`${PLUGIN}/lib/store.js`).href);
const { PortraitOps } = await import(pathToFileURL(`${PLUGIN}/lib/ops.js`).href);
const { backfillBlacklistTurns } = await import(pathToFileURL(`${PLUGIN}/lib/migrate.js`).href);
const { blacklistForProfile, selectSynthesisSource, turnKey } = await import(pathToFileURL(`${PLUGIN}/lib/extract.js`).href);
const { DIMENSION_IDS, entryId } = await import(pathToFileURL(`${PLUGIN}/lib/schema.js`).href);
const { layout, ensureLayout } = await import(pathToFileURL(`${PLUGIN}/lib/paths.js`).href);

import { check, finish } from './_harness.mjs';

const copy = await mkdtemp(join(tmpdir(), 'portrait-blacklist-rounds-'));
await cp(REAL, copy, { recursive: true });

const logs = [];
const paths = layout(copy);
await ensureLayout(paths);
const store = new PortraitStore(paths);
const ops = new PortraitOps({ store, engine: {}, config: {}, log: (line) => logs.push(line) });

const blacklist = async () => {
  const raw = JSON.parse(await readFile(join(copy, 'blacklist.json'), 'utf8'));
  // The real file predates the two-layer model: read it the way the store does.
  return {
    keys: raw.keys ?? [],
    turns: raw.turns ?? [],
    pinnedKeys: raw.pinnedKeys ?? raw.pinned ?? [],
    pinnedTurns: raw.pinnedTurns ?? [],
  };
};
const profile = () => store.profile(true);
const rows = () => store.readEvidence();

const before = await blacklist();
const beforeKeys = before.keys.length;
console.log(
  `\ncopy: ${copy}\nstart: ${before.keys.length} key(s) / ${(before.turns ?? []).length} turn(s) pinned ` +
    `(${(before.pinnedKeys ?? []).length} / ${(before.pinnedTurns ?? []).length})\n`,
);

// --- round 1: retire then restore ---------------------------------------------
const activeEntry = await (async () => {
  const doc = await profile();
  for (const id of DIMENSION_IDS) {
    for (const entry of doc.dimensions?.[id] ?? []) {
      if (entry.status === 'active' && (entry.sources ?? []).length > 0) return { dimension: id, entry };
    }
  }
  return undefined;
})();
check('round 1: found an active conclusion with sources', activeEntry !== undefined);

if (activeEntry !== undefined) {
  const turns = activeEntry.entry.sources.map((source) => turnKey(source));
  const retire = await ops.update({ action: 'setStatus', op: 'setStatus', id: activeEntry.entry.id, matchText: activeEntry.entry.text, status: 'retired' });
  check('round 1: retiring succeeds', retire.ok === true, retire);
  const pinnedBefore = new Set((await blacklist()).pinnedTurns);
  const afterRetire = await blacklist();
  // Turns shared with another ACTIVE conclusion stay usable by design, so the
  // assertion is "something got silenced", not "every turn got silenced".
  const addedTurns = turns.filter((key) => afterRetire.turns.includes(key));
  const addedKeys = afterRetire.keys.length - beforeKeys;
  check(
    'round 1: retire silences its own evidence (rows and/or unshared turns)',
    addedTurns.length > 0 || addedKeys > 0,
    { turns: addedTurns, addedKeys },
  );
  console.log(`     (${addedTurns.length}/${turns.length} turn(s) silenced, ${addedKeys} row key(s) added; the rest stays usable for active conclusions)`);
  const restore = await ops.update({ action: 'setStatus', op: 'setStatus', id: activeEntry.entry.id, matchText: activeEntry.entry.text, status: 'active' });
  check('round 1: restoring succeeds', restore.ok === true, restore);
  const afterRestore = await blacklist();
  // Pinned turns survive a restore by design (they were deleted for good); only the
  // turns this retire actually ADDED should disappear again.
  const addedByRetire = turns.filter((key) => afterRetire.turns.includes(key) && pinnedBefore.has(key) === false);
  const stillThere = addedByRetire.filter((key) => afterRestore.turns.includes(key));
  check(
    'round 1: restore releases the turns the retire itself added',
    stillThere.length === 0,
    { added: addedByRetire, stillSilenced: stillThere, before: afterRetire.turns.length, after: afterRestore.turns.length },
  );
  const derived = blacklistForProfile(await profile(), await rows(), afterRestore.pinnedKeys, afterRestore.pinnedTurns);
  check(
    'round 1: the effective sets match a fresh reconcile',
    derived.turns.join('|') === [...afterRestore.turns].sort().join('|'),
    { derived: derived.turns.length, stored: afterRestore.turns.length },
  );
}

// --- round 2: purge a conclusion whose rows are already gone -------------------
// The assertion must not depend on which conclusion this data happens to hold:
// pick a retired entry whose turns no ACTIVE conclusion still cites when one
// exists, and compare the pinned set exactly. A synthetic rowless entry then
// covers the case the real data cannot supply (every turn shared), so the
// regression stays guarded on any machine.
const activeTurnSet = async () => {
  const doc = await profile();
  const keys = new Set();
  for (const id of DIMENSION_IDS) {
    for (const entry of doc.dimensions?.[id] ?? []) {
      if (entry.status !== 'active') continue;
      for (const source of entry.sources ?? []) keys.add(turnKey(source));
    }
  }
  return keys;
};

const doomed = await (async () => {
  const doc = await profile();
  const activeTurns = await activeTurnSet();
  let fallback;
  for (const id of DIMENSION_IDS) {
    for (const entry of doc.dimensions?.[id] ?? []) {
      if (entry.status === 'active' || (entry.sources ?? []).length === 0) continue;
      const unshared = entry.sources.map((source) => turnKey(source)).filter((key) => !activeTurns.has(key));
      const candidate = { dimension: id, entry, unshared };
      if (unshared.length > 0) return candidate;
      fallback ??= candidate;
    }
  }
  return fallback;
})();
check('round 2: found a non-active conclusion with sources', doomed !== undefined);

if (doomed !== undefined) {
  const purge = await ops.purgeEntry({ id: doomed.entry.id, matchText: doomed.entry.text });
  check('round 2: purge succeeds', purge.ok === true, purge);
  const afterPurge = await blacklist();
  const pinnedFromThis = doomed.unshared.filter((key) => afterPurge.pinnedTurns.includes(key));
  check(
    'round 2: a rowless purge pins exactly the turns no active conclusion uses',
    purge.removedEvidence === 0 && pinnedFromThis.length === doomed.unshared.length,
    { removedRows: purge.removedEvidence, expected: doomed.unshared, pinned: pinnedFromThis },
  );
  if (doomed.unshared.length === 0) {
    console.log('     (every turn of the retired conclusion is still cited by an active one: nothing to pin here)');
  }
}

// Synthetic rowless purge: no evidence row matches it and nothing else cites the
// turn, so the turn MUST be pinned even though no row is removed.
const syntheticText = '合成用例：没有证据行的结论也必须永久屏蔽它的轮次';
await store.updateProfile((current) => {
  const list = current.dimensions?.focus ?? (current.dimensions.focus = []);
  list.push({
    text: syntheticText,
    status: 'active',
    confidence: 'low',
    statement: 'manual',
    sources: [{ sessionId: 'synthetic-session', turn: 99 }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return current;
});
const syntheticPurge = await ops.purgeEntry({ id: entryId('focus', { text: syntheticText }), matchText: syntheticText });
const afterSynthetic = await blacklist();
check(
  'round 2b: a rowless purge pins an unshared turn even with no ledger row',
  syntheticPurge.ok === true && syntheticPurge.removedEvidence === 0 && afterSynthetic.pinnedTurns.includes('synthetic-session#99'),
  { purge: syntheticPurge, pinned: afterSynthetic.pinnedTurns.includes('synthetic-session#99') },
);

// --- round 3: timeline compaction must pin what it drops ----------------------
const keysBefore = (await blacklist()).pinnedKeys.length;
const compact = await ops.compactTimeline();
check('round 3: compaction succeeds', compact.ok === true, { removed: compact.removed });
const afterCompact = await blacklist();
if (compact.removed > 0) {
  check(
    'round 3: compaction pins the rows it removed',
    afterCompact.pinnedKeys.length > keysBefore,
    { before: keysBefore, after: afterCompact.pinnedKeys.length, removed: compact.removed },
  );
} else {
  console.log('     (nothing to compact in this copy: the ledger is already tidy — pinning check skipped)');
}
const ledgerTurns = new Set((await rows()).map((row) => turnKey(row)));
check(
  'round 3: pinned turns point at turns the ledger no longer keeps',
  afterCompact.pinnedTurns.some((key) => !ledgerTurns.has(key)),
  afterCompact.pinnedTurns.length,
);

// --- backfill from the deletion audit log -------------------------------------
const backfill = await backfillBlacklistTurns({ store, log: (line) => logs.push(line), force: true });
check('backfill ran', backfill.skipped !== true, backfill);
const afterBackfill = await blacklist();
check(
  'backfill pins turns recorded by the old purges',
  backfill.turns > 0 && afterBackfill.pinnedTurns.length >= backfill.turns,
  { records: backfill.records, turns: backfill.turns, pinned: afterBackfill.pinnedTurns.length },
);

// --- the effective filter honours both halves ---------------------------------
const doc = await blacklist();
const source = selectSynthesisSource(await rows(), new Set(doc.keys), new Set(doc.turns));

const forbiddenTurns = new Set(doc.turns);
const leakedTurns = source.filter((row) => forbiddenTurns.has(turnKey(row)));
check('no blacklisted turn reaches synthesis', leakedTurns.length === 0, leakedTurns.slice(0, 3).map((row) => turnKey(row)));
check('the filter keeps usable evidence', source.length > 0, source.length);


console.log(`\nfinal: ${doc.keys.length} key(s) / ${doc.turns.length} turn(s) pinned ` +
  `(${doc.pinnedKeys.length} / ${doc.pinnedTurns.length}); ledger ${(await rows()).length} row(s), synthesis source ${source.length}`);
console.log(`\n--- ops log ---`);
for (const line of logs.slice(-12)) console.log(`  ${line}`);
await rm(copy, { recursive: true, force: true });
finish('BLACKLIST ROUNDS PASSED');
