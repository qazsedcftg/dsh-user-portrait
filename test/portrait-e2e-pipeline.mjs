/**
 * End-to-end exercise of the extraction pipeline.
 *
 * A synthetic `turn/end` must travel from the session listener through the
 * background job, the direct LLM call, and into durable turn / evidence /
 * session records; a cadence-driven synthesis must reach profile.json and the
 * prompt section; and an `agent/disposed` must upgrade the session's derived
 * roll-up to a model-written one.
 *
 * The LLM service, the session query, and the data directory are all mocked or
 * throwaway, so this touches no real data.
 */
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PLUGIN_ROOT } from './_paths.mjs';

const PLUGIN = join(PLUGIN_ROOT, 'index.js');

import { check, finish } from './_harness.mjs';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------ synthetic log
const now = Date.now();
const events = [
  { type: 'turn/start', seq: 1, time: now, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 2,
    time: now + 1,
    data: {
      content: [{ type: 'text', text: '帮我把插件挪到 work-space，并把 dataDir 改成绝对路径，最好用 PowerShell 而不是 node' }],
      source: { kind: 'user' },
    },
  },
  {
    type: 'user/message',
    seq: 3,
    time: now + 2,
    data: { content: [{ type: 'text', text: '这是插件注入的上下文，不该被当成我说的' }], source: { kind: 'agent-instructions' } },
  },
  {
    type: 'assistant/message',
    seq: 4,
    time: now + 3,
    data: { message: { content: [{ type: 'text', text: '已把目录搬完，并把 dataDir 固定为绝对路径。' }] } },
  },
  { type: 'tool/call', seq: 5, time: now + 4, data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' } },
  { type: 'turn/end', seq: 6, time: now + 5, data: { turn: 1, reason: { kind: 'completed' } } },
];

// ------------------------------------------------------------ mocked model
const calls = [];
const digestReply = JSON.stringify({
  userAsk: '把插件迁移到 work-space 并改绝对路径',
  userKeyPoints: ['用 PowerShell 而非 node', 'dataDir 要绝对路径'],
  assistantSummary: '搬移目录并固定绝对数据目录。',
  outcome: '已完成',
  corrections: [{ kind: '偏好', text: '倾向用 PowerShell 而不是 node 做文件操作' }],
  evidence: [
    { dimension: 'skill', text: '优先使用 PowerShell 处理文件操作', confidence: 'high', source: '最好用 PowerShell 而不是 node' },
    { dimension: 'workstyle', text: '要求把不确定的路径固定死', confidence: 'medium', source: 'dataDir 改成绝对路径' },
  ],
});
// One full merge result, sliced per call by the scope the prompt asks for. The
// engine now merges ONE dimension group per call (a whole-profile rewrite used to
// overrun the output budget), so the mock must answer only what it was asked.
const fullSynthesis = {
  skill: [
    { text: '优先使用 PowerShell 处理文件操作', confidence: 'high', status: 'active', sources: [{ sessionId: 'session-e2e', turn: 1 }] },
  ],
  workstyle: [
    { text: '要求把不确定的路径固定死', confidence: 'medium', status: 'active', sources: [{ sessionId: 'session-e2e', turn: 1 }] },
  ],
};

/** Answer a scoped synthesis prompt with only the dimensions it names. */
function scopedSynthesisReply(prompt) {
  const asked = prompt.match(/只合并这几个维度：([^\n]+)/)?.[1] ?? '';
  const dimensions = {};
  for (const [id, entries] of Object.entries(fullSynthesis)) {
    if (asked.includes(id)) dimensions[id] = entries;
  }
  return JSON.stringify({ dimensions });
}
const rollupReply = JSON.stringify({
  topic: '迁移插件目录并固定配置',
  overview: '把插件搬到 work-space，用绝对路径替换了不确定的相对路径。',
  threads: ['目录迁移', '配置固定'],
  outcomes: ['插件在新位置可加载'],
  unresolved: [],
});

/**
 * A minimal stand-in for the LLM service: an async iterable of stream chunks,
 * which is exactly the shape `ctx.llm.stream()` returns.
 */
const llm = {
  stream(options) {
    const prompt = options?.messages?.[0]?.content?.[0]?.text ?? '';
    const kind = prompt.includes('新证据') ? 'synthesis' : prompt.includes('逐轮记录') ? 'rollup' : 'digest';
    calls.push({
      kind,
      provider: options?.provider,
      model: options?.model,
      system: options?.system,
      maxTokens: options?.maxTokens,
      prompt,
      hasSignal: options?.signal instanceof AbortSignal,
      sessionId: options?.sessionId,
    });
    const text = kind === 'synthesis' ? scopedSynthesisReply(prompt) : kind === 'rollup' ? rollupReply : digestReply;
    return (async function* stream() {
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  },
};

// ------------------------------------------------------------- mock context
const listeners = new Map();
const sections = [];
const tools = [];
const logs = [];
const logger = Object.assign((m) => logs.push(String(m)), {
  info: (m) => logs.push(String(m)),
  warn: (m) => logs.push(`WARN ${String(m)}`),
  error: (m) => logs.push(`ERROR ${String(m)}`),
});

const dataDir = await mkdtemp(join(tmpdir(), 'portrait-e2e-'));
// The composer switch defaults to off: opt this session in before activation so the
// prompt section has something to render.
await writeFile(
  join(dataDir, 'state.json'),
  JSON.stringify({ sessionModes: { 'session-e2e': { enabled: true, daily: true, tech: true } } }),
  'utf8',
);
const services = {
  tools: { register: (definition) => { tools.push(definition); return () => undefined; } },
  systemPrompt: { section: (section) => { sections.push(section); return () => undefined; } },
  webServer: { register: () => () => undefined },
  llm,
  agentDefaultModel: { currentSelection: () => ({ provider: 'route-provider', model: 'route-model' }) },
  sessionQuery: { listSessions: async () => [], readSession: async () => ({ events: [] }) },
};
const ctx = {
  logger: () => logger,
  effect: (callback) => (typeof callback === 'function' ? callback() ?? (() => undefined) : () => undefined),
  on: (name, listener) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(listener);
    return () => undefined;
  },
  get: (name) => services[name],
  /** Mirrors Cordis's ctx.inject: run the child body once its services exist. */
  inject: (deps, callback) => {
    if (deps.some((name) => services[name] === undefined)) return () => undefined;
    const child = { get: (name) => services[name] };
    for (const name of deps) child[name] = services[name];
    callback(child, {});
    return () => undefined;
  },
};

// --------------------------------------------------------------------- run
const module = await import(pathToFileURL(PLUGIN).href);
module.apply(ctx, {
  dataDir,
  backfillOnStart: false,
  synthesizeEveryTurns: 1,
  turnSynthesisDelayMs: 0,
  minEvidenceForSynthesis: 1,
  sessionRollupMinTurns: 1,
});
await sleep(300);

check('registers a session/event listener', (listeners.get('session/event') ?? []).length === 1);
check('registers an agent/disposed listener', (listeners.get('agent/disposed') ?? []).length === 1);
check('registers the tool set', tools.length === 4, tools.length);

// --- one completed turn through the real listener
const session = {
  id: 'session-e2e',
  header: { id: 'session-e2e', createdAt: now, cwd: 'workspace' },
  snapshotEvents: () => events,
};
for (const listener of listeners.get('session/event') ?? []) listener(session, events[events.length - 1]);

for (let attempt = 0; attempt < 40; attempt += 1) {
  await sleep(50);
  if (existsSync(join(dataDir, 'profile.json'))) break;
}

const digestCalls = calls.filter((call) => call.kind === 'digest');
const synthesisCalls = calls.filter((call) => call.kind === 'synthesis');
check('the digest call was made through the llm service', digestCalls.length === 1, calls.map((call) => call.kind));
check('the route follows the deployment default model', digestCalls[0]?.provider === 'route-provider' && digestCalls[0]?.model === 'route-model', digestCalls[0]);
check('the call carries no session attribution', digestCalls[0]?.sessionId === undefined, digestCalls[0]?.sessionId);
check('the call carries a system instruction', typeof digestCalls[0]?.system === 'string' && digestCalls[0].system.includes('提炼器'), digestCalls[0]?.system?.slice(0, 40));
check('the call carries an output cap', Number.isFinite(digestCalls[0]?.maxTokens), digestCalls[0]?.maxTokens);
check('the call carries a cancellation signal', digestCalls[0]?.hasSignal === true);
check('the digest prompt excludes plugin-injected text', !(digestCalls[0]?.prompt ?? '').includes('不该被当成我说的'), (digestCalls[0]?.prompt ?? '').slice(0, 100));
check('the digest prompt carries what I actually asked', (digestCalls[0]?.prompt ?? '').includes('work-space'));

const turnFiles = await readdir(join(dataDir, 'turns')).catch(() => []);
check('a per-turn digest file was written', turnFiles.includes('session-e2e.jsonl'), turnFiles);
if (turnFiles.includes('session-e2e.jsonl')) {
  const lines = (await readFile(join(dataDir, 'turns', 'session-e2e.jsonl'), 'utf8')).split('\n').filter(Boolean);
  check('exactly one turn digest row', lines.length === 1, lines.length);
  const digest = JSON.parse(lines[0]);
  check('digest records what I asked', String(digest.userAsk).includes('work-space'), digest.userAsk);
  check('digest records the answer summary', String(digest.assistantSummary).length > 0);
  check('digest records my corrections', digest.corrections.length === 1, digest.corrections);
}

const evidenceLines = existsSync(join(dataDir, 'evidence.jsonl'))
  ? (await readFile(join(dataDir, 'evidence.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : [];
check('evidence rows were appended', evidenceLines.length >= 3, evidenceLines.length);
check('evidence carries the source session and turn', evidenceLines.every((row) => row.sessionId === 'session-e2e' && row.turn === 1));
check('the correction became a high-confidence evidence row', evidenceLines.some((row) => row.kind === 'preference' && row.confidence === 'high'));
check('evidence rows carry an original excerpt', evidenceLines.some((row) => typeof row.source === 'string' && row.source.length > 0));

// --- session record, with a derived roll-up available immediately
const sessionRecordPath = join(dataDir, 'sessions', 'session-e2e.json');
check('a session digest was written', existsSync(sessionRecordPath));
if (existsSync(sessionRecordPath)) {
  const record = JSON.parse(await readFile(sessionRecordPath, 'utf8'));
  check('session record lists the turn', (record.turns ?? []).length === 1, record.turnCount);
  check('session record has a roll-up immediately', record.rollup !== undefined);
  check('the immediate roll-up is the derived one', record.rollup?.source === 'derived', record.rollup?.source);
  check('the derived roll-up has a topic', String(record.rollup?.topic ?? '').includes('work-space'), record.rollup?.topic);
  check('the derived roll-up has an overview', String(record.rollup?.overview ?? '').length > 0, record.rollup?.overview);
}

// --- synthesis
// Synthesis is scoped: one call per dimension group, each carrying only its own
// dimensions. That is what keeps a reply inside the output budget.
check('synthesis calls were made per dimension group', synthesisCalls.length >= 2, synthesisCalls.length);
check(
  'each synthesis call carries exactly one scope, not the whole profile',
  synthesisCalls.every((call) => /只合并这几个维度：([^\n]+)/.test(call.prompt)),
  synthesisCalls.map((call) => (call.prompt.match(/只合并这几个维度：([^\n]+)/) ?? [])[1]),
);
check(
  'the dimension with evidence got its own call',
  synthesisCalls.some((call) => /只合并这几个维度：skill（能力与技术栈）/.test(call.prompt)),
  synthesisCalls.map((call) => (call.prompt.match(/只合并这几个维度：([^\n]+)/) ?? [])[1]),
);
check(
  'a scoped call does not ask for the other dimensions',
  synthesisCalls.every((call) => {
    const asked = call.prompt.match(/只合并这几个维度：([^\n]+)/)?.[1] ?? '';
    return !(asked.includes('skill') && asked.includes('workstyle'));
  }),
  synthesisCalls.map((call) => (call.prompt.match(/只合并这几个维度：([^\n]+)/) ?? [])[1]),
);
check('profile.json was created', existsSync(join(dataDir, 'profile.json')));
if (existsSync(join(dataDir, 'profile.json'))) {
  const profile = JSON.parse(await readFile(join(dataDir, 'profile.json'), 'utf8'));
  check('profile has the merged skill entry', String(profile.dimensions?.skill?.[0]?.text ?? '').includes('PowerShell'));
  check('profile has the workstyle entry', String(profile.dimensions?.workstyle?.[0]?.text ?? '').includes('固定'));
  check('every dimension bucket exists', Object.keys(profile.dimensions ?? {}).length === 9, Object.keys(profile.dimensions ?? {}));
  check('no retired dimension bucket survives', profile.dimensions?.tooling === undefined && profile.dimensions?.values === undefined);
  check('synthesis counter advanced', profile.synthesizedTurns >= 1, profile.synthesizedTurns);
  check('profile.md twin exists', existsSync(join(dataDir, 'profile.md')));
}

// --- the prompt section, still synchronous, now advertises the portrait
const hint = sections[0]?.text({ agent: { id: 'session-e2e' } });
check('prompt section returns a string after digestion', typeof hint === 'string', typeof hint);
check('prompt section reports accumulated entries', hint.includes('条结论'), hint.slice(0, 160));
check(
  'prompt section names a covered dimension',
  hint.includes('能力与技术栈') || hint.includes('工作方式') || hint.includes('敏感点'),
  hint.slice(0, 200),
);

// --- agent/disposed upgrades the roll-up
for (const listener of listeners.get('agent/disposed') ?? []) {
  listener({ agent: { id: 'session-e2e', session } });
}
for (let attempt = 0; attempt < 40; attempt += 1) {
  await sleep(50);
  if (calls.some((call) => call.kind === 'rollup')) break;
}
await sleep(150);
check('the session roll-up call was made on dispose', calls.some((call) => call.kind === 'rollup'), calls.map((call) => call.kind));
if (existsSync(sessionRecordPath)) {
  const record = JSON.parse(await readFile(sessionRecordPath, 'utf8'));
  check('the roll-up was upgraded to the model one', record.rollup?.source === 'model', record.rollup?.source);
  check('the model roll-up topic is stored', String(record.rollup?.topic ?? '').includes('迁移'), record.rollup?.topic);
  check('the model roll-up overview is stored', String(record.rollup?.overview ?? '').includes('work-space'), record.rollup?.overview);
  check('the turn record survived the roll-up', (record.turns ?? []).length === 1);
  check('the session outcomes are stored', (record.rollup?.outcomes ?? []).length === 1, record.rollup?.outcomes);
}

// --- the agent-facing tools read the same data
const readTool = tools.find((tool) => tool.name === 'portrait_read');
const read = await readTool.execute({}, {});
check('portrait_read sees the new entries', read.activeEntries >= 2, read);
const historyTool = tools.find((tool) => tool.name === 'portrait_history');
const history = await historyTool.execute({}, {});
check('portrait_history sees the session', history.sessions === 1, history.sessions);
check('portrait_history shows the turn question', history.text.includes('work-space'), history.text.slice(0, 200));
check('portrait_history shows the session topic', history.text.includes('迁移'), history.text.slice(0, 300));
const searchTool = tools.find((tool) => tool.name === 'portrait_search');
const search = await searchTool.execute({ query: 'PowerShell' }, {});
check('portrait_search finds the evidence', search.matches >= 1, search.matches);

// --- a subagent-origin session must never be digested
const subagentSession = { id: 'session-child', header: { id: 'session-child', origin: 'subagent' }, snapshotEvents: () => events };
const beforeCalls = calls.length;
for (const listener of listeners.get('session/event') ?? []) listener(subagentSession, events[events.length - 1]);
await sleep(200);
check('subagent sessions are ignored', calls.length === beforeCalls, calls.slice(beforeCalls).map((call) => call.kind));

await sleep(100);
await rm(dataDir, { recursive: true, force: true });

console.log('\n--- llm calls ---');
for (const call of calls) console.log(`  ${call.kind} via ${call.provider}/${call.model} (${call.prompt.length} chars)`);
console.log('--- plugin log ---');
for (const line of logs) console.log(`  ${line}`);
finish('E2E PIPELINE PASSED');
