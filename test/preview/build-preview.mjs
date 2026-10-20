/**
 * Generate a self-contained, offline design preview of the portrait panel.
 *
 * Everything the preview needs is read out of the plugin's own client source —
 * the stylesheet, the inlined official icon geometry, and the tab/catalog
 * vocabulary — so the preview cannot drift from what the app renders. The output
 * is one HTML file with no external references at all: no CDN, no fonts, no
 * images, no JSON fetches. Open it directly from disk.
 *
 * Usage:
 *   node test/preview/build-preview.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CLIENT, PLUGIN_ROOT } from '../_paths.mjs';

const OUT_DIR = join(PLUGIN_ROOT, 'assets');
/** `--empty` renders the panel's first-run state: no conclusions, no annotation column. */
const EMPTY = process.argv.includes('--empty');
const OUT_FILE = join(OUT_DIR, EMPTY ? 'panel-empty.html' : 'user-portrait-preview.html');

const source = await readFile(CLIENT, 'utf8');

/**
 * Extract one backtick template literal by index, without escape bookkeeping.
 *
 * The panel stylesheet is plain CSS with no backslashes and no `${…}` holes, so
 * the content runs verbatim from the opening backtick to the next one. Scanning
 * for delimiters generically was the thing that kept failing here; a literal
 * slice cannot.
 * @param text - source text.
 * @param marker - the `const NAME = \`` prefix that starts the literal.
 * @returns the literal body.
 */
function templateLiteralAfter(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) throw new Error(`marker not found: ${marker}`);
  const open = markerIndex + marker.length - 1;
  const close = text.indexOf('`', open + 1);
  if (close === -1) throw new Error(`unterminated template literal after ${marker}`);
  return text.slice(open + 1, close);
}

/**
 * Slice one balanced braced object by scanning braces, skipping braces inside
 * quotes. Used for the `GLYPHS` map, which does contain quoted path data.
 * @param text - source text.
 * @param marker - the declaration prefix that starts the object.
 * @returns the object body.
 */
function objectLiteralAfter(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) throw new Error(`marker not found: ${marker}`);
  const open = text.indexOf('{', markerIndex);
  let depth = 0;
  let quote = '';
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== '') {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  throw new Error(`unterminated object literal after ${marker}`);
}

const css = templateLiteralAfter(source, 'const CSS = `');
if (css.trim() === '') throw new Error('could not extract the panel stylesheet from client.js');

/**
 * The inlined official glyph geometry, parsed into path lists.
 *
 * Each entry is either a multi-line object or a single-line one, so the block
 * body is located by name and sliced to the next entry rather than matched with
 * one brace shape.
 */
function readGlyphs() {
  const block = objectLiteralAfter(source, 'const GLYPHS = ');
  const names = [...block.matchAll(/^\s*([A-Za-z]+):\s*\{/gm)].map((match) => match[1]);
  const glyphs = {};
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const start = block.search(new RegExp(`^\\s*${name}:\\s*\\{`, 'm'));
    const nextName = names[index + 1];
    const end = nextName === undefined ? block.length : block.search(new RegExp(`^\\s*${nextName}:\\s*\\{`, 'm'));
    const body = block.slice(start, end === -1 ? undefined : end);
    // Only the SVG path data starts with a moveto command; the other strings in
    // an entry are the optional miterlimit.
    const paths = [...body.matchAll(/'([^']*)'/g)]
      .map((match) => match[1])
      .filter((value) => /^[Mm]/.test(value));
    const miterlimit = /miterlimit:\s*'([^']+)'/.exec(body)?.[1];
    if (paths.length > 0) glyphs[name] = { paths, miterlimit };
  }
  return glyphs;
}

const GLYPHS = readGlyphs();
if (Object.keys(GLYPHS).length < 8) throw new Error(`only ${Object.keys(GLYPHS).length} glyphs parsed`);

// --------------------------------------------------------------------- demo data
const now = Date.now();
const day = 86400000;
const demo = {
  updatedAt: now - 3600000,
  dataDir: '.dsh/user-portrait',
  progress: { digests: 14, evidence: 96, backfill: { active: false, done: 0, total: 0 } },
  groups: [
    {
      id: 'daily',
      label: '日常画像',
      hint: '性格、爱好、生活背景与当前状态 —— 只有你亲口说过的才会进来，所以这里条目少、置信度偏低是正常的',
    },
    { id: 'tech', label: '技术画像', hint: '能力与技术栈、工作方式、风险边界与敏感点' },
  ],
  notes: [{ text: '我在做信息安全方向的秋招准备，别再建议我转前端', at: now - 2 * day }],
  dimensions: [
    { id: 'personality', group: 'daily', label: '性格与沟通', hint: '性格倾向、对待反馈的态度、期望的回复详略与结构、语气与术语密度', entries: [
      { text: '喜欢先看结论再看推理，讨厌铺垫', statement: 'user', confidence: 'medium', status: 'active', manual: false, firstSeenAt: now - 9 * day, sources: [{ sessionId: 'session-337271ce', turn: 8, at: now - 9 * day, text: '先把结论给我，细节我自己看' }] },
    ] },
    { id: 'interests', group: 'daily', label: '兴趣与爱好', hint: '长期兴趣、业余投入、持续关注的话题与内容品类', entries: [
      { text: '玩 galgame（日式视觉小说），对病娇题材有兴趣', statement: 'user', confidence: 'high', status: 'active', manual: false, firstSeenAt: now - 5 * day, sources: [{ sessionId: 'session-712a9a19', turn: 1, at: now - 5 * day, text: '我想玩女主为病娇的galgame' }] },
      { text: '玩 galgame，并且偏好叙事驱动、有心理描写张力的题材', statement: 'mixed', confidence: 'medium', status: 'active', manual: false, firstSeenAt: now - 4 * day, sources: [{ sessionId: 'session-712a9a19', turn: 2, at: now - 4 * day, text: '继续推进病娇题材 galgame 的横向调研' }] },
    ] },
    { id: 'background', group: 'daily', label: '生活与身份', hint: '身份与专业背景、作息与时间安排、生活层面的固定约束', entries: [] },
    { id: 'focus', group: 'daily', label: '当前在做', hint: '正在推进的项目、阶段目标、近期关注点（有明确时效，过时可废弃）', entries: [
      { text: '在改人物画像插件的面板与提炼策略', statement: 'user', confidence: 'high', status: 'active', manual: true, firstSeenAt: now - day, sources: [] },
    ] },
    { id: 'current', group: 'daily', label: '近期状态', hint: '近段时间的处境与情绪：忙闲节奏、压力来源、正在等待或纠结的事（短期结论，会自然过期）', entries: [] },
    { id: 'skill', group: 'tech', label: '能力与技术栈', hint: '熟练的语言/框架/平台、擅长的任务类型、专业与行业背景、常用工具与编辑器偏好', entries: [
      { text: '熟练 Python 与 PowerShell，Node 只到能读改脚本', statement: 'user', confidence: 'high', status: 'active', manual: false, firstSeenAt: now - 12 * day, sources: [{ sessionId: 'session-337271ce', turn: 2, at: now - 12 * day, text: '我主要用 Python 和 PowerShell' }] },
      { text: '看起来对 PowerShell 管道比较熟', statement: 'assistant', confidence: 'low', status: 'active', manual: false, firstSeenAt: now - 3 * day, sources: [{ sessionId: 'session-d34e7b2f', turn: 7, at: now - 3 * day, text: '我给你解释过管道怎么串' }] },
      { text: '偏好用 PowerShell 而不是 node 做文件操作', statement: 'user', confidence: 'high', status: 'superseded', manual: false, firstSeenAt: now - 20 * day, sources: [{ sessionId: 'session-337271ce', turn: 8, at: now - 20 * day, text: '最好用 PowerShell 而不是 node' }] },
      { text: '长期只写 Java，不碰前端', statement: 'assistant', confidence: 'low', status: 'retired', manual: true, deletedAt: now - day, firstSeenAt: now - 26 * day, sources: [] },
    ] },
    { id: 'workstyle', group: 'tech', label: '工作方式', hint: '节奏与粒度、计划性与验证习惯；正确性/效率/可维护性/隐私/成本的优先级；不确定时如何收敛', entries: [
      { text: '先要方案再动手，改动前必须先备份', statement: 'user', confidence: 'high', status: 'active', manual: false, firstSeenAt: now - 8 * day, sources: [{ sessionId: 'session-337271ce', turn: 4, at: now - 3 * day, text: '（此处的原文摘录）' }] },
      { text: '更看重可维护性，而不是最快跑通', statement: 'user', confidence: 'medium', status: 'active', manual: false, firstSeenAt: now - 6 * day, sources: [{ sessionId: 'session-d34e7b2f', turn: 5, at: now - 3 * day, text: '（此处的原文摘录）' }] },
    ] },
    { id: 'boundary', group: 'tech', label: '风险边界', hint: '不接受的做法、红线、必须先确认的事项、授权尺度', entries: [
      { text: '不允许未确认就删除或覆盖已有文件', statement: 'user', confidence: 'high', status: 'active', manual: false, firstSeenAt: now - 10 * day, sources: [{ sessionId: 'session-337271ce', turn: 6, at: now - 3 * day, text: '（此处的原文摘录）' }] },
    ] },
    { id: 'friction', group: 'tech', label: '敏感点', hint: '反复纠正的点、易被误解之处、明确表达过不满的行为', entries: [
      { text: '反复纠正过：不要用 iframe 方案', statement: 'user', confidence: 'high', status: 'active', manual: false, firstSeenAt: now - 4 * day, sources: [{ sessionId: 'session-d34e7b2f', turn: 3, at: now - 3 * day, text: '（此处的原文摘录）' }] },
    ] },
  ],
  evidence: [
    { text: '偏好用 PowerShell 而不是 node 做文件操作', kind: 'preference', statement: 'user', confidence: 'high', sessionId: 'session-337271ce', turn: 8, at: now - 2 * 3600000, source: '最好用 PowerShell 而不是 node' },
    { text: '先要方案再动手', kind: 'dimension', dimension: 'workstyle', statement: 'user', confidence: 'medium', sessionId: 'session-d34e7b2f', turn: 5, at: now - 30 * 3600000, source: '你先给我方案，我看过再动手' },
  ],
  sessions: [
    {
      sessionId: 'session-337271ce',
      updatedAt: now - 2 * 3600000,
      turnCount: 9,
      rollup: { topic: '人物画像插件：维度结构与面板', overview: '从零实现 Host/Client 双向插件，确定维度目录与面板交互，最后把外观对齐官方设计系统。' },
      turns: [
        { turn: 8, userAsk: '把插件挪到 work-space 并固定数据目录', userKeyPoints: ['用 PowerShell 而非 node', 'dataDir 要绝对路径'], assistantSummary: '搬移目录并固定绝对数据目录。', corrections: [{ text: '倾向用 PowerShell 而不是 node 做文件操作' }] },
        { turn: 9, userAsk: '面板按钮改成官方外观', userKeyPoints: ['按钮要按官方规格'], assistantSummary: '按官方 Button/SegmentedTabs/Tag 规格重做面板。', corrections: [] },
      ],
    },
  ],
};

if (EMPTY) {
  // First-run state: nothing has been extracted yet, so every dimension is empty
  // and the demo conclusions, notes and progress counters are dropped.
  demo.notes = [];
  demo.progress = { digests: 0, evidence: 0, backfill: { active: false, done: 0, total: 0 } };
  demo.dimensions = demo.dimensions.map((dimension) => ({ ...dimension, entries: [] }));
}

// --------------------------------------------------------------------- helpers
const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** One inline official-geometry glyph. */
function glyph(name, size = 14) {
  const artwork = GLYPHS[name];
  if (artwork === undefined) return '';
  const miter = artwork.miterlimit === undefined ? '' : ` stroke-miterlimit="${escapeHtml(artwork.miterlimit)}"`;
  const paths = artwork.paths
    .map((d) => `<path d="${escapeHtml(d)}" stroke="currentColor"${miter}></path>`)
    .join('');
  return `<svg class="dup-icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1"${miter}>${paths}</svg>`;
}

/** The neighbouring confidence label, mirroring the panel's own ladder. */
function confStep(value, direction) {
  const ladder = ['low', 'medium', 'high'];
  const at = Math.max(0, ladder.indexOf(value));
  const next = ladder[Math.min(ladder.length - 1, Math.max(0, at + (direction === 'down' ? -1 : 1)))];
  return confLabel[next] ?? next;
}
function confUp(value) { return confStep(value, 'up'); }
function confDown(value) { return confStep(value, 'down'); }

const confTone = { high: 'success', medium: 'warning', low: 'low' };
const confLabel = { high: '高', medium: '中', low: '低' };
const statusLabel = { active: '生效', superseded: '已取代', retired: '已废弃' };

const when = (value) => {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const chip = (tone, label, title) =>
  `<span class="dup-chip" data-tone="${tone}"${title === undefined ? '' : ` title="${escapeHtml(title)}"`}>${escapeHtml(label)}</span>`;

/** The basis chip, mirroring the panel: a merged conclusion names both bases. */
const BASIS = {
  user: { tone: 'info', label: '依据 · 用户的话', title: '依据出自用户自己的原话' },
  assistant: { tone: 'warning', label: '依据 · 模型应答', title: '依据出自模型自己的回答/解释，不是用户明说；置信度上限受此限制' },
  mixed: { tone: 'mixed', label: '依据 · 用户的话 & 模型应答', title: '一部分依据是用户的原话，一部分是模型的推断；置信度按「含推断」的上限计算' },
};
const basisChip = (statement) => {
  const basis = BASIS[statement] ?? BASIS.user;
  return chip(basis.tone, basis.label, basis.title);
};

const button = (variant, label, iconName, title) =>
  `<button type="button" class="dup-btn" data-variant="${variant}"${title === undefined ? '' : ` title="${escapeHtml(title)}"`}>${iconName === undefined ? '' : glyph(iconName)}<span>${escapeHtml(label)}</span></button>`;

const statusBar = (tone, text, progress) =>
  `<div class="dup-status" data-tone="${tone}">${
    progress === undefined
      ? ''
      : `<span class="dup-progress"><span style="width:${Math.round(progress * 100)}%"></span></span>`
  }<span class="dup-status-text">${escapeHtml(text)}</span></div>`;

const TABS = ['画像维度', '我的备注', '会话记录', '证据时间线'];

// ------------------------------------------------------------------ panel markup
const totalActive = demo.dimensions.reduce(
  (sum, dimension) => sum + dimension.entries.filter((entry) => entry.status === 'active').length,
  0,
);
const covered = demo.dimensions.filter((dimension) => dimension.entries.some((entry) => entry.status === 'active')).length;

const header = `
  <div class="dup-head">
    <div class="dup-title-row">
      <div class="dup-title"><span class="dup-dot"></span>人物画像</div>
      ${button('icon', '', 'settings').replace('<span></span>', '')}
    </div>
    <div class="dup-meta">${totalActive} 条生效结论 · 覆盖 ${covered}/${demo.dimensions.length} 个维度 · 逐轮摘要 ${demo.progress.digests} 个会话 · 证据 ${demo.progress.evidence} 条</div>
${EMPTY ? '' : `    ${statusBar('info', '正在与 Host 同步…')}
    ${statusBar('success', '已重新合并画像')}`}
    <div class="dup-toolbar">
      ${button('primary', '立即重新提炼', 'sparkle', '立即重新提炼（不重读会话）&#10;· 只用已经提炼出来的证据&#10;· 只把现有证据重新合并，不重读会话&#10;· 遵守结论上限；黑名单证据不参与')}
      ${button('outline', '回填全部历史会话', 'refresh', '回填全部历史会话（只补没提炼过的）&#10;· 跳过子代理会话&#10;· 每个会话取最近 24 轮&#10;· 跑完自动合并；黑名单证据照样排除')}
      ${button('outline', '重新提炼全部历史', 'archive', '重新提炼全部历史（重跑，不是重建）&#10;· 忽略已处理标记，重新摘要所有会话&#10;· 证据按内容去重&#10;· 现有结论不清空；黑名单证据照样排除')}
      ${button('outline', '刷新', 'refresh', '更新于 ' + when(demo.updatedAt) + ' · 数据目录 ' + escapeHtml(demo.dataDir) + ' · 已刷新 ' + when(demo.updatedAt))}
      ${button('outline', '反馈与建议', 'sparkle', '未设置反馈网址（配置项 feedbackUrl）')}
    </div>
  </div>`;

const tabs = `
  <div class="dup-tabs" role="tablist" aria-label="人物画像视图">
    <span class="dup-tab-indicator" aria-hidden="true" style="width:calc((100% - 8px) / 4);transform:translateX(4px)"></span>
    ${TABS.map(
      (label, index) =>
        `<button type="button" role="tab" class="dup-tab" data-active="${index === 0}" aria-selected="${index === 0}">${escapeHtml(label)}</button>`,
    ).join('')}
  </div>`;

// 我的备注 lives in its own tab now, so this block is not part of the dimensions
// view shown below. It is kept here (unused) as the reference markup for that tab.
const notesSection = `
  <div class="dup-group">
    <div class="dup-group-head">
      <span class="dup-group-name">我的备注</span>
      <span class="dup-group-total">${demo.notes.length} 条</span>
      <span style="margin-left:auto;flex:none">${button('ghost', '添加备注', 'plus')}</span>
    </div>
    <div class="dup-group-hint">备注的优先级高于任何自动结论：下一次提炼时会被强制保留。</div>
    ${demo.notes
      .map(
        (note) => `
      <div class="dup-entry" data-kind="note">
        <div class="dup-entry-text">${escapeHtml(note.text)}</div>
        <div class="dup-entry-actions">
          <span class="dup-src" style="margin-top:0">${when(note.at)}</span>
          <span style="flex:1"></span>
          <button type="button" class="dup-mini" data-variant="danger">删除</button>
        </div>
      </div>`,
      )
      .join('')}
  </div>`;
void notesSection;

const addSection = `
  <div class="dup-section">
    <div class="dup-row">${button('outline', '手动新增条目', 'plus')}${button('outline', '结论上限', 'settings', '当前上限：37/50 条（手动结论不计入）&#10;统一 50 · 分组 20+30=50（取较大者 50 条）&#10;手动新增不受上限阻挡，当前另有 4 条手动结论')}${button('outline', '导出', 'archive', '把画像维度导出为 Markdown 文档')}</div>
  </div>`;

/**
 * The pinned 检索 block, shown with a live query so the hit rendering (dimension,
 * confidence, basis, source count and the marked keyword) is visible.
 */
const searchQuery = EMPTY ? '' : 'galgame';
const searchHits = demo.dimensions.flatMap((dimension) =>
  dimension.entries
    .filter((entry) => entry.text.toLowerCase().includes(searchQuery))
    .map((entry) => ({ dimension, entry })),
);
const mark = (text) => {
  const at = text.toLowerCase().indexOf(searchQuery);
  if (at === -1) return escapeHtml(text);
  return `${escapeHtml(text.slice(0, at))}<mark class="dup-mark">${escapeHtml(text.slice(at, at + searchQuery.length))}</mark>${escapeHtml(text.slice(at + searchQuery.length))}`;
};
const searchSection = `
  <div class="dup-section" data-section="search">
    <div class="dup-section-head">
      <span class="dup-section-name">检索</span>
      <span class="dup-section-count">${searchHits.length} 条命中</span>
    </div>
    <div class="dup-row">
      <input class="dup-input" style="flex:1;min-width:160px" value="${escapeHtml(searchQuery)}" readonly>
      <button type="button" class="dup-btn" data-variant="ghost">清空</button>
    </div>
    <div class="dup-group-hint">点击结果可定位到下方对应条目。</div>
    ${searchHits
      .map(
        ({ dimension, entry }) => `
      <div class="dup-entry" data-kind="search-hit" data-status="${entry.status}">
        <div class="dup-entry-text">${mark(entry.text)}</div>
        <div class="dup-entry-foot">
          ${chip('outline', dimension.label)}
          ${chip(confTone[entry.confidence] ?? 'quiet', `置信度 ${confLabel[entry.confidence] ?? entry.confidence}`)}
          ${basisChip(entry.statement)}
          <span>${entry.sources.length === 0 ? '无来源记录' : `来源 ${entry.sources.length} 处`}</span>
        </div>
      </div>`,
      )
      .join('')}
  </div>`;

/**
 * The 废弃 area: same card framework as a dimension group, holding the retired,
 * superseded and deleted conclusions. Shown expanded here so the design can be
 * inspected in one glance.
 */
const discardEntries = demo.dimensions
  .map((dimension) => ({
    dimension,
    entries: dimension.entries.filter((entry) => entry.status !== 'active'),
  }))
  .filter((bucket) => bucket.entries.length > 0);
const discardTotal = discardEntries.reduce((sum, bucket) => sum + bucket.entries.length, 0);
const discardSection = `
  <div class="dup-group" data-section="discard">
    <div class="dup-group-head">
      <span class="dup-group-name">废弃</span>
      <span class="dup-group-total">${discardTotal} 条</span>
      <span style="margin-left:auto;flex:none;display:flex;gap:4px">${button('ghost', '清空', 'trash', '永久删除全部 ' + discardTotal + ' 条废弃结论（需二次确认）')}${button('ghost', '收起', 'chevronUp')}</span>
    </div>
    <div class="dup-group-hint">这里安放已废弃 / 已取代 / 已删除的结论：它们不再计入画像，相关证据同时被移出提炼（黑名单），点「恢复」即可回到对应维度并重新计入。</div>
    ${discardEntries
      .map(
        (bucket) => `
      <div class="dup-section">
        <div class="dup-section-head">
          <span class="dup-section-name">${escapeHtml(bucket.dimension.label)}</span>
          <span class="dup-section-count">${bucket.entries.length} 条废弃</span>
        </div>
        ${bucket.entries
          .map(
            (entry) => `
        <div class="dup-entry" data-kind="conclusion" data-status="${entry.status}">
          <div class="dup-entry-text">${escapeHtml(entry.text)}</div>
          <div class="dup-entry-foot">
            <button type="button" class="dup-edit-chip" data-action="edit">编辑</button>
            ${chip(confTone[entry.confidence] ?? 'quiet', `置信度 ${confLabel[entry.confidence] ?? entry.confidence}`, '置信度')}
            ${chip('outline', statusLabel[entry.status] ?? entry.status, `首次 ${when(entry.firstSeenAt)}`)}
            ${entry.deletedAt === undefined ? '' : chip('outline', '删除')}
            ${chip('info', '手动')}
          </div>
        </div>`,
          )
          .join('')}
      </div>`,
      )
      .join('')}
  </div>`;

/** One dimension card, rendered the way the panel renders it. */
function dimensionSection(dimension) {
  const active = dimension.entries.filter((entry) => entry.status === 'active').length;
  const hidden = dimension.entries.length - active;
  const entries = dimension.entries
    .map(
      (entry) => `
        <div class="dup-entry" data-status="${entry.status}">
          <div class="dup-entry-text">${escapeHtml(entry.text)}</div>
          <div class="dup-entry-foot">
            <button type="button" class="dup-edit-chip" data-action="edit">编辑</button>
            ${chip(confTone[entry.confidence] ?? 'quiet', `置信度 ${confLabel[entry.confidence] ?? entry.confidence}`, '置信度')}
            ${chip(entry.status === 'active' ? 'neutral' : 'outline', statusLabel[entry.status] ?? entry.status, `首次 ${when(entry.firstSeenAt)}`)}
            ${basisChip(entry.statement)}
            ${entry.sources.length === 0 ? '' : `<span class="dup-src-count" data-inline="source" title="${escapeHtml(sourceTooltip(entry))}">来源 ${entry.sources.length} 处</span>`}
            ${entry.manual === true ? chip('info', '手动') : ''}
          </div>
        </div>`,
    )
    .join('');
  return `
      <div class="dup-section">
        <div class="dup-section-head">
          <span class="dup-section-name">${escapeHtml(dimension.label)}</span>
          <span class="dup-section-count" title="${escapeHtml(dimension.hint)}">${active} 条生效${hidden > 0 ? ` · ${hidden} 条历史` : ''}</span>
        </div>
        <div class="dup-group-hint">${escapeHtml(dimension.hint)}</div>
        ${dimension.entries.length === 0 ? '<div class="dup-empty">暂无证据</div>' : ''}
        ${entries}
      </div>`;
}

/** The hover card behind a source count, mirroring the panel's own builder. */
function sourceTooltip(entry) {
  const lines = entry.sources.slice(0, 8).map((source) => {
    const where = `${source.sessionId}${source.turn === undefined ? '' : ` · 第 ${source.turn} 轮`}`;
    const at = source.at === undefined ? '' : ` · ${when(source.at)}`;
    const excerpt = typeof source.text === 'string' && source.text !== '' ? `\n    原文：${source.text}` : '';
    return `· ${where}${at}${excerpt}`;
  });
  return `来源（${entry.sources.length} 处）：\n${lines.join('\n')}`;
}

const groupsMarkup = demo.groups
  .map((group) => {
    const members = demo.dimensions.filter((dimension) => dimension.group === group.id);
    const groupTotal = members.reduce(
      (sum, dimension) => sum + dimension.entries.filter((entry) => entry.status === 'active').length,
      0,
    );
    return `
      <div class="dup-group">
        <div class="dup-group-head">
          <span class="dup-group-name">${escapeHtml(group.label)}</span>
          <span class="dup-group-total">${groupTotal} 条生效</span>
        </div>
        <div class="dup-group-hint">${escapeHtml(group.hint)}</div>
        ${members.map((dimension) => dimensionSection(dimension)).join('')}
      </div>`;
  })
  .join('');

// ------------------------------------------------------------------ page shell
const page = `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>人物画像面板 · 本地设计预览</title>
    <style>
      :root {
        --dsw-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
        --dsw-radius-xs: 4px;
        --dsw-radius-sm: 8px;
        --dsw-radius-md: 12px;
        --dsw-radius-lg: 16px;
        --dsw-radius-panel: 28px;
        --dsw-focus-ring-width: 1px;
        --dsw-focus-ring-color: #3b82f6;
        /* Light palette (the app's own aliases). */
        --dsw-alias-bg-base: #ffffff;
        --dsw-alias-bg-layer-1: #fafafa;
        --dsw-alias-bg-layer-2: #f5f5f6;
        --dsw-alias-bg-layer-3: #ffffff;
        --dsw-alias-bg-layer-4: #ececee;
        --dsw-alias-bg-module-platform: #f2f2f4;
        --dsw-alias-border-l1: #ececee;
        --dsw-alias-border-l2: #e3e3e6;
        --dsw-alias-border-l3: #d9d9de;
        --dsw-alias-border-l4: #cdcdd3;
        --dsw-alias-brand-primary: #4d6bfe;
        --dsw-alias-button-primary-fill: #4d6bfe;
        --dsw-alias-button-primary-hover: #3f5ae0;
        --dsw-alias-button-tool-bar-fill: #f2f2f4;
        --dsw-alias-button-tool-bar-hover: #e8e8ec;
        --dsw-alias-button-ghost-active-fill: #ffffff;
        --dsw-alias-button-ghost-active-border: #d9d9de;
        --dsw-alias-interactive-bg-hover: rgba(0, 0, 0, 0.05);
        --dsw-alias-interactive-bg-active: rgba(0, 0, 0, 0.08);
        --dsw-alias-interactive-bg-hover-danger: rgba(220, 38, 38, 0.08);
        --dsw-alias-label-primary: #1a1a1c;
        --dsw-alias-label-primary-foreground: #ffffff;
        --dsw-alias-label-secondary: #5c5c66;
        --dsw-alias-label-tertiary: #8e8e99;
        --dsw-alias-label-dimmed: #b0b0b8;
        --dsw-alias-label-error: #d93838;
        --dsw-alias-state-success-primary: #17a34a;
        --dsw-alias-state-warn-primary: #d97706;
        --dsw-alias-state-error-primary: #dc2626;
        --dsw-alias-state-business-primary: #2563eb;
        --dsw-alias-state-idle-primary: #9ca3af;
      }
      body.dark {
        --dsw-alias-bg-base: #151517;
        --dsw-alias-bg-layer-1: #1c1c1f;
        --dsw-alias-bg-layer-2: #232327;
        --dsw-alias-bg-layer-3: #2a2a2f;
        --dsw-alias-bg-layer-4: #33333a;
        --dsw-alias-bg-module-platform: #232327;
        --dsw-alias-border-l1: #2c2c32;
        --dsw-alias-border-l2: #35353c;
        --dsw-alias-border-l3: #414149;
        --dsw-alias-border-l4: #4d4d56;
        --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.06);
        --dsw-alias-interactive-bg-active: rgba(255, 255, 255, 0.1);
        --dsw-alias-interactive-bg-hover-danger: rgba(248, 113, 113, 0.14);
        --dsw-alias-label-primary: #ececf1;
        --dsw-alias-label-secondary: #a9a9b4;
        --dsw-alias-label-tertiary: #7c7c88;
        --dsw-alias-label-dimmed: #61616c;
        --dsw-alias-label-error: #f87171;
        --dsw-alias-button-tool-bar-fill: #26262b;
        --dsw-alias-button-tool-bar-hover: #303038;
      }
      html, body { margin: 0; height: 100%; }
      body {
        background: #e9e9ee;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #1a1a1c;
        display: flex;
        min-height: 100%;
      }
      body.dark { background: #0d0d0f; color: #ececf1; }
      .stage {
        display: flex;
        gap: 24px;
        padding: 24px;
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .pane {
        width: 340px;
        height: 2050px;
        display: flex;
        overflow: hidden;
        border-radius: 14px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16);
        border: 0.5px solid rgba(0, 0, 0, 0.12);
        background: var(--dsw-alias-bg-base);
      }
      .pane > .dup-root { flex: 1; min-width: 0; }
      .notes {
        width: 380px;
        padding: 16px 18px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.72);
        border: 0.5px solid rgba(0, 0, 0, 0.1);
        font-size: 13px;
        line-height: 1.75;
      }
      body.dark .notes { background: rgba(255, 255, 255, 0.04); border-color: rgba(255, 255, 255, 0.1); }
      .notes h1 { font-size: 16px; margin: 0 0 8px; }
      .notes h2 { font-size: 13px; margin: 16px 0 6px; }
      .notes code { font-family: Consolas, "SF Mono", monospace; font-size: 12px; }
      .notes ul { margin: 4px 0 0; padding-left: 18px; }
      .toggle {
        position: fixed;
        right: 18px;
        top: 18px;
        z-index: 5;
      }
      /* ---- the panel stylesheet, verbatim from client.js ---- */
${css}
${EMPTY ? `      body { background: #fff; }
      .stage { padding: 0; gap: 0; }
      .pane { width: 340px; height: auto; min-height: 0; border: 0; border-radius: 0; box-shadow: none; }
      .notes, .toggle, #theme { display: none; }` : ''}
    </style>
  </head>
  <body>
    <button type="button" class="dup-btn" data-variant="outline toggle" id="theme">切换浅色 / 深色</button>
    <div class="stage">
      <div class="pane">
        <div class="dup-root">
${header}
${tabs}
          <div class="dup-body">
${EMPTY ? '' : searchSection}
${EMPTY ? '' : discardSection}
${addSection}
${groupsMarkup}
          </div>
        </div>
      </div>
      <div class="notes">
        <h1>人物画像面板 · 本地设计预览</h1>
        <p>这是一个<strong>完全离线</strong>的自包含 HTML：没有 CDN、没有外链字体、没有图片请求、没有数据请求。它由
        <code>test/preview/build-preview.mjs</code> 从插件源码里的真实样式表与官方图标几何生成，因此所见即
        <code>client.js</code> 实际渲染的结构与配色。</p>
        <h2>对照点</h2>
        <ul>
          <li>按钮：官方 <code>sm</code> 规格（28px 高、8px 圆角）；主操作品牌填充，次要 0.5px 描边，刷新为 ghost。</li>
          <li>页签：官方分段轨道 + 滑动指示器，选中 600 字重。</li>
          <li>状态标签：官方 Tag 几何（17px 行高、全圆角），按状态色 10~12% 染色。</li>
          <li>行内操作：24px 小按钮。**置信度的升/降两个按钮常驻可见**，编辑与删除仍悬停才显现。</li>
          <li>置信度：高 = 绿、中 = 琥珀、**低 = 红**（同一套 Tag 几何，只换色板）。</li>
          <li>来源：只显示 来源 N 处，把鼠标放上去才显示会话 · 轮次 · 时间 · 原文。</li>
          <li>依据标签：依据 · 用户的话 / 依据 · 模型应答 / <strong>依据 · 用户的话 &amp; 模型应答</strong>（两种依据合并后同时标注，置信度按「含推断」的上限计算）。</li>
          <li>检索：置顶在画像维度页，输入即筛（内存内过滤），命中显示维度/置信度/依据/来源计数并高亮关键词，点击可定位。</li>
          <li>页签（4 个，顺序固定）：画像维度 · 我的备注 · 会话记录 · 证据时间线。</li>
          <li>分组：日常画像 / 技术画像两级标题，粘性吸顶。</li>
          <li>备注：已经有独立页签，不再在画像维度里重复一份。</li>
        </ul>
        <h2>与线上的差异</h2>
        <p>这里用的是演示数据，且不含交互逻辑（点击不会真的改数据）。如果你的应用面板与此预览不一致——
        尤其是<strong>依旧是空白</strong>——那说明问题在插件宿主侧的渲染链路，而不在这份结构/样式里。</p>
      </div>
    </div>
    <script>
      document.getElementById('theme').addEventListener('click', () => {
        document.body.classList.toggle('dark');
      });
    </script>
  </body>
</html>
`;

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_FILE, page, 'utf8');
console.log(`preview written: ${OUT_FILE}`);
console.log(`bytes: ${page.length}`);
console.log(`glyphs inlined: ${Object.keys(GLYPHS).join(', ')}`);
console.log(`stylesheet bytes copied from client.js: ${css.length}`);
// The SVG namespace string is an XML identifier, not a network fetch, so it is
// excluded from the "no external references" count.
const external = (page.match(/https?:\/\/[^"')\s]+/g) ?? []).filter((url) => !url.includes('www.w3.org'));
const offenders = [...page.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map((match) => match[1]);
console.log(`external URLs: ${external.length === 0 ? 'none' : external.join(', ')}`);
console.log(`src/href attributes: ${offenders.length === 0 ? 'none' : offenders.join(', ')}`);
console.log(`@import / url() references: ${(page.match(/@import|url\(/g) ?? []).length}`);













