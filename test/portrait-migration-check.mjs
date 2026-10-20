/**
 * The one-time evidence-basis migration, exercised on an in-memory store.
 *
 * The bug this guards: ledger rows written before the basis marker existed were
 * treated as "the user's words" (no marker ≠ assistant), so a whole profile read
 * as `user`. The migration re-derives the basis from the actual transcript, repairs
 * the profile from the rewritten sources, and must not run twice.
 *
 * Run with: node test/portrait-migration-check.mjs
 */

import { createProfile } from '../lib/schema.js';
import { EVIDENCE_BASIS_VERSION, migrateEvidenceBasis } from '../lib/migrate.js';

import { check, finish } from './_harness.mjs';

/** The user's actual words in the stubbed sessions. */
const USER_TEXT = {
  s1: '帮我改一下插件，主要用 Windows，最好用 PowerShell 而不是 node',
  s2: '继续吧',
};

/** Minimal session events: one human message per session, turn 1. */
function eventsFor(sessionId) {
  const text = USER_TEXT[sessionId];
  if (text === undefined) throw new Error(`no transcript for ${sessionId}`);
  return [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } },
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

/** Build a store stub with the given ledger and profile. */
function makeStore(rows, profile) {
  const state = {};
  return {
    rows,
    // The real store exposes `profile(force)`; keep the document under a different
    // name so the stub matches the interface instead of the data.
    profileDocument: profile,
    state,
    written: 0,
    async readEvidence() {
      return this.rows.map((row) => ({ ...row }));
    },
    async rewriteEvidence(next) {
      this.written += 1;
      this.rows = next.map((row) => ({ ...row }));
      return next.length;
    },
    async profile() {
      return JSON.parse(JSON.stringify(this.profileDocument));
    },
    async saveProfile(next) {
      this.profileDocument = JSON.parse(JSON.stringify(next));
    },
    async readState() {
      return { ...this.state };
    },
    async updateState(mutate) {
      mutate(this.state);
      return this.state;
    },
  };
}

// ---------------------------------------------------------------- the ledger rows
const legacyRows = [
  // Quote is verbatim in the user's turn → the user's words.
  { kind: 'dimension', dimension: 'skill', sessionId: 's1', turn: 1, text: '主要用 Windows', source: '主要用 Windows', confidence: 'high' },
  // Quote only exists in the reply → the model's inference.
  { kind: 'dimension', dimension: 'skill', sessionId: 's1', turn: 1, text: '看起来精通 PowerShell 管道', source: '我给你解释过管道的串法', confidence: 'high' },
  // A correction is anchored to the closest user line.
  { kind: 'preference', dimension: 'workstyle', sessionId: 's1', turn: 1, text: '偏好用 PowerShell 而不是 node', source: '', confidence: 'high' },
  // Its session cannot be read → fail closed to the model's side.
  { kind: 'dimension', dimension: 'interests', sessionId: 's9', turn: 1, text: '喜欢玩 galgame', source: '喜欢玩 galgame', confidence: 'high' },
  // Already marked: untouched.
  { kind: 'dimension', dimension: 'interests', sessionId: 's2', turn: 1, text: '明确不喜欢被反复追问', source: '继续吧', statement: 'assistant', confidence: 'low' },
];

const profile = createProfile(1);
profile.dimensions.skill.push(
  {
    text: '主要用 Windows',
    statement: 'user',
    confidence: 'high',
    status: 'active',
    sources: [{ sessionId: 's1', turn: 1 }],
  },
  {
    text: '看起来精通 PowerShell 管道',
    statement: 'user',
    confidence: 'high',
    status: 'active',
    sources: [{ sessionId: 's1', turn: 1 }],
  },
  {
    // Backed by one row of each kind → the conclusion rests on both bases.
    text: '用 Windows 且精通 PowerShell 管道',
    statement: 'user',
    confidence: 'high',
    status: 'active',
    sources: [
      { sessionId: 's1', turn: 1 },
      { sessionId: 's9', turn: 1 },
    ],
  },
  // Hand-written: never touched by the repair.
  {
    text: '我手动写下的一条结论',
    statement: 'user',
    confidence: 'high',
    status: 'active',
    manual: true,
    sources: [],
  },
);

const store = makeStore(legacyRows, profile);
/** Only s1 and s2 can be read; s9 is deliberately missing from the transcript set. */
const readSessionEvents = async (sessionId) => eventsFor(sessionId);

const report = await migrateEvidenceBasis({ store, readSessionEvents, log: () => undefined });
check('the migration runs', report.skipped === false, report);
check('it reports the legacy rows it found', report.legacy === 4, report.legacy);
check('the ledger was rewritten once', store.written === 1, store.written);

const byText = new Map(store.rows.map((row) => [row.text, row]));
check('a verbatim user quote becomes the user basis', byText.get('主要用 Windows')?.statement === 'user', byText.get('主要用 Windows'));
check(
  'a quote that only exists in the reply becomes a model inference',
  byText.get('看起来精通 PowerShell 管道')?.statement === 'assistant',
  byText.get('看起来精通 PowerShell 管道'),
);
check('a correction is anchored to the user line', byText.get('偏好用 PowerShell 而不是 node')?.statement === 'user', byText.get('偏好用 PowerShell 而不是 node'));
check(
  'an unreadable session leaves the row unmarked instead of guessing',
  byText.get('喜欢玩 galgame')?.statement === undefined,
  byText.get('喜欢玩 galgame'),
);
check('an already-marked row is left alone', byText.get('明确不喜欢被反复追问')?.statement === 'assistant');

// ------------------------------------------------------------------ the profile
const repaired = store.profileDocument.dimensions.skill;
const entryNamed = (name) => repaired.find((entry) => entry.text === name);
check('a user-backed entry keeps the user basis', entryNamed('主要用 Windows')?.statement === 'user', entryNamed('主要用 Windows'));
check(
  'an entry backed only by an inference becomes a model inference',
  entryNamed('看起来精通 PowerShell 管道')?.statement === 'assistant',
  entryNamed('看起来精通 PowerShell 管道'),
);
check(
  'the inference-backed entry loses its high confidence',
  entryNamed('看起来精通 PowerShell 管道')?.confidence === 'low',
  entryNamed('看起来精通 PowerShell 管道')?.confidence,
);
check(
  'an entry backed by both bases becomes mixed',
  entryNamed('用 Windows 且精通 PowerShell 管道')?.statement === 'mixed',
  entryNamed('用 Windows 且精通 PowerShell 管道'),
);
check(
  'the mixed entry is clamped like an inference',
  entryNamed('用 Windows 且精通 PowerShell 管道')?.confidence === 'low',
  entryNamed('用 Windows 且精通 PowerShell 管道')?.confidence,
);
check(
  'a hand-written entry is untouched',
  entryNamed('我手动写下的一条结论')?.statement === 'user' && entryNamed('我手动写下的一条结论')?.confidence === 'high',
  entryNamed('我手动写下的一条结论'),
);

// -------------------------------------------------------------------- idempotence
check('the state records the migration', store.state.evidenceBasisVersion === EVIDENCE_BASIS_VERSION, store.state);
const second = await migrateEvidenceBasis({ store, readSessionEvents, log: () => undefined });
check('a second run is skipped', second.skipped === true, second);
check('a second run does not rewrite the ledger again', store.written === 1, store.written);

// ------------------------------------------------------- the fail-safe guard
// If no transcript can be read at all (service not ready, store moved), the
// migration must NOT rewrite anything: a transient failure would otherwise flip
// every basis in the ledger to "model inference".
const blindStore = makeStore(legacyRows, createProfile(1));
const blind = await migrateEvidenceBasis({
  store: blindStore,
  readSessionEvents: async () => {
    throw new Error('session store unavailable');
  },
  log: () => undefined,
});
check('with no readable transcript the migration skips', blind.skipped === true, blind);
check('the skip reason is explicit', blind.reason === 'no transcripts readable', blind.reason);
check('a blind run does not rewrite the ledger', blindStore.written === 0, blindStore.written);
check('a blind run does not mark itself done', blindStore.state.evidenceBasisVersion === undefined, blindStore.state);
check(
  'a blind run leaves every row exactly as it was',
  blindStore.rows.every((row, index) => row.statement === legacyRows[index].statement),
  blindStore.rows.map((row) => row.statement),
);

finish('MIGRATION CHECK PASSED');
