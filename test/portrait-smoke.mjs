/**
 * Throwaway smoke test for the portrait extraction logic. Run with the bundled
 * Node binary; it touches no real data directory.
 */
import { blacklistForProfile, blacklistKeysForProfile, isBlacklisted, turnKey, buildSynthesisPrompt, planTimelineCompaction,
  selectSynthesisSource, enforceEntryCaps, filterBlacklisted, foldTurns, isDigestible, isSameConclusion, normalizeEntryCap, normalizeTurnDigest, mergeSynthesis, similarityScore, buildTurnPrompt, sourceIndexOf } from '../lib/extract.js';
import { AUTO_ENTRY_TEXT_LIMIT, clampConfidence, createProfile, ENTRY_TEXT_LIMIT, evidenceKey, normalizeProfile } from '../lib/schema.js';
import { scopesForDimensions } from '../lib/jobs.js';
import { enabledGroups, normalizeSessionMode, resolveSessionMode } from '../lib/session-modes.js';
import { parseJsonReply } from '../lib/prompts.js';
import { maskSecrets } from '../lib/redact.js';
import { dedupeTurns, renderProfileMarkdown } from '../lib/store.js';

import { check, finish } from './_harness.mjs';

const events = [
  { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 2,
    time: 1100,
    data: {
      // The user's own words must contain the quotes the digest will claim as
      // theirs, because the basis is now verified against this text.
      content: [{ type: 'text', text: '帮我写一个插件，提取画像，不要用 iframe 方案，主要用 Windows' }],
      source: { kind: 'user' },
    },
  },
  {
    type: 'user/message',
    seq: 3,
    time: 1150,
    data: {
      content: [{ type: 'text', text: 'plugin injected context' }],
      source: { kind: 'agent-instructions' },
    },
  },
  { type: 'tool/call', seq: 4, time: 1200, data: { name: 'read', arguments: '{}' } },
  {
    type: 'assistant/message',
    seq: 5,
    time: 1300,
    data: { message: { content: [{ type: 'text', text: '好的，我先看扩展点。' }] } },
  },
  { type: 'turn/end', seq: 6, time: 1400, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 7, time: 2000, data: { turn: 2 } },
  {
    type: 'user/message',
    seq: 8,
    time: 2100,
    data: { content: [{ type: 'text', text: '不要用 iframe' }], source: { kind: 'user' } },
  },
  { type: 'turn/end', seq: 9, time: 2400, data: { turn: 2, reason: { kind: 'interrupted' } } },
];

const turns = foldTurns(events);
check('folds two turns', turns.length === 2, turns.length);
check('turn 1 keeps only human text', turns[0].userTexts.length === 1 && turns[0].userTexts[0].includes('提取画像'), turns[0].userTexts);
check('turn 1 collects the answer', turns[0].assistantTexts[0].includes('扩展点'), turns[0].assistantTexts);
check('turn 1 records the tool', turns[0].toolNames.includes('read'), turns[0].toolNames);
check('turn 1 closes completed', turns[0].endReason === 'completed', turns[0].endReason);
check('turn 2 closes interrupted', turns[1].endReason === 'interrupted', turns[1].endReason);
check('every turn is digestible', turns.every((turn) => isDigestible(turn)));

const rawDigest = {
  userAsk: '要求做一个画像插件',
  userKeyPoints: ['要提取画像', '要能看图'],
  assistantSummary: '确认了扩展点并开始实现',
  outcome: '部分完成',
  corrections: [{ kind: '红线', text: '明确不要 iframe 方案' }],
  evidence: [
    { dimension: 'personality', statement: 'user', text: '偏好直接给结论', confidence: '高', source: '不要用 iframe' },
    { dimension: 'not-a-dimension', text: '应被丢弃', confidence: 'high' },
    { dimension: 'skill', text: '', confidence: 'high' },
    { dimension: 'skill', statement: 'user', text: '使用 api_key=sk-abcdefghijklmnopqrstuvwxyz 的脚本', confidence: 'medium' },
    // An inference drawn from the assistant's own words about a TECHNICAL
    // dimension: it cannot exceed `low`, whatever the model claims.
    { dimension: 'skill', statement: 'assistant', text: '看起来熟悉 PowerShell 管道', confidence: 'high', source: '我给你解释过管道' },
    // The same kind of inference about a DAILY dimension may reach `medium`.
    { dimension: 'interests', statement: 'assistant', text: '似乎对日式视觉小说有兴趣', confidence: 'high' },
    // Claims the user's words with no quote at all: nothing to trace, so demoted.
    { dimension: 'background', statement: 'user', text: '在一家游戏公司上班', confidence: 'high', source: '' },
    // No `statement` at all, even though the quote IS the user's. Silence must not
    // become "the user said this": the marker is required (fail closed).
    { dimension: 'workstyle', text: '偏好一次只改一个地方', confidence: 'high', source: '不要用 iframe 方案' },
  ],
};
const digest = normalizeTurnDigest(rawDigest, turns[0]);
check('drops unknown dimensions', digest.evidence.length === 6, digest.evidence.map((item) => item.text));
check('maps 高 to high for a user statement', digest.evidence[0].confidence === 'high', digest.evidence[0]);
check('a user statement is marked as such', digest.evidence[0].statement === 'user', digest.evidence[0].statement);
check('masks a leaked key', !digest.evidence[1].text.includes('sk-abcdefg'), digest.evidence[1].text);
const missingMarker = digest.evidence.find((item) => item.text.includes('一次只改一个地方'));
check('a missing statement marker is treated as a model inference', missingMarker?.statement === 'assistant', missingMarker);
check('the unmarked claim loses its confidence', missingMarker?.confidence === 'low', missingMarker?.confidence);
check('records the correction', digest.corrections.length === 1 && digest.corrections[0].kind === '红线');
// A correction is grounded by matching it to the user's own line, and that line
// becomes the recorded quote.
check('a grounded correction is kept as the user own words', digest.corrections[0].basis === 'user', digest.corrections[0]);
check('the grounded correction records the user line as its quote', digest.corrections[0].source.includes('iframe'), digest.corrections[0].source);
// The basis is verified, not trusted:
const noQuote = digest.evidence.find((item) => item.text.includes('游戏公司'));
check('a user claim with no quote is demoted', noQuote?.statement === 'assistant', noQuote);
// The policy is enforced here, not merely requested from the model:
const assistantTech = digest.evidence.find((item) => item.text.includes('PowerShell 管道'));
const assistantDaily = digest.evidence.find((item) => item.text.includes('视觉小说'));
check('an assistant claim about a technical dimension is capped at low', assistantTech?.confidence === 'low', assistantTech);
check('an assistant claim about a daily dimension may reach medium', assistantDaily?.confidence === 'medium', assistantDaily);
check(
  'the statement marker is recorded for every piece of evidence',
  digest.evidence.every((item) => item.statement === 'user' || item.statement === 'assistant'),
  digest.evidence.map((item) => item.statement),
);

const prompt = buildTurnPrompt({ sessionId: 'session-1', cwd: 'workspace', turn: turns[0] }, { perUserMessage: 5000, perAssistantTurn: 5000 });
check('prompt carries the session id', prompt.includes('session-1'));
check('prompt keeps human text', prompt.includes('提取画像'));
check('prompt excludes injected context', !prompt.includes('plugin injected context'));
check('prompt names the daily and technical catalog', prompt.includes('personality') && prompt.includes('boundary') && prompt.includes('日常画像'));

check('parses fenced JSON', parseJsonReply('```json\n{"a":1}\n```').a === 1);
check('parses prefixed JSON', parseJsonReply('Here you go:\n{"a":{"b":2}}\ndone').a.b === 2);
check('parses an array', Array.isArray(parseJsonReply('[1,2,3]')));
try {
  parseJsonReply('no json at all');
  check('throws without JSON', false);
} catch {
  check('throws without JSON', true);
}

const masked = maskSecrets('token: "abcdef123456" and password=hunter2xyz and sk-1234567890abcdefghij');
check('masks assigned secrets', !masked.includes('abcdef123456') && !masked.includes('hunter2xyz'), masked);
check('masks standalone keys', !masked.includes('sk-1234567890abcdefghij'), masked);

const previous = createProfile(1);
previous.dimensions.skill.push({
  text: '主要用 Windows',
  confidence: 'medium',
  status: 'active',
  sources: [{ sessionId: 's1', turn: 2 }],
  firstSeenAt: 10,
  lastConfirmedAt: 10,
});
previous.notes.push({ text: '我在做 X 项目', at: 5 });
const merged = mergeSynthesis(
  previous,
  {
    dimensions: {
      skill: [
        { text: '主要用 Windows', confidence: 'high', sources: [{ sessionId: 's2', turn: 7 }] },
        { text: '主要用 Windows 处理日常任务', confidence: 'medium', status: 'active', sources: [{ sessionId: 's2', turn: 8 }] },
        { text: '离不开 PowerShell', confidence: 'medium', status: 'active', sources: [{ sessionId: 's2', turn: 9 }] },
      ],
    },
  },
  100,
);
check('synthesis accepts entries', merged.report.accepted === true && merged.report.acceptedEntries === 3, merged.report);
// `主要用 Windows` (exact restatement) and `主要用 Windows 处理日常任务` (a refinement
// containing it) both fold into the stored row, which accumulates their sources
// and takes the stronger confidence. `离不开 PowerShell` names a different
// technology and correctly stays its own row — merging must not swallow distinct
// conclusions.
check(
  'restatements and refinements fold into the stored row',
  merged.profile.dimensions.skill.length === 2,
  merged.profile.dimensions.skill.map((entry) => entry.text),
);
const windowsEntry = merged.profile.dimensions.skill.find((entry) => entry.text.includes('Windows'));
const powerShellEntry = merged.profile.dimensions.skill.find((entry) => entry.text.includes('PowerShell'));
check('synthesis merges sources', windowsEntry.sources.length === 3, windowsEntry.sources);
check('synthesis raises confidence', windowsEntry.confidence === 'high', windowsEntry.confidence);
check('the refinement is kept in the merged text', windowsEntry.text.includes('处理日常任务'), windowsEntry.text);
check('a different technology stays a separate conclusion', powerShellEntry !== undefined && powerShellEntry.text !== windowsEntry.text);
check('the fold is reported', merged.report.combinedEntries === 2, merged.report);
check('synthesis keeps user notes', merged.profile.notes.length === 1);
check('synthesis fills every dimension', Object.keys(merged.profile.dimensions).length === 9);
check('the merged dimension keeps its id', merged.profile.dimensions.ability === undefined && merged.profile.dimensions.skill.length === 2);
const dropped = mergeSynthesis(previous, { dimensions: { skill: [] } }, 200);
check('dropped entries become history', dropped.profile.dimensions.skill[0].status === 'superseded', dropped.profile.dimensions.skill[0]);
check(
  'a retired dimension id folds into its merged dimension',
  normalizeProfile({ dimensions: { tech: [{ text: '主要用 Windows', confidence: 'high', status: 'active' }] } }).dimensions.skill.length === 1,
);

// Scoped (per-group) synthesis: a reply that carries one dimension must leave
// every other dimension exactly as it was. This is what lets the engine merge one
// small group per call instead of one whole-profile rewrite that overran the
// output budget.
const carryPrevious = createProfile(1);
carryPrevious.dimensions.skill.push({
  text: '主要用 Windows',
  confidence: 'high',
  status: 'active',
  sources: [{ sessionId: 's1', turn: 2 }],
  firstSeenAt: 10,
  lastConfirmedAt: 10,
});
carryPrevious.dimensions.friction.push({
  text: '不要用 iframe 方案',
  confidence: 'high',
  status: 'active',
  sources: [{ sessionId: 's1', turn: 3 }],
  firstSeenAt: 10,
  lastConfirmedAt: 10,
});
const scoped = mergeSynthesis(carryPrevious, { dimensions: { interests: [{ text: '玩 galgame，对病娇题材有兴趣', confidence: 'high', status: 'active' }] } }, 300);
check('a scoped merge accepts its own dimension', scoped.profile.dimensions.interests.length === 1, scoped.profile.dimensions.interests);
check('a scoped merge reports how many dimensions it covered', scoped.report.scoped === 1, scoped.report);
check(
  'a scoped merge leaves untouched dimensions intact, not superseded',
  scoped.profile.dimensions.skill.length === 1 &&
    scoped.profile.dimensions.skill[0].status === 'active' &&
    scoped.profile.dimensions.friction[0].status === 'active',
  { skill: scoped.profile.dimensions.skill, friction: scoped.profile.dimensions.friction },
);
check(
  'a scoped synthesis prompt names only its own dimension',
  (() => {
    const interestsDimension = [{ id: 'interests', label: '兴趣与爱好' }];
    const prompt = buildSynthesisPrompt(carryPrevious, [{ dimension: 'interests', text: '玩 galgame', confidence: 'high' }], interestsDimension);
    return prompt.includes('只合并这几个维度：interests（兴趣与爱好）') && !prompt.includes('### skill（');
  })(),
);

// The policy is enforced by the merge, not merely requested from the model: a
// reply claiming `high` still lands where its statement allows.
const assistantClaim = mergeSynthesis(
  createProfile(1),
  {
    dimensions: {
      skill: [{ text: '看起来会写 PowerShell 模块', statement: 'assistant', confidence: 'high', status: 'active' }],
      interests: [{ text: '似乎喜欢视觉小说', statement: 'assistant', confidence: 'high', status: 'active' }],
    },
  },
  400,
);
check(
  'a technical claim inferred from the reply is held at low even if the model says high',
  assistantClaim.profile.dimensions.skill[0].confidence === 'low',
  assistantClaim.profile.dimensions.skill[0],
);
check(
  'a daily claim inferred from the reply may reach medium but never high',
  assistantClaim.profile.dimensions.interests[0].confidence === 'medium',
  assistantClaim.profile.dimensions.interests[0],
);

// Merging the same conclusion from both bases: the user's own words win, and the
// merged entry is marked as theirs.
const bothBases = mergeSynthesis(
  createProfile(1),
  {
    dimensions: {
      interests: [{ text: '玩 galgame，对病娇题材有兴趣', statement: 'assistant', confidence: 'low', status: 'active', sources: [{ sessionId: 's9', turn: 1 }] }],
    },
  },
  500,
);
const mergedBasis = mergeSynthesis(
  bothBases.profile,
  {
    dimensions: {
      interests: [{ text: '玩 galgame，对病娇题材有兴趣', statement: 'user', confidence: 'high', status: 'active', sources: [{ sessionId: 's9', turn: 2 }] }],
    },
  },
  600,
);
check(
  'merging a user statement into an inference records BOTH bases',
  mergedBasis.profile.dimensions.interests[0].statement === 'mixed',
  mergedBasis.profile.dimensions.interests[0].statement,
);
check(
  'a mixed basis cannot borrow the confidence the user side claimed',
  mergedBasis.profile.dimensions.interests[0].confidence === 'medium',
  mergedBasis.profile.dimensions.interests[0].confidence,
);
check(
  'the merged entry keeps both sources',
  mergedBasis.profile.dimensions.interests[0].sources.length === 2,
  mergedBasis.profile.dimensions.interests[0].sources,
);

// Two user statements merge into `user`, not `mixed`: only a real mixture of bases
// produces the combined label.
const userOnly = mergeSynthesis(
  createProfile(1),
  {
    dimensions: {
      interests: [
        { text: '玩 galgame', statement: 'user', confidence: 'medium', status: 'active' },
        { text: '玩 galgame，对病娇题材有兴趣', statement: 'user', confidence: 'high', status: 'active' },
      ],
    },
  },
  700,
);
check(
  'two user statements stay a user basis',
  userOnly.profile.dimensions.interests.length === 1 && userOnly.profile.dimensions.interests[0].statement === 'user',
  userOnly.profile.dimensions.interests.map((entry) => [entry.text, entry.statement]),
);
check(
  'a user-only merge may reach high confidence',
  userOnly.profile.dimensions.interests[0].confidence === 'high',
  userOnly.profile.dimensions.interests[0].confidence,
);

// And in a technical dimension the mixed ceiling is `low`: part of it is inference.
const mixedTech = mergeSynthesis(
  createProfile(1),
  {
    dimensions: {
      skill: [
        { text: '熟练使用 PowerShell', statement: 'user', confidence: 'high', status: 'active' },
        { text: '熟练使用 PowerShell 管道编排', statement: 'assistant', confidence: 'low', status: 'active' },
      ],
    },
  },
  710,
);
check(
  'a mixed technical conclusion is capped at low',
  mixedTech.profile.dimensions.skill[0].statement === 'mixed' && mixedTech.profile.dimensions.skill[0].confidence === 'low',
  mixedTech.profile.dimensions.skill[0],
);

// A hand-written entry is exempt: the user's own choice of confidence stands.
const manualEntry = mergeSynthesis(
  createProfile(1),
  {
    dimensions: {
      skill: [
        {
          text: '我手动写下的一条技术结论',
          statement: 'assistant',
          confidence: 'high',
          status: 'active',
          manual: true,
        },
      ],
    },
  },
  700,
);
check(
  'a manual entry is not clamped by the statement policy',
  manualEntry.profile.dimensions.skill[0].confidence === 'high' && manualEntry.profile.dimensions.skill[0].manual === true,
  manualEntry.profile.dimensions.skill[0],
);

// An upgraded document (written before the marker existed) is treated as the
// user's own words and re-clamped, so nothing keeps a confidence it cannot earn.
const upgraded = normalizeProfile({
  dimensions: { skill: [{ text: '旧文档里的条目', confidence: 'high', status: 'active' }] },
});
check(
  'an entry from an older document defaults to the user and keeps its confidence',
  upgraded.dimensions.skill[0].statement === 'user' && upgraded.dimensions.skill[0].confidence === 'high',
  upgraded.dimensions.skill[0],
);
check(
  'a legacy entry marked assistant is clamped on load',
  normalizeProfile({ dimensions: { skill: [{ text: '旧的推断条目', statement: 'assistant', confidence: 'high' }] } }).dimensions.skill[0]
    .confidence === 'low',
);

const deduped = dedupeTurns([{ turn: 2, at: 1 }, { turn: 1, at: 2 }, { turn: 2, at: 3 }]);
check('dedupes turns to the newest', deduped.length === 2 && deduped[1].at === 3, deduped);

check('evidence keys are stable', evidenceKey({ kind: 'x', text: 'y' }) === evidenceKey({ kind: 'x', text: 'y' }));

const markdown = renderProfileMarkdown(merged.profile, [
  { id: 'personality', group: 'daily', label: '性格与沟通' },
  { id: 'skill', group: 'tech', label: '能力与技术栈' },
]);
check('markdown has the heading', markdown.startsWith('# 人物画像'));
check('markdown lists an active entry', markdown.includes('主要用 Windows'));
check('markdown titles the groups', markdown.includes('# 日常画像') && markdown.includes('# 技术画像') && markdown.indexOf('# 日常画像') < markdown.indexOf('# 技术画像'), markdown.slice(0, 400));
check('markdown hides retired entries behind details', markdown.includes('<details>') === false, markdown.slice(0, 400));

// --- merge-first synthesis ------------------------------------------------------
// The reported case: one session said both "喜欢玩 galgame" and "挑 galgame 看重剧情
// 质量", and they landed as TWO entries. Same topic, so they must be one.
const galgameA = '喜欢玩 galgame（日式视觉小说），尤其对病娇女主/病娇题材有兴趣';
const galgameB = '挑选 galgame 时看重剧情质量和制作水准，不只看题材是否对口';
check('the two galgame statements are recognised as one conclusion', isSameConclusion(galgameA, galgameB));
check('two unrelated statements are not merged', !isSameConclusion('喜欢先看结论再看推理', '明确不喜欢被反复追问细节'));
check('a shared term merges even across phrasings', isSameConclusion('偏好用 PowerShell 而不是 node', '用 PowerShell 处理文件操作更顺手'));

const splitReply = mergeSynthesis(
  createProfile(1),
  {
    dimensions: {
      interests: [
        { text: galgameA, statement: 'user', confidence: 'high', status: 'active', sources: [{ sessionId: 's1', turn: 1 }] },
        { text: galgameB, statement: 'user', confidence: 'medium', status: 'active', sources: [{ sessionId: 's1', turn: 2 }] },
      ],
    },
  },
  800,
);
const interestsMerged = splitReply.profile.dimensions.interests;
check('one reply about one topic yields ONE entry', interestsMerged.length === 1, interestsMerged.map((entry) => entry.text));
check(
  'the merged entry keeps the original conclusion',
  interestsMerged[0].text.includes('galgame（日式视觉小说）'),
  interestsMerged[0].text,
);
check(
  'the merged entry stays inside the 50-character budget',
  interestsMerged[0].text.length <= 50,
  interestsMerged[0].text.length,
);
check('the merged entry keeps both sources', interestsMerged[0].sources.length === 2, interestsMerged[0].sources);
check('merging takes the stronger confidence, not the weaker', interestsMerged[0].confidence === 'high', interestsMerged[0].confidence);
check('the merge is counted in the report', splitReply.report.combinedEntries === 1, splitReply.report);

const storedOne = mergeSynthesis(
  createProfile(1),
  { dimensions: { interests: [{ text: galgameA, statement: 'user', confidence: 'medium', status: 'active', sources: [{ sessionId: 's1', turn: 1 }] }] } },
  810,
);
const refolded = mergeSynthesis(
  storedOne.profile,
  { dimensions: { interests: [{ text: '喜欢玩日式视觉小说（galgame），偏爱病娇题材', statement: 'user', confidence: 'medium', status: 'active', sources: [{ sessionId: 's2', turn: 3 }] }] } },
  820,
);
check(
  'a rephrasing folds into the stored conclusion',
  refolded.profile.dimensions.interests.length === 1 && refolded.report.combinedEntries === 1,
  { entries: refolded.profile.dimensions.interests.length, report: refolded.report },
);
check(
  'the folded entry accumulates both sources',
  refolded.profile.dimensions.interests[0].sources.length === 2,
  refolded.profile.dimensions.interests[0].sources,
);

const distinct = mergeSynthesis(
  createProfile(1),
  {
    dimensions: {
      interests: [
        { text: galgameA, statement: 'user', confidence: 'high', status: 'active' },
        { text: '长期关注 CTF 与漏洞复现', statement: 'user', confidence: 'medium', status: 'active' },
      ],
    },
  },
  830,
);
check(
  'a different topic in the same dimension stays its own row',
  distinct.profile.dimensions.interests.length === 2,
  distinct.profile.dimensions.interests.map((entry) => entry.text),
);

// --- per-turn synthesis scope --------------------------------------------------
// One turn's evidence must fold only the dimensions it touched: the whole profile
// used to be rewritten on every synthesis (five model calls), which per-turn
// triggering would multiply by every turn.
const dailyScope = scopesForDimensions(['interests']);
check(
  'one touched daily dimension becomes one small call',
  dailyScope.length === 1 && dailyScope[0].map((dimension) => dimension.id).join(',') === 'interests',
  dailyScope.map((scope) => scope.map((dimension) => dimension.id)),
);
const mixedScope = scopesForDimensions(['interests', 'focus', 'skill', 'boundary']);
check(
  'daily dimensions share one call and each technical dimension gets its own',
  mixedScope.length === 3 &&
    mixedScope[0].every((dimension) => dimension.group === 'daily') &&
    mixedScope.slice(1).every((scope) => scope.length === 1 && scope[0].group === 'tech'),
  mixedScope.map((scope) => scope.map((dimension) => dimension.id)),
);
check('an untouched dimension is never called', !mixedScope.flat().some((dimension) => dimension.id === 'sessions'));
check('unknown ids are ignored', scopesForDimensions(['nope']).length === 0);
check('an empty set produces no call at all', scopesForDimensions([]).length === 0);

// --- conclusion budget --------------------------------------------------------
// The cap answers two questions: how related are two conclusions (0–1), and what
// happens when the portrait is full.
check('identical conclusions are fully related', similarityScore('喜欢玩 galgame', '喜欢玩 galgame') === 1);
check('containment counts as strongly related', similarityScore('主要用 Windows', '主要用 Windows 处理日常任务') === 0.8);
check(
  'a shared proper noun keeps the two sides above the fold threshold',
  similarityScore('喜欢玩 galgame', '挑选 galgame 看重剧情质量') >= 0.5,
  similarityScore('喜欢玩 galgame', '挑选 galgame 看重剧情质量'),
);
check('unrelated conclusions score near zero', similarityScore('主要用 Windows', '周末喜欢爬山') < 0.5);
check(
  'everything isSameConclusion accepts also scores at least 0.5',
  [
    ['喜欢玩 galgame', '喜欢玩 galgame'],
    ['主要用 Windows', '主要用 Windows 处理日常任务'],
    ['要求把 VNDB 标签分开分级', '要求把 2DFan 标签分开分级'],
    ['先备份再改配置', '改完要验证结果'],
  ].every(([left, right]) => !isSameConclusion(left, right) || similarityScore(left, right) >= 0.5),
);
check(
  'the cap document falls back to the documented defaults',
  JSON.stringify(normalizeEntryCap(undefined)) === JSON.stringify({ mode: 'total', total: 50, daily: 20, tech: 30, effective: 50, charLimit: 50 }),
  normalizeEntryCap(undefined),
);
check('an unknown cap mode becomes the total mode', normalizeEntryCap({ mode: 'nonsense' }).mode === 'total');
check('negative numbers are replaced, not clamped to zero', normalizeEntryCap({ total: -5 }).total === 50);

/** Build a profile whose interests dimension holds `count` unrelated entries. */
const unrelatedTexts = ['主要用 Windows 做日常开发', '周末喜欢爬山和拍照', '偏好 TypeScript 而非 JS', '硬科幻小说读得多'];
const cappedProfile = (count, extra = {}) => ({
  dimensions: {
    interests: Array.from({ length: count }, (_, index) => ({
      text: unrelatedTexts[index] ?? `补充结论${index}`,
      status: 'active',
      statement: 'user',
      confidence: 'medium',
      sources: [],
      lastConfirmedAt: index,
      ...(extra[index] ?? {}),
    })),
  },
});
// The effective ceiling is max(unified, daily+tech), so a narrow unified number is
// never the real limit on its own.
const capModes = enforceEntryCaps(cappedProfile(4), { mode: 'total', total: 3, daily: 20, tech: 30 });
check('a narrow unified total does not lower the ceiling below the groups', capModes.profile.dimensions.interests.length === 4, capModes.profile.dimensions.interests.length);
const capTotal = enforceEntryCaps(cappedProfile(4), { mode: 'total', total: 3, daily: 1, tech: 2 });
check('an over-cap portrait loses the extra entry', capTotal.profile.dimensions.interests.length === 3, capTotal.profile.dimensions.interests.length);
check('the dropped entry is reported', capTotal.dropped.length === 1, capTotal.dropped);
check(
  'an entry with no related sibling is dropped rather than folded',
  capTotal.merged.length === 0 && capTotal.dropped[0].bestScore < 0.5,
  capTotal.dropped,
);

const relatedProfile = cappedProfile(2);
relatedProfile.dimensions.interests[0].text = '喜欢玩 galgame';
relatedProfile.dimensions.interests[1].text = '喜欢玩 galgame，尤其病娇题材';
const capMerged = enforceEntryCaps(relatedProfile, { mode: 'total', total: 1, daily: 0, tech: 1 });
check('an over-cap entry folds into the most related conclusion', capMerged.merged.length === 1, capMerged.merged);
check('the fold reports its score', capMerged.merged[0].score >= 0.5, capMerged.merged[0]);

const manualProfile = cappedProfile(3);
manualProfile.dimensions.interests.push({ text: '手写结论', status: 'active', manual: true, sources: [] });
const capManual = enforceEntryCaps(manualProfile, { mode: 'total', total: 3, daily: 1, tech: 2 });
check('manual conclusions do not count toward the cap', capManual.profile.dimensions.interests.length === 4, capManual.profile.dimensions.interests.length);
check('manual conclusions are never merged away', capManual.profile.dimensions.interests.some((entry) => entry.text === '手写结论'));

const groupProfile = {
  dimensions: {
    interests: Array.from({ length: 3 }, (_, index) => ({ text: `日常${index}`, status: 'active', statement: 'user', sources: [], lastConfirmedAt: index })),
    skill: Array.from({ length: 2 }, (_, index) => ({ text: `技术${index}`, status: 'active', statement: 'user', sources: [], lastConfirmedAt: index })),
  },
};
const capGroup = enforceEntryCaps(groupProfile, { mode: 'group', total: 50, daily: 2, tech: 30 });
check('group mode only trims the group that is over', capGroup.profile.dimensions.interests.length === 2 && capGroup.profile.dimensions.skill.length === 2);
check('group mode reports the group it trimmed', capGroup.dropped.every((item) => item.group === 'daily'), capGroup.dropped);

const rowsForBlacklist = [
  { kind: 'dimension', dimension: 'interests', sessionId: 's1', turn: 1, text: '甲' },
  { kind: 'dimension', dimension: 'interests', sessionId: 's1', turn: 2, text: '乙' },
];
const blockedKeys = new Set([rowsForBlacklist[0]].map((row) => evidenceKey(row)));
check('a blacklisted row is filtered out', filterBlacklisted(rowsForBlacklist, blockedKeys).length === 1);
check('an empty blacklist changes nothing', filterBlacklisted(rowsForBlacklist, new Set()).length === 2);
check('a non-set blacklist is treated as empty', filterBlacklisted(rowsForBlacklist, undefined).length === 2);

// The derived layer: a conclusion that is not active silences its evidence, and
// restoring it takes the keys back out. Pinned keys (permanent deletes) never move.
const derivedRows = [
  { kind: 'dimension', dimension: 'interests', sessionId: 's1', turn: 1, text: '喜欢玩 galgame' },
  { kind: 'dimension', dimension: 'interests', sessionId: 's1', turn: 2, text: '周末喜欢爬山和拍照' },
];
const profileWithRetired = {
  dimensions: { interests: [{ text: '喜欢玩 galgame', status: 'active' }, { text: '周末喜欢爬山和拍照', status: 'retired' }] },
};
const profileRestored = {
  dimensions: { interests: [{ text: '喜欢玩 galgame', status: 'active' }, { text: '周末喜欢爬山和拍照', status: 'active' }] },
};
check(
  'a retired conclusion blacklists its own evidence',
  blacklistKeysForProfile(profileWithRetired, derivedRows).length === 1,
  blacklistKeysForProfile(profileWithRetired, derivedRows),
);
check(
  'restoring it puts the evidence back in play',
  blacklistKeysForProfile(profileRestored, derivedRows).length === 0,
  blacklistKeysForProfile(profileRestored, derivedRows),
);
check(
  'a superseded conclusion is silenced too',
  blacklistKeysForProfile(
    { dimensions: { interests: [{ text: '喜欢玩 galgame', status: 'active' }, { text: '周末喜欢爬山和拍照', status: 'superseded' }] } },
    derivedRows,
  ).length === 1,
);
check(
  'evidence shared with an active conclusion is never silenced',
  blacklistKeysForProfile(
    { dimensions: { interests: [{ text: '喜欢玩 galgame', status: 'active' }, { text: '喜欢玩 galgame', status: 'retired' }] } },
    derivedRows,
  ).length === 0,
);
check(
  'pinned keys survive every reconcile',
  blacklistKeysForProfile(profileRestored, derivedRows, ['K1']).includes('K1'),
);
check(
  'the derived list is sorted so two equal states produce the same file',
  JSON.stringify(blacklistKeysForProfile(profileWithRetired, derivedRows, ['B', 'A'])) === JSON.stringify(['A', 'B', ...blacklistKeysForProfile(profileWithRetired, derivedRows)]),
  blacklistKeysForProfile(profileWithRetired, derivedRows, ['B', 'A']),
);
check('the automatic text cap is 50 characters', AUTO_ENTRY_TEXT_LIMIT === 50);
check('the manual text cap stays at 80 characters', ENTRY_TEXT_LIMIT === 80);

// The synthesis source must exclude blacklisted rows, not merely skip them when a
// digest writes new ones: a retired conclusion's evidence stays in the ledger.
const synthesisRows = [
  { kind: 'dimension', dimension: 'interests', sessionId: 's1', turn: 1, text: '喜欢玩 galgame' },
  { kind: 'dimension', dimension: 'interests', sessionId: 's1', turn: 2, text: '周末喜欢爬山和拍照' },
  { kind: 'rollup', dimension: 'interests', sessionId: 's1', turn: 3, text: '不是证据行' },
];
const synthesisKeys = new Set([evidenceKey(synthesisRows[0])]);
check(
  'synthesis keeps only evidence rows',
  selectSynthesisSource(synthesisRows, new Set()).length === 2,
  selectSynthesisSource(synthesisRows, new Set()).map((row) => row.kind),
);
check(
  'synthesis drops blacklisted evidence',
  selectSynthesisSource(synthesisRows, synthesisKeys).every((row) => row.text !== '喜欢玩 galgame'),
  selectSynthesisSource(synthesisRows, synthesisKeys).map((row) => row.text),
);
check(
  'an empty blacklist changes nothing',
  selectSynthesisSource(synthesisRows, new Set()).length === selectSynthesisSource(synthesisRows, undefined).length,
);

// --- timeline compaction ------------------------------------------------------
// Rows group by session+turn; a turn no conclusion cites is removed whole, a cited
// turn keeps at most `perTurn` rows, preferring the one that backs a conclusion.
const compactProfile = {
  dimensions: {
    interests: [
      { text: '喜欢玩 galgame', status: 'active', sources: [{ sessionId: 's1', turn: 1 }] },
      { text: '周末喜欢爬山和拍照', status: 'retired', sources: [{ sessionId: 's1', turn: 2 }] },
    ],
  },
};
const compactRows = [
  { kind: 'dimension', dimension: 'interests', sessionId: 's1', turn: 1, text: '喜欢玩 galgame', at: 10 },
  { kind: 'dimension', dimension: 'interests', sessionId: 's1', turn: 1, text: '喜欢玩 galgame 剧情', at: 20 },
  { kind: 'dimension', dimension: 'interests', sessionId: 's1', turn: 1, text: '无关的第三条', at: 30 },
  { kind: 'dimension', dimension: 'interests', sessionId: 's1', turn: 2, text: '周末喜欢爬山和拍照', at: 40 },
  { kind: 'dimension', dimension: 'interests', sessionId: 's9', turn: 9, text: '没有结论引用这一轮', at: 50 },
];
const compactPlan = planTimelineCompaction(compactProfile, compactRows, 2);
check('an uncited turn is removed whole', !compactPlan.keep.some((row) => row.sessionId === 's9'), compactPlan.keep.map((row) => row.text));
check('a cited turn keeps at most the per-turn budget', compactPlan.keep.filter((row) => row.sessionId === 's1' && row.turn === 1).length === 2, compactPlan.keep.map((row) => row.text));
check('the row backing a conclusion is kept', compactPlan.keep.some((row) => row.text === '喜欢玩 galgame'));
check(
  'a turn cited by a retired conclusion is still protected',
  compactPlan.keep.some((row) => row.turn === 2),
  compactPlan.keep.map((row) => [row.turn, row.text]),
);
check(
  'the plan reports its counts',
  compactPlan.stats.rows === 5 && compactPlan.stats.removedRows === 2 && compactPlan.stats.removedTurns === 1,
  compactPlan.stats,
);
check(
  'a plan with nothing to remove keeps the ledger as is',
  planTimelineCompaction(compactProfile, compactRows.slice(0, 2), 2).remove.length === 0,
);

// --- the adjustable character limit --------------------------------------------
check('the character limit defaults to 50', normalizeEntryCap(undefined).charLimit === 50);
check('a configured character limit is kept', normalizeEntryCap({ charLimit: 120 }).charLimit === 120);
check('a tiny character limit is clamped up', normalizeEntryCap({ charLimit: 0 }).charLimit === 1);
check('a huge character limit is clamped down', normalizeEntryCap({ charLimit: 9999 }).charLimit === 500);
check('a non-numeric character limit falls back', normalizeEntryCap({ charLimit: 'wide' }).charLimit === 50);
const digestLimits = normalizeTurnDigest(
  { evidence: [{ dimension: 'interests', text: '这是一条明显超过十个字的结论用于验证截断', statement: 'user', quote: '这是一条明显超过十个字的结论用于验证截断' }], corrections: [], userAsk: '这是一条明显超过十个字的结论用于验证截断' },
  { turn: 1, userText: '这是一条明显超过十个字的结论用于验证截断', at: 1 },
  { textLimit: 10 },
);
check('a digest honours the configured limit', (digestLimits.evidence[0]?.text ?? '').length <= 10, digestLimits.evidence[0]?.text);
// --- confidence: manual adjustment ignores the basis ceiling -------------------
check('an inferred technical claim is capped at low', clampConfidence('high', 'assistant', 'tech') === 'low');
check('an inferred daily claim is capped at medium', clampConfidence('high', 'assistant', 'daily') === 'medium');
check('a user statement may carry high', clampConfidence('high', 'user', 'tech') === 'high');
check('a manual high is never capped', clampConfidence('high', 'assistant', 'tech', true) === 'high');
check('a manual medium is never capped', clampConfidence('medium', 'mixed', 'daily', true) === 'medium');
const manualConfidenceProfile = normalizeProfile({
  dimensions: {
    skill: [
      { text: '手动画了一条技术结论并设为高', statement: 'assistant', confidence: 'high', manual: true, status: 'active' },
      { text: '模型推断的技术结论设为高', statement: 'assistant', confidence: 'high', status: 'active' },
    ],
  },
});
check(
  'normalizeProfile keeps a manual high on an assistant basis',
  manualConfidenceProfile.dimensions.skill.find((entry) => entry.manual === true)?.confidence === 'high',
  manualConfidenceProfile.dimensions.skill.map((entry) => [entry.text, entry.confidence, entry.manual]),
);
check(
  'normalizeProfile still caps a model-written high',
  manualConfidenceProfile.dimensions.skill.find((entry) => entry.manual !== true)?.confidence === 'low',
);
// --- the two-layer blacklist ---------------------------------------------------
const blProfile = {
  dimensions: {
    interests: [
      { text: '喜欢玩 galgame', status: 'active', sources: [{ sessionId: 's1', turn: 1 }] },
      { text: '周末喜欢爬山和拍照', status: 'retired', sources: [{ sessionId: 's2', turn: 5 }] },
    ],
  },
};
const blRows = [
  { kind: 'dimension', dimension: 'interests', sessionId: 's1', turn: 1, text: '喜欢玩 galgame' },
  { kind: 'dimension', dimension: 'interests', sessionId: 's2', turn: 5, text: '周末喜欢爬山和拍照' },
];
const blDoc = blacklistForProfile(blProfile, blRows, ['P1'], ['p#9']);
check('a turn key is session plus turn', turnKey({ sessionId: 's1', turn: 3 }) === 's1#3');
check('a retired conclusion silences its turn', blDoc.turns.includes('s2#5'), blDoc.turns);
check('a turn cited by an active conclusion stays usable', !blDoc.turns.includes('s1#1'), blDoc.turns);
check('pinned turns survive the reconcile', blDoc.pinnedTurns.includes('p#9'), blDoc.pinnedTurns);
check('pinned keys survive the reconcile', blDoc.pinnedKeys.includes('P1'), blDoc.pinnedKeys);
check('a row in a silenced turn is blacklisted', isBlacklisted(blRows[1], { keys: new Set(), turns: new Set(['s2#5']) }) === true);
check('a row in a usable turn is not', isBlacklisted(blRows[0], { keys: new Set(), turns: new Set(['s2#5']) }) === false);
check(
  'the filter drops silenced turns',
  filterBlacklisted(blRows, new Set(), new Set(['s2#5'])).length === 1,
);
check(
  'restoring the conclusion removes its turn again',
  !blacklistForProfile(
    { dimensions: { interests: [{ text: '周末喜欢爬山和拍照', status: 'active', sources: [{ sessionId: 's2', turn: 5 }] }] } },
    blRows,
  ).turns.includes('s2#5'),
);
// --- per-session switches ------------------------------------------------------
check('a session defaults to off', normalizeSessionMode(undefined).enabled === false);
check('the group switches default to on', normalizeSessionMode(undefined).daily === true && normalizeSessionMode(undefined).tech === true);
check('closing the master switch exposes no group', JSON.stringify(enabledGroups({ enabled: false, daily: true, tech: true })) === JSON.stringify({ daily: false, tech: false }));
check('a closed group is excluded', JSON.stringify(enabledGroups({ enabled: true, daily: false, tech: true })) === JSON.stringify({ daily: false, tech: true }));
const modeMap = new Map([['parent', { enabled: true, daily: true, tech: false }]]);
check('a session reads its own switch', resolveSessionMode(modeMap, 'parent').enabled === true);
check('a subagent inherits the parent switch', resolveSessionMode(modeMap, 'child', 'parent').tech === false);
check('an unknown session gets the default', resolveSessionMode(modeMap, 'other').enabled === false);
check('a stored switch beats inheritance', resolveSessionMode(new Map([['parent', { enabled: true }], ['child', { enabled: false }]]), 'child', 'parent').enabled === false);
check('a malformed stored value falls back to the default', normalizeSessionMode({ enabled: 'yes', daily: 1 }).enabled === false && normalizeSessionMode({ enabled: 'yes', daily: 1 }).daily === true);
// --- the two additional merge triggers ----------------------------------------
// Several requirements about ONE object are one rule, not several rows.
check(
  'requirements about the same object are one conclusion',
  isSameConclusion('要求把 VNDB 标签分开分级，不要混着说', '要求把 2DFan 标签分开分级'),
);
check(
  'unrelated requirements do NOT collapse into each other',
  !isSameConclusion('不要用 iframe 方案', '不要用 node 做文件操作'),
);
// Steps of one process are one conclusion.
check(
  'steps of one process are one conclusion',
  isSameConclusion('先备份再改文件', '先备份再改，然后验证'),
);
check(
  'steps of different processes stay apart',
  !isSameConclusion('先备份再改', '改完要验证'),
);

const requirementRows = mergeSynthesis(
  createProfile(1),
  {
    dimensions: {
      workstyle: [
        { text: '要求把 VNDB 标签分开分级', confidence: 'medium', status: 'active' },
        { text: '要求把 2DFan 标签分开分级', confidence: 'medium', status: 'active' },
      ],
    },
  },
  840,
);
check(
  'two requirements about one object merge into one row',
  requirementRows.profile.dimensions.workstyle.length === 1 && requirementRows.report.combinedEntries === 1,
  { entries: requirementRows.profile.dimensions.workstyle.length, report: requirementRows.report },
);

// --- the basis must be provable at merge time too ------------------------------
// A reply that claims `user` while its sources point at a row the digest marked as
// a model inference is demoted, and its confidence falls with it.
const ledgerIndex = sourceIndexOf([
  { sessionId: 's1', turn: 1, statement: 'assistant', text: '我给你解释过管道', source: '我给你解释过管道', at: 1 },
  { sessionId: 's1', turn: 2, statement: 'user', text: '主要用 Windows', source: '主要用 Windows', at: 2 },
]);
const demoted = mergeSynthesis(
  createProfile(1),
  {
    dimensions: {
      skill: [
        { text: '掌握 PowerShell 管道编排', statement: 'user', confidence: 'high', status: 'active', sources: [{ sessionId: 's1', turn: 1 }] },
      ],
    },
  },
  850,
  { sourceIndex: ledgerIndex },
);
check(
  'a user claim backed only by a model inference row is demoted',
  demoted.profile.dimensions.skill[0].statement === 'assistant',
  demoted.profile.dimensions.skill[0],
);
check(
  'the demoted claim is clamped to the inference ceiling',
  demoted.profile.dimensions.skill[0].confidence === 'low',
  demoted.profile.dimensions.skill[0].confidence,
);
const kept = mergeSynthesis(
  createProfile(1),
  {
    dimensions: {
      skill: [
        { text: '主要用 Windows', statement: 'user', confidence: 'high', status: 'active', sources: [{ sessionId: 's1', turn: 2 }] },
      ],
    },
  },
  860,
  { sourceIndex: ledgerIndex },
);
check(
  'a user claim backed by a verified user row keeps its basis',
  kept.profile.dimensions.skill[0].statement === 'user' && kept.profile.dimensions.skill[0].confidence === 'high',
  kept.profile.dimensions.skill[0],
);
const noSource = mergeSynthesis(
  createProfile(1),
  { dimensions: { skill: [{ text: '在一家游戏公司上班', statement: 'user', confidence: 'high', status: 'active', sources: [] }] } },
  870,
  { sourceIndex: ledgerIndex },
);
check(
  'a user claim with no source at all is demoted',
  noSource.profile.dimensions.skill[0].statement === 'assistant',
  noSource.profile.dimensions.skill[0].statement,
);

// The read tool's counter must follow a dimension filter. It used to report the
// whole profile's total next to a filtered header, which reads as a contradiction.
const { portraitTools } = await import('../lib/tools.js');
const readTool = portraitTools({
  ops: {
    read: async () => ({
      text: 'stub',
      profile: {
        dimensions: {
          personality: [{ status: 'active' }, { status: 'retired' }],
          interests: [{ status: 'active' }, { status: 'active' }, { status: 'retired' }],
        },
      },
    }),
  },
}).find((tool) => tool.name === 'portrait_read');
const filteredRead = await readTool.execute({ dimension: 'interests' });
check('a dimension-filtered read counts only that dimension', filteredRead.activeEntries === 2, filteredRead.activeEntries);
const wholeRead = await readTool.execute({});
check('an unfiltered read counts the whole profile', wholeRead.activeEntries === 3, wholeRead.activeEntries);

finish('ALL CHECKS PASSED');
