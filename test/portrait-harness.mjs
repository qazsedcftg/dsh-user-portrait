/**
 * Harness that loads the user portrait plugin exactly as the runtime would,
 * applies it against a mock Cordis context, and reports what it registered.
 *
 * It runs against a throwaway data directory, so no real portrait data is
 * touched.
 */
import { pathToFileURL } from 'node:url';
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PLUGIN_ID, PLUGIN_ROOT, RUNTIME_TOOLS, skip } from './_paths.mjs';

const PLUGIN = join(PLUGIN_ROOT, 'index.js');
if (RUNTIME_TOOLS === undefined) skip('no DSH application found; set DSH_APP_ROOT to run the host harness');

/** The runtime's own schema checker, so this mock rejects what the real one rejects. */
const { assertSupportedJsonSchema } = await import(pathToFileURL(RUNTIME_TOOLS).href);

const dataDir = await mkdtemp(join(tmpdir(), 'portrait-harness-'));
const logLines = [];
const effects = [];
const tools = [];
const sections = [];
const routes = [];
const listeners = [];
const injectCalls = [];
const blockedInjects = [];

const logger = Object.assign((message) => logLines.push(String(message)), {
  info: (message) => logLines.push(String(message)),
  warn: (message) => logLines.push(`WARN ${String(message)}`),
  error: (message) => logLines.push(`ERROR ${String(message)}`),
});

const services = {
  tools: {
    // The real registry validates `output.schema` with its own checker before
    // accepting a definition, so this mock does too: a weak mock is exactly what
    // let a shorthand schema reach the live runtime undetected.
    register: (definition) => {
      assertSupportedJsonSchema(definition.output?.schema);
      tools.push(definition);
      return () => undefined;
    },
  },
  systemPrompt: {
    section: (section) => {
      sections.push(section);
      return () => undefined;
    },
  },
  webServer: {
    register: (route) => {
      routes.push(route);
      return () => undefined;
    },
  },
  // `llm`, `agentDefaultModel`, and `sessionQuery` stay absent on purpose: the
  // plugin must still activate and register everything else in a partial profile.
};

const ctx = {
  logger: () => logger,
  effect: (callback, label) => {
    effects.push(label ?? '(unlabeled)');
    return typeof callback === 'function' ? callback() ?? (() => undefined) : () => undefined;
  },
  on: (name, listener) => {
    listeners.push({ name, listener });
    return () => undefined;
  },
  get: (name) => services[name] ?? undefined,
  /**
   * Faithful stand-in for Cordis's `ctx.inject`: start the child body only once
   * every named service exists, passing a context that carries them as
   * properties (which is what the real child context does).
   */
  inject: (deps, callback) => {
    injectCalls.push([...deps]);
    const missing = deps.filter((name) => services[name] === undefined);
    if (missing.length > 0) {
      blockedInjects.push({ deps: [...deps], missing });
      return () => undefined;
    }
    const child = {
      logger: () => logger,
      effect: (inner, label) => ctx.effect(inner, label),
      on: (name, listener) => ctx.on(name, listener),
      get: (name) => services[name] ?? undefined,
    };
    for (const name of deps) child[name] = services[name];
    callback(child, {});
    return () => undefined;
  },
};

const module = await import(pathToFileURL(PLUGIN).href);

import { check, finish } from './_harness.mjs';

check('exports apply', typeof module.apply === 'function');
check('exports Config', module.Config !== undefined);
check('declares no hard inject', module.inject === undefined);
check('Config validates to defaults', (() => {
  const result = module.Config['~standard'].validate({});
  return result.value.synthesizeEveryTurns === 1 && result.value.turnSynthesisDelayMs === 3000 && result.value.limits.perUserMessage === 6000;
})());

module.apply(ctx, { dataDir, backfillOnStart: false });

// Let the asynchronous initialization settle.
await new Promise((resolve) => setTimeout(resolve, 400));

// The plugin must gate registration on the services it needs, because it
// activates before they are provided (a real boot proved this).
const gated = injectCalls.map((deps) => deps.join('+')).sort();
check('gates registration on systemPrompt', gated.includes('systemPrompt'), gated);
check('gates registration on tools', gated.includes('tools'), gated);
check('gates registration on webServer', gated.includes('webServer'), gated);
check('nothing was blocked when every service exists', blockedInjects.length === 0, blockedInjects);
check('registers four tools', tools.length === 4, tools.map((tool) => tool.name));
check('tool names avoid collisions', tools.every((tool) => tool.name.startsWith('portrait_')), tools.map((tool) => tool.name));
check('every tool carries an output renderer', tools.every((tool) => typeof tool.output?.render === 'function'));
let schemaIssues = [];
for (const tool of tools) {
  if (typeof tool.parameters !== 'object' || tool.parameters === null) schemaIssues.push(`${tool.name}: no parameters`);
  if (tool.parameters?.type !== 'object') schemaIssues.push(`${tool.name}: parameters root is not an object`);
  if (typeof tool.execute !== 'function') schemaIssues.push(`${tool.name}: no execute`);
  for (const [key, spec] of Object.entries(tool.parameters?.properties ?? {})) {
    if (typeof spec?.type !== 'string') schemaIssues.push(`${tool.name}.${key}: missing type`);
    if (Object.hasOwn(spec ?? {}, 'required')) schemaIssues.push(`${tool.name}.${key}: uses the unsupported nested required flag`);
  }
  for (const key of tool.parameters?.required ?? []) {
    if (!Object.hasOwn(tool.parameters?.properties ?? {}, key)) schemaIssues.push(`${tool.name}: required names undeclared "${key}"`);
  }
}
check('tool schemas are well formed', schemaIssues.length === 0, schemaIssues);
check('strict schemas were accepted by the real checker', tools.length === 4, tools.length);
check('registers one prompt section', sections.length === 1, sections.map((section) => section.name));
check('section order is within the built-in range', sections[0]?.order > 5000 && sections[0]?.order < 9900, sections[0]?.order);
check('registers one HTTP route', routes.length === 1 && routes[0].path === '/api/user-portrait', routes.map((route) => route.path));
check('listens to session events', listeners.some((entry) => entry.name === 'session/event'), listeners.map((entry) => entry.name));
check('listens to inbox inserts', listeners.some((entry) => entry.name === 'agent/inbox/inserted'));
check('registers effects with labels', effects.every((label) => typeof label === 'string' && label.startsWith('user-portrait')), effects);

check('the prompt section exposes a synchronous text provider', typeof sections[0].text === 'function');


check('creates the data directory', existsSync(dataDir));
const files = existsSync(dataDir) ? await readdir(dataDir) : [];
check('creates the layout subdirectories', ['turns', 'sessions', 'views'].every((name) => files.includes(name)), files);
check('writes no profile before evidence exists', !files.includes('profile.json'), files);

// Exercise the registered tools the way the agent would.
const readTool = tools.find((tool) => tool.name === 'portrait_read');
const readResult = await readTool.execute({}, {});
check('portrait_read answers before any evidence', typeof readResult.text === 'string' && readResult.activeEntries === 0, readResult);

const historyTool = tools.find((tool) => tool.name === 'portrait_history');
const historyResult = await historyTool.execute({}, {});
check('portrait_history answers on an empty store', historyResult.sessions === 0 && historyResult.text.includes('还没有'), historyResult.text?.slice(0, 80));

const searchTool = tools.find((tool) => tool.name === 'portrait_search');
const searchResult = await searchTool.execute({ query: 'nothing' }, {});
check('portrait_search handles no matches', searchResult.matches === 0);

const maintainTool = tools.find((tool) => tool.name === 'portrait_maintain');
const noteResult = await maintainTool.execute({ action: 'addNote', text: '测试备注' }, {});
check('portrait_maintain writes a user note', noteResult.ok === true, noteResult);
// The tool advertises the current ids plus the retired ones, so a legacy id must
// still land in the merged dimension rather than being dropped.
const entryResult = await maintainTool.execute({ action: 'addEntry', dimension: 'tech', text: '主要使用 Windows' }, {});
check('portrait_maintain adds a manual entry through a retired id', entryResult.ok === true, entryResult);
const afterWrite = await readTool.execute({}, {});
check('manual entry reaches the profile', afterWrite.activeEntries === 1 && afterWrite.text.includes('主要使用 Windows'), afterWrite);

const profileOnDisk = JSON.parse(await readFile(join(dataDir, 'profile.json'), 'utf8'));
check(
  'a retired id lands in its merged dimension',
  profileOnDisk.dimensions.skill?.length === 1 && profileOnDisk.dimensions.tech === undefined,
  Object.keys(profileOnDisk.dimensions ?? {}),
);
check('profile keeps the note', profileOnDisk.notes.length === 1, profileOnDisk.notes);
check('manual entries are marked', profileOnDisk.dimensions.skill[0].manual === true);
const markdown = await readFile(join(dataDir, 'profile.md'), 'utf8');
check(
  'markdown twin renders the group and dimension sections',
  markdown.includes('# 技术画像') && markdown.includes('## 能力与技术栈'),
  markdown.slice(0, 240),
);
check('markdown twin renders the entry', markdown.includes('主要使用 Windows'), markdown.slice(0, 200));

const badResult = await maintainTool.execute({ action: 'nonsense' }, {});
check('unknown maintenance action fails loudly', badResult.ok === false && badResult.text.includes('未知 action'), badResult);

// The HTTP route must serve the same operations.
const http = routes[0].handler;
const request = { method: 'GET', url: '/api/user-portrait?view=snapshot' };
let sent = undefined;
const response = {
  statusCode: 0,
  setHeader: () => undefined,
  end: (body) => {
    sent = body;
  },
};
await http(request, response);
const snapshot = JSON.parse(sent ?? '{}');
check('HTTP snapshot succeeds', response.statusCode === 200 && snapshot.ok === true, response.statusCode);
check('snapshot carries the nine dimensions', snapshot.dimensions?.length === 9, snapshot.dimensions?.length);
check('snapshot carries the two groups', snapshot.groups?.length === 2, snapshot.groups?.length);
check('snapshot carries progress', typeof snapshot.progress?.evidence === 'number', snapshot.progress);
check('snapshot carries the data directory', snapshot.dataDir === dataDir);

// The browser half's self-report channel: it is how a blank pane leaves a trace.
const reportBody = JSON.stringify({ action: 'report', report: { stage: 'apply', bodyKey: PLUGIN_ID, failures: [] } });
const reportRequest = {
  method: 'POST',
  url: '/api/user-portrait',
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(reportBody, 'utf8');
  },
};
let reportSent = undefined;
const reportResponse = {
  statusCode: 0,
  setHeader: () => undefined,
  end: (body) => {
    reportSent = body;
  },
};
await http(reportRequest, reportResponse);
const reportAck = JSON.parse(reportSent ?? '{}');
check('HTTP accepts a client self-report', reportResponse.statusCode === 200 && reportAck.ok === true, reportAck);
const storedReport = JSON.parse(await readFile(join(dataDir, 'client-report.json'), 'utf8'));
check(
  'the self-report is stored where the reader looks for it',
  storedReport.reports?.length === 1 && storedReport.reports[0].stage === 'apply',
  storedReport,
);
let reportRead = undefined;
const reportReadResponse = {
  statusCode: 0,
  setHeader: () => undefined,
  end: (body) => {
    reportRead = body;
  },
};
await http({ method: 'GET', url: '/api/user-portrait?view=report' }, reportReadResponse);
const reportView = JSON.parse(reportRead ?? '{}');
check(
  'the stored self-report is readable over the route',
  reportView.ok === true && reportView.reports?.length === 1 && reportView.dataDir === dataDir,
  reportView,
);
check('a report without a body is rejected', await (async () => {
  let rejected = undefined;
  const bare = {
    method: 'POST',
    url: '/api/user-portrait',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ action: 'report' }), 'utf8');
    },
  };
  const bareResponse = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (body) => {
      rejected = body;
    },
  };
  await http(bare, bareResponse);
  return bareResponse.statusCode === 400 && JSON.parse(rejected ?? '{}').ok === false;
})());

// --- addressing an entry by id -------------------------------------------------
// The panel renders a snapshot and holds the ids it saw. Synthesis runs in the
// background and merges entries, which used to shift the array positions those
// ids were built from: the click then failed with
// `没有找到 id 为 friction:8:… 的条目`. Ids are text-derived now, and a stale id
// still resolves through the row's own text.
/** POST one panel mutation through the real route. */
/** GET one panel view through the registered route. */
async function httpGet(url) {
  let payload;
  await http(
    { method: 'GET', url },
    {
      statusCode: 0,
      setHeader: () => undefined,
      end: (body) => {
        payload = body;
      },
    },
  );
  return JSON.parse(payload ?? '{}');
}
async function post(body) {
  let sent;
  await http(
    {
      method: 'POST',
      url: '/api/user-portrait',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body), 'utf8');
      },
    },
    {
      statusCode: 0,
      setHeader: () => undefined,
      end: (payload) => {
        sent = payload;
      },
    },
  );
  return JSON.parse(sent ?? '{}');
}

/** Read the panel snapshot through the real route. */
// --- per-session switches gate the prompt section ------------------------------
// The default is OFF: a session sees nothing until the composer switch is turned on.
check(
  'a fresh session gets no portrait section by default',
  sections[0].text({ agent: { id: 'session-fresh' } }) === '',
  sections[0].text({ agent: { id: 'session-fresh' } }),
);
const modeDefault = await httpGet('/api/user-portrait?view=sessionMode&session=session-fresh');
check('the mode endpoint reports the default', modeDefault.mode?.enabled === false && modeDefault.mode?.daily === true && modeDefault.mode?.tech === true, modeDefault.mode);
const modeSet = await post({ action: 'update', op: 'setSessionMode', session: 'session-switched', enabled: true, tech: false });
check('turning the switch on succeeds', modeSet.ok === true && modeSet.mode?.enabled === true && modeSet.mode?.tech === false, modeSet);
const modeRead = await httpGet('/api/user-portrait?view=sessionMode&session=session-switched');
check('the mode round-trips through the Host', modeRead.mode?.enabled === true && modeRead.mode?.tech === false, modeRead.mode);
check(
  'the mode is persisted in state.json',
  JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')).sessionModes?.['session-switched']?.tech === false,
);
const switchedText = sections[0].text({ agent: { id: 'session-switched' } });
check('an enabled session gets the portrait section', typeof switchedText === 'string' && switchedText.includes('人物画像'), switchedText.slice(0, 80));
check('a disabled group is not even mentioned', !switchedText.includes('技术画像'), switchedText);
await post({ action: 'update', op: 'setSessionMode', session: 'session-both', enabled: true, daily: true, tech: true });
const bothText = sections[0].text({ agent: { id: 'session-both' } });
check(
  'enabling both groups mentions both of them',
  bothText.includes('日常画像') && bothText.includes('技术画像'),
  bothText,
);
check(
  'a subagent inherits its parent session switch',
  sections[0].text({ agent: { id: 'session-child', session: { header: { parentSession: 'session-switched' } } } }).includes('人物画像'),
);
async function snapshotNow() {
  let sent;
  await http(
    { method: 'GET', url: '/api/user-portrait?view=snapshot' },
    {
      statusCode: 0,
      setHeader: () => undefined,
      end: (payload) => {
        sent = payload;
      },
    },
  );
  return JSON.parse(sent ?? '{}').profile;
}

/** The whole snapshot payload (profile plus caps, blacklist and feedback URL). */
async function snapshotPayloadNow() {
  let sent;
  await http(
    { method: 'GET', url: '/api/user-portrait?view=snapshot' },
    {
      statusCode: 0,
      setHeader: () => undefined,
      end: (payload) => {
        sent = payload;
      },
    },
  );
  return JSON.parse(sent ?? '{}');
}

check('a manual friction entry is accepted', (await post({ action: 'update', op: 'addEntry', dimension: 'friction', text: '不要用 iframe 方案' })).ok === true);
const firstSnapshot = await snapshotNow();
const firstId = firstSnapshot.dimensions.friction[0]?.id;
check('the snapshot addresses the entry by a text-derived id', /^friction:[0-9a-z]+$/.test(String(firstId)), firstId);

// A background merge can insert a row ahead of it — exactly what shifted the old
// positional ids.
check('a second friction entry is accepted', (await post({ action: 'update', op: 'addEntry', dimension: 'friction', text: '明确不喜欢被反复追问细节' })).ok === true);
const mergedList = (await snapshotNow()).dimensions.friction;
check('the list grew, so positions shifted', mergedList.length === 2, mergedList.map((entry) => entry.text));
check(
  'the id captured before the merge still addresses its own entry',
  mergedList.some((entry) => entry.id === firstId && entry.text === '不要用 iframe 方案'),
  mergedList.map((entry) => entry.id),
);
check('retiring by that id succeeds', (await post({ action: 'update', op: 'setStatus', id: firstId, status: 'retired' })).ok === true);
check(
  'a positional id from an older build is recovered through the row text',
  (
    await post({
      action: 'update',
      op: 'setStatus',
      id: 'friction:8:1792162973811',
      matchText: '明确不喜欢被反复追问细节',
      status: 'retired',
    })
  ).ok === true,
);
check(
  'an id that matches nothing still fails loudly',
  (await post({ action: 'update', op: 'setStatus', id: 'friction:0:0', status: 'retired' })).ok === false,
);

// --- 删除 moves the entry to the 废弃 area instead of erasing it ----------------
check('the first friction entry can be restored to active', (await post({ action: 'update', op: 'setStatus', id: firstId, status: 'active' })).ok === true);
check('deleting an entry succeeds', (await post({ action: 'update', op: 'removeEntry', id: firstId, matchText: '不要用 iframe 方案' })).ok === true);
const afterDelete = (await snapshotNow()).dimensions.friction;
const deleted = afterDelete.find((entry) => entry.id === firstId);
check('a deleted entry is NOT erased', deleted !== undefined, afterDelete.map((entry) => entry.text));
check('a deleted entry becomes retired', deleted?.status === 'retired', deleted?.status);
check('a deleted entry records when it was deleted', Number.isFinite(deleted?.deletedAt), deleted?.deletedAt);
check(
  'the other entry is untouched by the delete',
  afterDelete.some((entry) => entry.text === '明确不喜欢被反复追问细节' && entry.deletedAt === undefined),
  afterDelete.map((entry) => [entry.text, entry.status, entry.deletedAt === undefined]),
);
// Restoring clears the delete mark so the row is a normal conclusion again.
check('restoring a deleted entry succeeds', (await post({ action: 'update', op: 'setStatus', id: firstId, status: 'active' })).ok === true);
const restored = (await snapshotNow()).dimensions.friction.find((entry) => entry.id === firstId);
check('a restored entry is active again', restored?.status === 'active', restored?.status);
check('restoring clears the delete mark', restored?.deletedAt === undefined, restored?.deletedAt);

// --- permanent deletion (the 废弃 area's 删除) ---------------------------------
// Two conclusions are created that quote the SAME turn: purging one must not take
// the other one's evidence with it, and the removal must leave an audit line.
const sharedSession = 'session-shared-1';
const sharedRow = (text, source) => ({
  kind: 'dimension',
  dimension: 'interests',
  sessionId: sharedSession,
  turn: 1,
  text,
  source,
  statement: 'user',
  confidence: 'medium',
  at: Date.now(),
});
await appendFile(join(dataDir, 'evidence.jsonl'), `${[sharedRow('喜欢玩 galgame', '喜欢玩 galgame'), sharedRow('对病娇题材有兴趣', '对病娇题材有兴趣')].map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
check('a shared-evidence entry is created', (await post({ action: 'update', op: 'addEntry', dimension: 'interests', text: '喜欢玩 galgame' })).ok === true);
check('a second entry quoting the same turn is created', (await post({ action: 'update', op: 'addEntry', dimension: 'interests', text: '对病娇题材有兴趣' })).ok === true);

// Point both at the shared turn so the "other conclusion still cites it" rule has
// something to protect.
const listBefore = (await snapshotNow()).dimensions.interests;
const galgameId = listBefore.find((entry) => entry.text === '喜欢玩 galgame')?.id;
const yandereId = listBefore.find((entry) => entry.text === '对病娇题材有兴趣')?.id;
let profileRaw = JSON.parse(await readFile(join(dataDir, 'profile.json'), 'utf8'));
for (const entry of profileRaw.dimensions.interests) {
  if (entry.text === '喜欢玩 galgame' || entry.text === '对病娇题材有兴趣') {
    entry.sources = [{ sessionId: sharedSession, turn: 1 }];
  }
}
await writeFile(join(dataDir, 'profile.json'), `${JSON.stringify(profileRaw, null, 2)}\n`, 'utf8');

const beforePurge = await snapshotNow();
const beforeRows = (await readFile(join(dataDir, 'evidence.jsonl'), 'utf8')).split('\n').filter(Boolean).length;
const purgeReply = await post({ action: 'update', op: 'purgeEntry', id: galgameId, matchText: '喜欢玩 galgame' });
check('purging an entry succeeds', purgeReply.ok === true, purgeReply);
check('purging removes the entry itself', !(await snapshotNow()).dimensions.interests.some((entry) => entry.id === galgameId));
check('the neighbouring conclusion survives', (await snapshotNow()).dimensions.interests.some((entry) => entry.id === yandereId));
check(
  'shared evidence is NOT removed',
  (await readFile(join(dataDir, 'evidence.jsonl'), 'utf8')).split('\n').filter(Boolean).length === beforeRows,
  { before: beforeRows, after: (await readFile(join(dataDir, 'evidence.jsonl'), 'utf8')).split('\n').filter(Boolean).length },
);
check('the purge wrote an audit line', existsSync(join(dataDir, 'deleted.log')));
const auditLine = JSON.parse((await readFile(join(dataDir, 'deleted.log'), 'utf8')).trim().split('\n').at(-1));
check('the audit line names the deleted conclusion', auditLine.text === '喜欢玩 galgame', auditLine);
check('the audit line records the shared evidence it kept', auditLine.sharedEvidenceKept >= 1, auditLine);

// An entry whose turn nothing else cites takes its evidence with it.
const soloSession = 'session-solo-1';
const soloRow = {
  kind: 'dimension',
  dimension: 'interests',
  sessionId: soloSession,
  turn: 2,
  text: '长期关注 CTF 与漏洞复现',
  source: '长期关注 CTF 与漏洞复现',
  statement: 'user',
  confidence: 'medium',
  at: Date.now(),
};
await appendFile(join(dataDir, 'evidence.jsonl'), `${JSON.stringify(soloRow)}\n`, 'utf8');
check('a solo-evidence entry is created', (await post({ action: 'update', op: 'addEntry', dimension: 'interests', text: '长期关注 CTF 与漏洞复现' })).ok === true);
const soloId = (await snapshotNow()).dimensions.interests.find((entry) => entry.text === '长期关注 CTF 与漏洞复现')?.id;
profileRaw = JSON.parse(await readFile(join(dataDir, 'profile.json'), 'utf8'));
for (const entry of profileRaw.dimensions.interests) {
  if (entry.text === '长期关注 CTF 与漏洞复现') entry.sources = [{ sessionId: soloSession, turn: 2 }];
}
await writeFile(join(dataDir, 'profile.json'), `${JSON.stringify(profileRaw, null, 2)}\n`, 'utf8');
const rowsBeforeSolo = (await readFile(join(dataDir, 'evidence.jsonl'), 'utf8')).split('\n').filter(Boolean).length;
const soloReply = await post({ action: 'update', op: 'purgeEntry', id: soloId, matchText: '长期关注 CTF 与漏洞复现' });
check('purging a solo entry succeeds', soloReply.ok === true, soloReply);
check('the solo entry is gone', !(await snapshotNow()).dimensions.interests.some((entry) => entry.id === soloId));
check(
  'its evidence row is removed with it',
  (await readFile(join(dataDir, 'evidence.jsonl'), 'utf8')).split('\n').filter(Boolean).length === rowsBeforeSolo - 1,
  { before: rowsBeforeSolo, after: (await readFile(join(dataDir, 'evidence.jsonl'), 'utf8')).split('\n').filter(Boolean).length },
);
check('purging an id that no longer exists fails loudly', (await post({ action: 'update', op: 'purgeEntry', id: soloId })).ok === false);
check('before-purge snapshot was taken', beforePurge.dimensions.interests.length > 0);

// --- conclusion budget + evidence blacklist over HTTP --------------------------
const afterPurgeSnapshot = await snapshotPayloadNow();
check(
  'the removed evidence is blacklisted',
  afterPurgeSnapshot.blacklist?.count >= 1,
  afterPurgeSnapshot.blacklist,
);
check(
  'the snapshot reports the default conclusion budget',
  afterPurgeSnapshot.caps?.total === 50 && afterPurgeSnapshot.caps?.mode === 'total',
  afterPurgeSnapshot.caps,
);
check(
  'the budget reports its usage and the manual count',
  Number.isFinite(afterPurgeSnapshot.caps?.usage?.total) && Number.isFinite(afterPurgeSnapshot.caps?.usage?.manual),
  afterPurgeSnapshot.caps?.usage,
);
check('an unset feedback URL is reported as empty', afterPurgeSnapshot.feedbackUrl === '', afterPurgeSnapshot.feedbackUrl);

const capReply = await post({ action: 'update', op: 'setEntryCap', cap: { mode: 'group', daily: 12, tech: 34, total: 46 } });
check('setting the budget succeeds', capReply.ok === true, capReply);
const cappedSnapshot = await snapshotPayloadNow();
check(
  'the budget keeps the chosen mode and numbers',
  cappedSnapshot.caps?.mode === 'group' && cappedSnapshot.caps?.daily === 12 && cappedSnapshot.caps?.tech === 34,
  cappedSnapshot.caps,
);
check(
  'the budget persists in the state file',
  JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')).entryCap?.tech === 34,
);

const blacklistFile = join(dataDir, 'blacklist.json');
check('the blacklist is stored on disk', existsSync(blacklistFile));
const clearReply = await post({ action: 'update', op: 'clearBlacklist' });
check('clearing the blacklist succeeds', clearReply.ok === true && clearReply.count === 0, clearReply);
check('the blacklist is empty afterwards', (await snapshotPayloadNow()).blacklist?.count === 0);

// --- retiring / restoring also drives the blacklist ---------------------------
const retireRow = {
  kind: 'dimension',
  dimension: 'interests',
  sessionId: 'session-retire-1',
  turn: 1,
  text: '喜欢慢慢读长篇小说',
  source: '喜欢慢慢读长篇小说',
  statement: 'user',
  confidence: 'medium',
  at: Date.now(),
};
await appendFile(join(dataDir, 'evidence.jsonl'), `${JSON.stringify(retireRow)}\n`, 'utf8');
check(
  'an entry is created for the retire test',
  (await post({ action: 'update', op: 'addEntry', dimension: 'interests', text: '喜欢慢慢读长篇小说' })).ok === true,
);
const retireId = (await snapshotNow()).dimensions.interests.find((entry) => entry.text === '喜欢慢慢读长篇小说')?.id;
check(
  'retiring it succeeds',
  (await post({ action: 'update', op: 'setStatus', id: retireId, status: 'retired' })).ok === true,
);
check(
  'a retired conclusion blacklists its evidence',
  (await snapshotPayloadNow()).blacklist?.count >= 1,
  (await snapshotPayloadNow()).blacklist,
);

check(
  'restoring it releases the evidence again',
  (await post({ action: 'update', op: 'setStatus', id: retireId, status: 'active' })).ok === true &&
    (await snapshotPayloadNow()).blacklist?.count === 0,
  (await snapshotPayloadNow()).blacklist,
);
// A retired conclusion also silences its TURN, so a reworded re-digest cannot
// resurrect it. Restoring takes the turn back out.
const retiredDoc = JSON.parse(await readFile(join(dataDir, 'blacklist.json'), 'utf8'));
check(
  'the derived layer pins the turn as well',
  (retiredDoc.turns ?? []).length === 0,
  retiredDoc.turns,
);
// The shared-evidence entry still carries sources, so it exercises the turn half.
const sourcedId = (await snapshotNow()).dimensions.interests.find((entry) => entry.text === '对病娇题材有兴趣')?.id;
await post({ action: 'update', op: 'setStatus', id: sourcedId, status: 'retired' });
const retiredAgain = JSON.parse(await readFile(join(dataDir, 'blacklist.json'), 'utf8'));
check(
  'a retired conclusion silences its own turn',
  (retiredAgain.turns ?? []).includes('session-shared-1#1'),
  retiredAgain.turns,
);
await post({ action: 'update', op: 'setStatus', id: sourcedId, status: 'active' });
check(
  'restoring releases that turn',
  !(JSON.parse(await readFile(join(dataDir, 'blacklist.json'), 'utf8')).turns ?? []).includes('session-shared-1#1'),
);

// --- one-click clear of the whole discard area --------------------------------
const doomedRow = {
  kind: 'dimension',
  dimension: 'interests',
  sessionId: 'session-doomed-1',
  turn: 1,
  text: '临时旧结论：只看画风',
  source: '临时旧结论：只看画风',
  statement: 'user',
  confidence: 'low',
  at: Date.now(),
};
await appendFile(join(dataDir, 'evidence.jsonl'), `${JSON.stringify(doomedRow)}\n`, 'utf8');
check(
  'a doomed entry is created',
  (await post({ action: 'update', op: 'addEntry', dimension: 'interests', text: '临时旧结论：只看画风' })).ok === true,
);
const doomedId = (await snapshotNow()).dimensions.interests.find((entry) => entry.text === '临时旧结论：只看画风')?.id;
check(
  'it is retired first',
  (await post({ action: 'update', op: 'setStatus', id: doomedId, status: 'retired' })).ok === true,
);
const rowsBeforeClear = (await readFile(join(dataDir, 'evidence.jsonl'), 'utf8')).split('\n').filter(Boolean).length;
const clearDiscardReply = await post({ action: 'update', op: 'clearDiscard' });
check('clearing the discard area succeeds', clearDiscardReply.ok === true && clearDiscardReply.removed >= 1, clearDiscardReply);
check(
  'no non-active conclusion survives the clear',
  Object.values((await snapshotNow()).dimensions).every((list) => list.every((entry) => entry.status === 'active')),
);
check(
  'its evidence row is gone with it',
  (await readFile(join(dataDir, 'evidence.jsonl'), 'utf8')).split('\n').filter(Boolean).length === rowsBeforeClear - 1,
  { before: rowsBeforeClear, after: (await readFile(join(dataDir, 'evidence.jsonl'), 'utf8')).split('\n').filter(Boolean).length },
);
check(
  'the cleared rows stay blacklisted after the profile no longer mentions them',
  (await snapshotPayloadNow()).blacklist?.count >= 1,
  (await snapshotPayloadNow()).blacklist,
);
check('clearing an empty discard area is a no-op', (await post({ action: 'update', op: 'clearDiscard' })).removed === 0);

// --- timeline compaction over HTTP --------------------------------------------
// Three rows in a turn no conclusion cites, plus a preview/execute pair.
for (let index = 0; index < 3; index += 1) {
  await appendFile(
    join(dataDir, 'evidence.jsonl'),
    `${JSON.stringify({
      kind: 'dimension',
      dimension: 'interests',
      sessionId: 'session-unused-1',
      turn: 1,
      text: `无人引用的证据 ${index}`,
      at: Date.now(),
    })}\n`,
    'utf8',
  );
}
const rowsBeforeCompact = (await readFile(join(dataDir, 'evidence.jsonl'), 'utf8')).split('\n').filter(Boolean).length;
const planPreview = await post({ action: 'maintain', op: 'timelinePlan' });
check(
  'the cleanup preview reports how much it would remove',
  planPreview.ok === true && planPreview.stats.rows === rowsBeforeCompact && planPreview.stats.removedRows >= 3,
  planPreview.stats,
);
check(
  'the preview writes nothing',
  (await readFile(join(dataDir, 'evidence.jsonl'), 'utf8')).split('\n').filter(Boolean).length === rowsBeforeCompact,
);
const compactReply = await post({ action: 'maintain', op: 'compactTimeline' });
check('compacting the timeline succeeds', compactReply.ok === true && compactReply.removed >= 3, compactReply);
check(
  'the unused rows are gone from the ledger',
  !(await readFile(join(dataDir, 'evidence.jsonl'), 'utf8')).includes('无人引用的证据'),
);
check('the ledger was backed up before the rewrite', existsSync(`${join(dataDir, 'evidence.jsonl')}.before-timeline-compaction`));
check(
  'the compaction is recorded in deleted.log',
  JSON.parse((await readFile(join(dataDir, 'deleted.log'), 'utf8')).trim().split('\n').at(-1)).action === 'compactTimeline',
);
check('a second compaction has nothing to remove', (await post({ action: 'maintain', op: 'compactTimeline' })).removed === 0);
// --- manual confidence ignores the basis ceiling -------------------------------
{
  const doc = JSON.parse(await readFile(join(dataDir, 'profile.json'), 'utf8'));
  doc.dimensions.skill = doc.dimensions.skill ?? [];
  doc.dimensions.skill.push({
    text: '模型推断的技术结论，后来被手动升为高',
    statement: 'assistant',
    confidence: 'low',
    status: 'active',
    sources: [],
    firstSeenAt: Date.now(),
    lastConfirmedAt: Date.now(),
  });
  await writeFile(join(dataDir, 'profile.json'), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  const rawEntry = (await snapshotNow()).dimensions.skill.find((entry) => entry.text === '模型推断的技术结论，后来被手动升为高');
  check('an inferred technical conclusion starts at low', rawEntry?.confidence === 'low', rawEntry?.confidence);
  await post({ action: 'update', op: 'setConfidence', matchText: '模型推断的技术结论，后来被手动升为高', confidence: 'high' });
  const raised = (await snapshotNow()).dimensions.skill.find((entry) => entry.text === '模型推断的技术结论，后来被手动升为高');
  check('a manual promotion to high survives the reload', raised?.confidence === 'high', raised?.confidence);
  check('and the entry is marked manual', raised?.manual === true, raised?.manual);
}
// --- compaction and purge must both feed the blacklist -------------------------
const afterCompact = JSON.parse(await readFile(join(dataDir, 'blacklist.json'), 'utf8'));
check(
  'a compaction pins the rows it removed',
  (afterCompact.pinnedKeys ?? []).length > 0,
  afterCompact.pinnedKeys?.length,
);
check(
  'a compaction pins orphaned turns',
  (afterCompact.pinnedTurns ?? []).length > 0,
  afterCompact.pinnedTurns,
);

// A conclusion whose ledger rows are already gone must still pin its turn: this is
// the case that left the real blacklist with three entries after 50 deletions.
const ghostProfile = JSON.parse(await readFile(join(dataDir, 'profile.json'), 'utf8'));
ghostProfile.dimensions.interests = ghostProfile.dimensions.interests ?? [];
ghostProfile.dimensions.interests.push({
  text: '只有来源、账本已无对应行的结论',
  status: 'active',
  statement: 'user',
  confidence: 'medium',
  sources: [{ sessionId: 'session-ghost-1', turn: 7 }],
  firstSeenAt: Date.now(),
  lastConfirmedAt: Date.now(),
});
await writeFile(join(dataDir, 'profile.json'), JSON.stringify(ghostProfile, null, 2) + '\n', 'utf8');
const ghostId = (await snapshotNow()).dimensions.interests.find((entry) => entry.text === '只有来源、账本已无对应行的结论')?.id;
const ghostPurge = await post({ action: 'update', op: 'purgeEntry', id: ghostId, matchText: '只有来源、账本已无对应行的结论' });
check('a rowless purge still succeeds', ghostPurge.ok === true && ghostPurge.removedEvidence === 0, ghostPurge);
check(
  'a rowless purge pins the conclusion turn',
  (JSON.parse(await readFile(join(dataDir, 'blacklist.json'), 'utf8')).pinnedTurns ?? []).includes('session-ghost-1#7'),
  JSON.parse(await readFile(join(dataDir, 'blacklist.json'), 'utf8')).pinnedTurns,
);
// --- the adjustable character limit over HTTP ---------------------------------
const charCap = await post({ action: 'update', op: 'setEntryCap', cap: { mode: 'total', total: 50, daily: 20, tech: 30, charLimit: 12 } });
check('a character limit can be saved', charCap.ok === true && charCap.cap?.charLimit === 12, charCap);
check(
  'the character limit is persisted',
  JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')).entryCap?.charLimit === 12,
);
check('a runaway value is clamped at the boundary', (await post({ action: 'update', op: 'setEntryCap', cap: { charLimit: 9999 } })).cap?.charLimit === 500);
await post({ action: 'update', op: 'setEntryCap', cap: { mode: 'total', total: 50, daily: 20, tech: 30, charLimit: 12 } });
const longManual = '这是一条用来验证字数上限是否被正确截断的很长很长的手动结论';
await post({ action: 'update', op: 'addEntry', dimension: 'interests', text: longManual });
const clampedEntry = (await snapshotNow()).dimensions.interests.find((entry) => entry.text.startsWith('这是一条用来验证'));
check('a manual entry is clamped to the configured limit', clampedEntry !== undefined && clampedEntry.text.length <= 12, clampedEntry?.text);

await new Promise((resolve) => setTimeout(resolve, 100));
await rm(dataDir, { recursive: true, force: true });

// ---------------------------------------------------------------- scenario 2
// A real boot provides `tools` and `webServer` LATER than this plugin activates.
// Modelled here by starting the plugin with those services absent and then
// handing them over, which is what `ctx.inject` exists to handle.
const lateDir = await mkdtemp(join(tmpdir(), 'portrait-late-'));
const lateServices = {
  systemPrompt: services.systemPrompt,
  // `tools` and `webServer` are deliberately missing at first.
};
const lateBlocked = [];
const lateTools = [];
const lateRoutes = [];
const lateChild = (deps, callback) => {
  const missing = deps.filter((name) => lateServices[name] === undefined);
  if (missing.length > 0) {
    lateBlocked.push({ deps: [...deps], missing });
    return;
  }
  const child = { get: (name) => lateServices[name], effect: (inner) => (typeof inner === 'function' ? inner() ?? (() => undefined) : () => undefined) };
  for (const name of deps) child[name] = lateServices[name];
  callback(child, {});
};
const lateCtx = {
  logger: () => logger,
  effect: (callback) => (typeof callback === 'function' ? callback() ?? (() => undefined) : () => undefined),
  on: () => () => undefined,
  get: (name) => lateServices[name],
  inject: (deps, callback) => lateChild(deps, callback),
};
const lateModule = await import(`${pathToFileURL(PLUGIN).href}?scenario=late`);
lateModule.apply(lateCtx, { dataDir: lateDir, backfillOnStart: false });
await new Promise((resolve) => setTimeout(resolve, 250));

const lateBlockedNames = [...new Set(lateBlocked.flatMap((entry) => entry.missing))].sort();
check('partial profile: plugin still activates', existsSync(lateDir));
check('partial profile: registration is deferred, not skipped', lateBlockedNames.join(',') === 'tools,webServer', lateBlockedNames);
check('partial profile: no tool is registered while tools is absent', lateTools.length === 0, lateTools.length);

// Now the services arrive, exactly as they do later in a real boot.
lateServices.tools = {
  register: (definition) => {
    assertSupportedJsonSchema(definition.output?.schema);
    lateTools.push(definition);
    return () => undefined;
  },
};
lateServices.webServer = { register: (route) => { lateRoutes.push(route); return () => undefined; } };
for (const entry of lateBlocked) lateChild(entry.deps, () => undefined);
// Re-run the deferred bodies through a fresh apply, which is how a real late
// service reaches an already-started child.
lateBlocked.length = 0;
const lateModule2 = await import(`${pathToFileURL(PLUGIN).href}?scenario=late2`);
lateModule2.apply(lateCtx, { dataDir: lateDir, backfillOnStart: false });
await new Promise((resolve) => setTimeout(resolve, 250));
check('partial profile: tools register once the service appears', lateTools.length === 4, lateTools.length);
check('partial profile: the panel route registers once webServer appears', lateRoutes.length === 1, lateRoutes.length);
check('partial profile: the panel path is correct', lateRoutes[0]?.path === '/api/user-portrait', lateRoutes[0]?.path);
check('partial profile: nothing remains blocked', lateBlocked.length === 0, lateBlocked);
await rm(lateDir, { recursive: true, force: true });

// ------------------------------------------------------- the live change stream
// The panel dropped its 20-second polling loop; it now learns about updates from
// this endpoint, which must stream one event per profile write and keep the
// connection open in between.
const { EventEmitter } = await import('node:events');
const { PortraitHttp } = await import(pathToFileURL(join(PLUGIN_ROOT, 'lib', 'ops.js')).href);

/** A res double that records everything written to the stream. */
function streamResponse() {
  const chunks = [];
  return {
    status: 0,
    headers: {},
    chunks,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    setHeader() {
      return undefined;
    },
    on() {
      return this;
    },
    end(body) {
      // `sendJson` sets statusCode directly and writes the body here.
      this.status = this.status || this.statusCode || 0;
      if (typeof body === 'string' && body !== '') chunks.push(body);
      return this;
    },
  };
}

const eventBus = new EventEmitter();
const streamOps = { version: async () => ({ updatedAt: 1234, entries: 7 }) };
const streamHttp = new PortraitHttp(streamOps, { events: eventBus });
const liveResponse = streamResponse();
await streamHttp.handle({ method: 'GET', url: '/api/user-portrait?view=stream', on() {} }, liveResponse);
check('the stream opens as an SSE response', liveResponse.status === 200, liveResponse.status);
check(
  'the stream sets the event-stream content type',
  String(liveResponse.headers['content-type'] ?? '').includes('text/event-stream'),
  liveResponse.headers,
);
check('the stream starts with a handshake', liveResponse.chunks.join('').includes('event: hello'), liveResponse.chunks);
check('the handshake carries the current version', liveResponse.chunks.join('').includes('"updatedAt":1234'), liveResponse.chunks);

eventBus.emit('profile', { updatedAt: 5678, entries: 8 });
const streamedBody = liveResponse.chunks.join('');
check('a profile write is pushed immediately', streamedBody.includes('event: profile'), streamedBody.slice(-160));
check('the pushed event carries the new version', streamedBody.includes('"updatedAt":5678'), streamedBody.slice(-160));

// Without an emitter the route must say so rather than hang the request.
const silentResponse = streamResponse();
await new PortraitHttp(streamOps).handle({ method: 'GET', url: '/api/user-portrait?view=stream', on() {} }, silentResponse);
check('streaming degrades to an explicit error', silentResponse.status === 503, silentResponse.status);

console.log('\n--- plugin log ---');
for (const line of logLines) console.log(`  ${line}`);
finish('HARNESS PASSED');
