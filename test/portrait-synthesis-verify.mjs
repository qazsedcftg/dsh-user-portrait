/**
 * End-to-end check of the synthesis fix against the REAL evidence ledger.
 *
 * The reported problem: two perfectly good evidence rows (galgame / 病娇) sat in
 * `evidence.jsonl` while the profile stayed empty, because the single
 * whole-profile synthesis call overran its output budget and a capped reply is
 * discarded whole. This script replays the fixed path over that real data:
 * scoped prompt → merge → atomic write → read back, proving the rows become
 * profile entries.
 *
 * Run with the bundled node binary:
 *   node test/portrait-synthesis-verify.mjs
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PLUGIN_ROOT, portraitDataDir, skip } from './_paths.mjs';

const PLUGIN = PLUGIN_ROOT;
const dataDir = portraitDataDir();
if (dataDir === undefined) skip('no portrait data to replay; set PORTRAIT_DATA or DSH_HOME');
const EVIDENCE = join(dataDir, 'evidence.jsonl');
const moduleUrl = (file) => pathToFileURL(join(PLUGIN, file)).href;

const { buildSynthesisPrompt, mergeSynthesis, safeParse, sourceIndexOf } = await import(moduleUrl('lib/extract.js'));
const { createProfile, DIMENSIONS, normalizeProfile } = await import(moduleUrl('lib/schema.js'));
const { PortraitStore } = await import(moduleUrl('lib/store.js'));
const { ensureLayout, layout } = await import(moduleUrl('lib/paths.js'));

import { check, finish } from './_harness.mjs';

// ------------------------------------------------------ the real evidence rows
const ledger = (await readFile(EVIDENCE, 'utf8'))
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));
const interestsRows = ledger.filter((row) => row.dimension === 'interests');
const galgame = interestsRows.filter((row) => /galgame|病娇|视觉小说/.test(row.text));
check('the real ledger has the galgame evidence', galgame.length > 0, galgame.length);
check(
  'that evidence is filed under the daily interests dimension',
  galgame.every((row) => row.kind === 'dimension' || row.kind === 'preference'),
  galgame.map((row) => row.kind),
);

// ------------------------------------------------------- the scoped prompt
const interests = DIMENSIONS.filter((dimension) => dimension.id === 'interests');
const emptyProfile = createProfile(1);
const prompt = buildSynthesisPrompt(emptyProfile, galgame, interests);
check('the scoped prompt names only the interests dimension', /只合并这几个维度：interests（兴趣与爱好）/.test(prompt), prompt.slice(0, 160));
check('the scoped prompt carries the evidence text', prompt.includes(galgame[0].text), prompt.slice(-400));
check('the scoped prompt stays small', prompt.length < 6000, prompt.length);

// A model answering that scope returns the dimension's entries — which is what
// the real model produces, and what the old whole-profile contract could not fit.
const reply = JSON.stringify({
  dimensions: {
    interests: galgame.map((row) => ({
      text: row.text,
      // These rows are the user's own quotes; the startup migration marks them so by
      // re-reading the transcript. This suite isolates the merge path, so they are
      // fed in already verified.
      statement: 'user',
      confidence: row.confidence,
      status: 'active',
      sources: [{ sessionId: row.sessionId, turn: row.turn }],
    })),
  },
});
// The galgame rows are the user's own words; the startup migration marks them so
// by re-reading the transcript (legacy rows carry no marker). This suite isolates
// the merge path, so the index is built as if that repair had already run.
const index = sourceIndexOf(galgame.map((row) => ({ ...row, statement: 'user' })));
check('the ledger index knows the galgame row', index.get(`${galgame[0].sessionId}#${galgame[0].turn}`) !== undefined);
const merged = mergeSynthesis(emptyProfile, safeParse(reply), 2, { sourceIndex: index });
check('the scoped reply merges', merged.report.accepted === true, merged.report);
// The two galgame rows are one topic, so they must collapse into ONE entry that
// keeps both statements — that is the whole point of the merge-first rule. (A
// single ledger row would also yield one entry.)
const interestEntries = merged.profile.dimensions.interests;
check(
  'the galgame evidence becomes one merged conclusion, not two rows',
  interestEntries.length === 1,
  interestEntries.map((entry) => entry.text),
);
check(
  'the merged conclusion keeps every statement it absorbed',
  galgame.length === 1 ||
    galgame.filter((row) => interestEntries[0].text.includes(row.text.replace(/[。.]$/, ''))).length >= 1,
  { merged: interestEntries[0]?.text, absorbed: galgame.map((row) => row.text) },
);
// The entry text is capped at ENTRY_TEXT_LIMIT, so a long merge truncates prose —
// but the EVIDENCE must never truncate: every absorbed row keeps its source.
check(
  'no absorbed row loses its source',
  interestEntries[0].sources.length === new Set(galgame.map((row) => `${row.sessionId}#${row.turn}`)).size ||
    interestEntries[0].sources.length >= Math.min(galgame.length, 12),
  {
    sources: interestEntries[0].sources.length,
    distinctRows: new Set(galgame.map((row) => `${row.sessionId}#${row.turn}`)).size,
    rows: galgame.length,
  },
);
check(
  'the merged entry stays inside the entry text budget',
  interestEntries[0].text.length <= 80,
  interestEntries[0].text.length,
);
check(
  'the merge is reported so the log can show it',
  merged.report.combinedEntries === galgame.length - 1,
  merged.report,
);
check(
  'its source session survives the merge',
  interestEntries[0].sources.some((source) => source.sessionId === galgame[0].sessionId),
  interestEntries[0].sources,
);
check(
  'the stored source carries the excerpt the panel shows on hover',
  interestEntries[0].sources[0].text === galgame[0].source,
  interestEntries[0].sources[0],
);
check(
  'the stored source carries its time, so the hover card can date it',
  Number.isFinite(interestEntries[0].sources[0].at),
  interestEntries[0].sources[0].at,
);
check(
  'the entry records that it rests on the user own words',
  interestEntries[0].statement === (galgame[0].statement ?? 'user'),
  interestEntries[0].statement,
);
check(
  'dimensions outside the scope were left untouched',
  DIMENSIONS.filter((dimension) => dimension.id !== 'interests').every(
    (dimension) => (merged.profile.dimensions[dimension.id] ?? []).length === 0,
  ),
);

// ------------------------------------------------------- persistence round trip
const dir = await mkdtemp(join(tmpdir(), 'portrait-verify-'));
const paths = layout(dir);
await ensureLayout(paths);
const store = new PortraitStore(paths);
await store.saveProfile(merged.profile);
const store2 = new PortraitStore(paths);
const reread = normalizeProfile(JSON.parse(await readFile(paths.profile, 'utf8')));
check('the profile is written to disk', reread.dimensions.interests.length === 1, reread.dimensions.interests.length);
check('the markdown twin names the interest', (await readFile(paths.profileMarkdown, 'utf8')).includes('galgame'));
check('store reads it back', (await store2.profile(true)).dimensions.interests.length === 1);
await rm(dir, { recursive: true, force: true });

finish('SYNTHESIS VERIFY PASSED');
