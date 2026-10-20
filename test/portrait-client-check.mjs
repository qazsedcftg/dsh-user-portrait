/**
 * Harness for the client half of the user portrait plugin.
 *
 * The registered slot component is a thin wrapper that renders the real panel,
 * so this harness takes that element apart and renders the inner panel with a
 * minimal React hook runtime. That exercises the whole data path: Host fetch,
 * snapshot, dimensions, corrections, and tab switching.
 */
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

import { CLIENT, PLUGIN_ID } from './_paths.mjs';

import { check, finish } from './_harness.mjs';

// ------------------------------------------------------- minimal React core
let current = null;
let renderCount = 0;
const hookNames = [];

function withComponent(instance, body) {
  const previous = current;
  current = instance;
  try {
    return body();
  } finally {
    current = previous;
  }
}

/**
 * Render one component with persistent hook state, waiting for async loads.
 * @param component - component function.
 * @param props - its props.
 * @returns the settled element tree.
 */
async function renderSettled(component, props, reuse) {
  const instance = reuse ?? { hooks: [], cursor: 0, pendingEffects: [], hookOrders: [] };
  let tree;
  // Event handlers in this harness are awaited directly, so give their promise
  // chain a turn before the first pass reads hook state.
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let pass = 0; pass < 30; pass += 1) {
    instance.cursor = 0;
    instance.pendingEffects = [];
    instance.hookSequence = [];
    renderCount += 1;
    tree = withComponent(instance, () => component(props));
    // Record the exact hook order of this pass. React rejects a component whose
    // hook count changes between renders (error #310), and a blank pane is the
    // usual symptom — so the order, not just the set, is the contract.
    (instance.hookOrders ??= []).push([...instance.hookSequence]);
    const pending = instance.pendingEffects;
    instance.pendingEffects = [];
    for (const effect of pending) effect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (pending.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return tree;
}

const React = {
  /**
   * The base class the panel's error boundary extends. Real React drives
   * `render()` on an instance; this harness only needs the identity so the class
   * can be constructed and its fallback inspected.
   */
  Component: class Component {
    constructor(props) {
      this.props = props ?? {};
      this.state = {};
    }
  },
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
    // Every element keeps its children on `props` (React's own contract) and on
    // `.children` (this harness's traversal shortcut); both views must agree for
    // trees whose children arrive as arrays, as they do through wrapper atoms.
    return {
      type,
      props: props ?? {},
      children: flat,
    };
  },
  useState(initial) {
    hookNames.push('useState');
    if (current.hookSequence !== undefined) current.hookSequence.push('useState');
    const instance = current;
    const index = instance.cursor;
    instance.cursor += 1;
    if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial;
    return [
      instance.hooks[index],
      (next) => {
        instance.hooks[index] = typeof next === 'function' ? next(instance.hooks[index]) : next;
      },
    ];
  },
  useCallback(callback, deps) {
    hookNames.push('useCallback');
    if (current.hookSequence !== undefined) current.hookSequence.push('useCallback');
    const instance = current;
    const index = instance.cursor;
    instance.cursor += 1;
    if (instance.hooks[index] === undefined) instance.hooks[index] = { callback, deps };
    return instance.hooks[index].callback;
  },
  useMemo(factory, deps) {
    hookNames.push('useMemo');
    if (current.hookSequence !== undefined) current.hookSequence.push('useMemo');
    const instance = current;
    const index = instance.cursor;
    instance.cursor += 1;
    if (instance.hooks[index] === undefined) instance.hooks[index] = { value: factory(), deps };
    return instance.hooks[index].value;
  },
  useEffect(effect, deps) {
    hookNames.push('useEffect');
    if (current.hookSequence !== undefined) current.hookSequence.push('useEffect');
    const instance = current;
    const index = instance.cursor;
    instance.cursor += 1;
    // React re-runs an effect when its dependency list changes. The first version of
    // this stub only ran effects on mount, which silently hid every state-driven
    // effect (timers armed from a snapshot change) from these checks.
    const changed = (previous, next) => {
      if (previous === undefined || next === undefined) return previous !== next;
      if (!Array.isArray(previous) || !Array.isArray(next)) return false;
      return previous.length !== next.length || previous.some((value, position) => !Object.is(value, next[position]));
    };
    if (instance.hooks[index] === undefined) {
      instance.pendingEffects.push(effect);
      instance.hooks[index] = { deps };
    } else if (changed(instance.hooks[index].deps, deps)) {
      instance.hooks[index].deps = deps;
      instance.pendingEffects.push(effect);
    }
  },
  useRef(initial) {
    hookNames.push('useRef');
    if (current.hookSequence !== undefined) current.hookSequence.push('useRef');
    const instance = current;
    const index = instance.cursor;
    instance.cursor += 1;
    if (!(index in instance.hooks)) instance.hooks[index] = { current: initial };
    return instance.hooks[index];
  },
  useLayoutEffect(effect, deps) {
    React.useEffect(effect, deps);
  },
};

/** Every string in a tree. */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  const children = node.children ?? node.props?.children ?? [];
  for (const child of Array.isArray(children) ? children : [children]) texts(child, out);
  return out;
}

/**
 * Every string in a tree, descending through wrapper atoms.
 *
 * `texts` stops at a component element (this harness never reconciles), which is
 * right for structural assertions but hides text a wrapper owns — such as a
 * status bar's message. This variant invokes wrappers so their text is visible.
 */
function textsDeep(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textsDeep(child, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (typeof node.type === 'function' && node.type.prototype?.isReactComponent === undefined) {
    try {
      textsDeep(node.type(node.props ?? {}), out);
      return out;
    } catch {
      // Fall through to the raw children, which is all a throwing wrapper has.
    }
  }
  const children = node.children ?? node.props?.children ?? [];
  for (const child of Array.isArray(children) ? children : [children]) textsDeep(child, out);
  return out;
}

/** Every node satisfying a predicate. */
function find(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) find(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  const children = node.children ?? node.props?.children ?? [];
  for (const child of Array.isArray(children) ? children : [children]) find(child, predicate, out);
  return out;
}

/** Match one element type given either a tag string or a component function. */
function isType(node, type) {
  if (node?.type === type) return true;
  return typeof node?.type === 'function' && typeof type === 'string' && node.type.name === type;
}

/** The first node of a type whose declared label (or own text) equals a label. */
function byLabel(node, type, label) {
  return find(
    node,
    (candidate) => isType(candidate, type) && (candidate.props?.label === label || texts(candidate).join('') === label),
  )[0];
}

/** Render one component a single time, for shape checks only. */
function renderOnce(component, props) {
  return withComponent({ hooks: [], cursor: 0, pendingEffects: [] }, () => component(props));
}

// ------------------------------------------------------------ browser stubs
let loaded;
const styleTags = [];
// The glyph keys the client actually inlines, read from its own source so the
// assertion below cannot drift from the implementation.
const CLIENT_SOURCE = await readFile(CLIENT, 'utf8');
const GLYPH_BLOCK = /const GLYPHS = \{([\s\S]*?)\n    \};/.exec(CLIENT_SOURCE)?.[1] ?? '';
const INLINED_GLYPH_KEYS = [...GLYPH_BLOCK.matchAll(/^      ([A-Za-z]+): \{/gm)].map((match) => match[1]);

/** The minimal DOM surface the panel's stylesheet installer touches. */
function fakeStyleTag() {
  const attributes = new Map();
  return {
    dataset: {},
    textContent: '',
    removed: false,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    getAttribute(name) {
      if (attributes.has(name)) return attributes.get(name);
      // `dataset.pluginCss = x` must be readable as `data-plugin-css`, which is
      // the selector the installer and the module system both use.
      const key = name.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return this.dataset[key] ?? null;
    },
    remove() {
      this.removed = true;
    },
  };
}

/** Capture what a 导出 click actually hands to the browser. */
const downloads = [];

globalThis.Blob = class FakeBlob {
  constructor(parts) {
    this.parts = parts;
  }
};

// Keep the real URL constructor (the panel builds request URLs with `new URL`),
// and only stub the object-URL half used by the download path.
const RealURL = globalThis.URL;
class FakeURL extends RealURL {}
FakeURL.createObjectURL = (blob) => {
  downloads.push({ kind: 'blob', blob });
  return 'blob:portrait-test';
};
FakeURL.revokeObjectURL = () => undefined;
globalThis.URL = FakeURL;

globalThis.document = {
  head: {
    appendChild(tag) {
      styleTags.push(tag);
      return tag;
    },
  },
  body: {
    appendChild(node) {
      downloads.push({ kind: 'anchor', node });
      return node;
    },
  },
  createElement(tagName) {
    if (tagName === 'style') return fakeStyleTag();
    if (tagName === 'a') {
      // A real anchor only needs href/download/click/remove for the download path.
      const anchor = {
        href: '',
        download: '',
        click() {
          downloads.push({ kind: 'click', name: anchor.download });
        },
        remove() {
          return undefined;
        },
      };
      return anchor;
    }
    throw new Error(`unexpected createElement(${tagName})`);
  },
  querySelector(selector) {
    const wanted = /^style\[data-plugin-css="(.*)"\]$/.exec(String(selector));
    if (wanted === null) return null;
    return styleTags.find((tag) => tag.dataset.pluginCss === wanted[1]) ?? null;
  },
  querySelectorAll(selector) {
    if (selector !== 'style[data-plugin-css]') return [];
    return styleTags.filter((tag) => typeof tag.dataset.pluginCss === 'string');
  },
};

// Timers are captured so a test can drive a deferred registration by hand: the
// panel arms one when the right sidebar's registry is not provided yet.
const intervalCallbacks = [];
/** Delays each interval was registered with, so a polling loop is detectable. */
const intervalDelays = [];
const timeoutCallbacks = [];
const eventSources = [];
globalThis.window = {
  __ModuleLoader__: { load: (spec) => { loaded = spec; } },
  location: { origin: 'http://127.0.0.1:43120' },
  setInterval: (callback, delay) => {
    intervalCallbacks.push(callback);
    intervalDelays.push(delay);
    return intervalCallbacks.length;
  },
  clearInterval: (handle) => {
    if (typeof handle === 'number') intervalCallbacks[handle - 1] = undefined;
  },
  setTimeout: (callback, delay) => {
    timeoutCallbacks.push({ callback, delay });
    return timeoutCallbacks.length;
  },
  clearTimeout: () => undefined,
  /** Captures every stream the panel opens, so a pushed update can be simulated. */
  EventSource: class FakeEventSource {
    constructor(url) {
      this.url = String(url);
      this.listeners = new Map();
      this.closed = false;
      eventSources.push(this);
    }
    addEventListener(type, handler) {
      const list = this.listeners.get(type) ?? [];
      list.push(handler);
      this.listeners.set(type, list);
    }
    emit(type, data) {
      for (const handler of this.listeners.get(type) ?? []) handler({ data: JSON.stringify(data) });
    }
    close() {
      this.closed = true;
    }
  },
};

const fetchCalls = [];
const now = Date.now();
const snapshotPayload = {
  ok: true,
  groups: [
    { id: 'daily', label: '日常画像', hint: '性格、爱好、生活背景与当前状态' },
    { id: 'tech', label: '技术画像', hint: '能力与技术栈、工作方式、风险边界与敏感点' },
  ],
  dimensions: [
    { id: 'interests', group: 'daily', label: '兴趣与爱好', hint: '长期兴趣' },
    { id: 'skill', group: 'tech', label: '能力与技术栈', hint: '语言与框架' },
    { id: 'workstyle', group: 'tech', label: '工作方式', hint: '节奏与粒度' },
  ],
  profile: {
    updatedAt: now,
    notes: [{ text: '我在做 X 项目', at: now }],
    dimensions: {
      interests: [],
      skill: [
        {
          id: 'skill:0:1',
          text: '主要使用 Windows',
          statement: 'user',
          confidence: 'high',
          status: 'active',
          // `source`/`at` are what the host backfills from the evidence ledger, so
          // they are what a hover card can show.
          sources: [{ sessionId: 'session-1', turn: 2, at: now, text: '我用的是 Windows' }],
          firstSeenAt: now,
          lastConfirmedAt: now,
        },
        {
          id: 'skill:0:2',
          text: '看起来熟悉 PowerShell 管道',
          statement: 'assistant',
          confidence: 'low',
          status: 'active',
          sources: [],
          firstSeenAt: now,
          lastConfirmedAt: now,
        },
        {
          // A conclusion merged from both bases: the panel must name BOTH.
          id: 'skill:0:2b',
          text: '主要使用 Windows 并偏好 PowerShell 管道',
          statement: 'mixed',
          confidence: 'low',
          status: 'active',
          sources: [],
          firstSeenAt: now,
          lastConfirmedAt: now,
        },
        {
          id: 'skill:0:3',
          text: '偏好用 node 做文件操作',
          statement: 'user',
          confidence: 'medium',
          status: 'superseded',
          sources: [],
          firstSeenAt: now,
          lastConfirmedAt: now,
        },
        {
          id: 'skill:0:4',
          text: '长期只写 Java',
          statement: 'assistant',
          confidence: 'low',
          status: 'retired',
          deletedAt: now,
          sources: [],
          firstSeenAt: now,
          lastConfirmedAt: now,
        },
      ],
      workstyle: [],
    },
  },
  progress: { digests: 3, evidence: 12, backfill: { active: false, done: 0, total: 0 }, timelinePlan: { removedRows: 3, removedTurns: 1, keptRows: 9 } },
  sessions: [
    {
      sessionId: 'session-1',
      createdAt: now,
      updatedAt: now,
      turnCount: 2,
      rollup: { topic: '做画像插件', overview: '确认扩展点并实现。' },
      turns: [
        {
          turn: 1,
          userAsk: '帮我做个画像插件',
          userKeyPoints: ['要能看图'],
          assistantSummary: '确认扩展点',
          corrections: [{ kind: '红线', text: '不要用 iframe' }],
        },
      ],
    },
  ],
  evidence: [
    {
      key: 'k1',
      kind: 'dimension',
      dimension: 'skill',
      text: '主要使用 Windows',
      confidence: 'high',
      sessionId: 'session-1',
      turn: 2,
      at: now,
      source: '我用的是 Windows',
    },
  ],
  dataDir: '.dsh/user-portrait',
  caps: { mode: 'total', total: 50, daily: 20, tech: 30, usage: { total: 3, daily: 1, tech: 2, manual: 1 } },
  blacklist: { count: 2, turns: 4, updatedAt: now },
  feedbackUrl: '',
  updatedAt: now,
};
let sessionModeFixture = { enabled: true, daily: true, tech: false };
const timelinePlanStats = { rows: 5, turns: 2, protectedTurns: 1, removedTurns: 1, keptRows: 3, removedRows: 2, perTurn: 2 };
let failNextSnapshot = false;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init, body: init?.body });
  if (failNextSnapshot === true && String(url).includes('view=snapshot')) {
    failNextSnapshot = false;
    throw new Error('snapshot 不可用');
  }
  // Maintenance calls answer with their own payload; everything else is a snapshot.
  let body;
  try {
    body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  } catch {
    body = undefined;
  }
  if (String(url).includes('view=sessionMode')) {
    return { status: 200, json: async () => ({ ok: true, mode: sessionModeFixture }) };
  }
  if (body?.op === 'setSessionMode') {
    const next = { ...sessionModeFixture, ...(body.enabled !== undefined ? { enabled: body.enabled } : {}), ...(body.daily !== undefined ? { daily: body.daily } : {}), ...(body.tech !== undefined ? { tech: body.tech } : {}) };
    sessionModeFixture = next;
    return { status: 200, json: async () => ({ ok: true, action: 'setSessionMode', mode: next }) };
  }
  if (body?.op === 'timelinePlan') {
    return { status: 200, json: async () => ({ ok: true, action: 'timelinePlan', stats: timelinePlanStats }) };
  }
  if (body?.op === 'compactTimeline') {
    return { status: 200, json: async () => ({ ok: true, action: 'compactTimeline', removed: timelinePlanStats.removedRows }) };
  }
  return { status: 200, json: async () => snapshotPayload };
};

const registered = [];
const injected = [];
const effects = [];
const slots = {
  inject(key, callback) {
    injected.push(key);
    callback();
    return () => undefined;
  },
  register(options, component) {
    registered.push({ options, component });
    return () => undefined;
  },
};

const services = {
  slots,
  layout: { openRightbar: () => undefined, selectPanel: () => undefined },
  sidebarRight: { openTab: () => undefined },
  // The real registry is PROVIDED by the right sidebar plugin, which has not run
  // when a dependency-free plugin activates. It is therefore absent here too, and
  // the test below hands it over later to prove the deferred registration works.
};

const ctx = {
  slots,
  effect(callback, label) {
    effects.push(label);
    return typeof callback === 'function' ? callback() ?? (() => undefined) : () => undefined;
  },
  on: () => () => undefined,
  get: (name) => services[name],
};

// --------------------------------------------------------------------- run
await import(pathToFileURL(CLIENT).href);
check('registers itself with the module loader', loaded !== undefined);
check('module id is the package name', loaded?.id === PLUGIN_ID, loaded?.id);

// The module table's real vocabulary is exactly the platform seed: React, and
// nothing else this panel may import. An invented word (the old `styles`) must
// throw here exactly as it does in the browser, so the harness cannot pass a
// build the real loader would reject — and it did reject one, which is how the
// blank pane happened.
const module = loaded.factory((name) => {
  if (name === 'react') return React;
  throw new Error(
    `client-modules: require("${name}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory`,
  );
});

check('injects the slots service', Array.isArray(module.inject) && module.inject.includes('slots'), module.inject);
module.apply(ctx);
check('imports nothing beyond the platform seed', loaded !== undefined);
check(
  'owns its stylesheet instead of importing "styles"',
  styleTags.length === 1 && styleTags[0].textContent.includes('.dup-root'),
  styleTags.map((tag) => tag.dataset.pluginCss),
);
check(
  'stamps the style tag the way the module system collects it',
  styleTags[0]?.dataset.plugin === PLUGIN_ID && typeof styleTags[0]?.dataset.pluginCss === 'string',
  styleTags[0]?.dataset,
);
check('the panel root can never collapse to nothing', /\.dup-root\{[^}]*min-height:100%/.test(styleTags[0]?.textContent ?? ''), styleTags[0]?.textContent?.slice(0, 120));
// A reload leaves the previous run's entry in the registry (its disposal never
// ran), so the next registration hits "already registered". That is the desired
// end state, not a failure: it must NOT be reported as a seat failure. This case
// runs FIRST, before this page load has registered anything, so the report is
// fresh and the assertion cannot be masked by one-shot reporting.
const preRegistry = [];
const preSlots = {
  inject(key, callback) {
    callback();
    return () => undefined;
  },
  register(options, component) {
    preRegistry.push({ options, component });
    return () => undefined;
  },
};
const preCtx = {
  slots: preSlots,
  effect: () => () => undefined,
  on: () => () => undefined,
  get: (name) => {
    if (name === 'sidebarRightTabs') {
      return {
        register() {
          throw new Error(`sidebarRight: tab type id "${PLUGIN_ID}" is already registered`);
        },
      };
    }
    if (name === 'layout' || name === 'sidebarRight') return {};
    return undefined;
  },
};
fetchCalls.length = 0;
let preApplyError;
try {
  module.apply(preCtx);
} catch (error) {
  preApplyError = error instanceof Error ? error.message : String(error);
}
check('apply() over an already-registered type does not throw', preApplyError === undefined, preApplyError);
// Read the failures from the injected face the panel itself would receive: the
// self-report channel is deliberately one-shot per stage, so it cannot answer
// this question twice in one page load.
const preBody = preRegistry.find((entry) => entry.options?.name === 'sidebar.right.pane.tab');
const preFace = typeof preBody?.options?.inject === 'function' ? preBody.options.inject() : {};
check('the pre-registered context still registered the panel body', preBody !== undefined, preRegistry.map((entry) => entry.options?.name));
check(
  'an already-registered type is not reported as a failure',
  Array.isArray(preFace?.onSeatFailures) && preFace.onSeatFailures.length === 0,
  preFace?.onSeatFailures,
);

// The registry is PROVIDED by the right sidebar plugin, which has not run when a
// dependency-free plugin activates, so the tab type can only come from the
// deferred attempt. Without it the pane falls back to the host's "unknown type"
// face and looks blank while the body itself registered fine — the failure the
// client self-report caught in the wild.
check('no tab type exists before the registry is provided', registered.every((entry) => entry.tabDefinition === undefined), registered.filter((entry) => entry.tabDefinition));
check('a bounded retry was armed for the missing registry', intervalCallbacks.length >= 1, intervalCallbacks.length);
const armedRetry = intervalCallbacks[0];
const registryCalls = [];
services.sidebarRightTabs = {
  register(definition) {
    registryCalls.push(definition.id);
    // Mirror the real registry: a second registration of one id throws, which is
    // what a reload used to hit ("tab type id … is already registered").
    if (registered.some((entry) => entry.tabDefinition?.id === definition.id)) {
      throw new Error(`sidebarRight: tab type id "${definition.id}" is already registered`);
    }
    registered.push({ tabDefinition: definition });
    return () => {
      const index = registered.findIndex((entry) => entry.tabDefinition === definition);
      if (index !== -1) registered.splice(index, 1);
    };
  },
};
if (typeof armedRetry === 'function') armedRetry();
const lateTabDefinition = registered.find((entry) => entry.tabDefinition)?.tabDefinition;
check(
  'the tab type registers once the registry appears',
  lateTabDefinition?.id === PLUGIN_ID && lateTabDefinition?.kind === 'user-portrait',
  lateTabDefinition,
);
check('tab type uses the extension band', lateTabDefinition?.priority === 'extension', lateTabDefinition?.priority);
check(
  'the deferred registration is reported to the Host as ok',
  fetchCalls.some(
    (call) => typeof call.body === 'string' && call.body.includes('"stage":"tab-type-late"') && call.body.includes('"tabsService":"ok"'),
  ),
  fetchCalls.map((call) => call.body).filter((body) => typeof body === 'string' && body.includes('tab-type')),
);
check('the retry stops after it succeeds', intervalCallbacks.filter(Boolean).length === 0, intervalCallbacks.length);

// Re-running the half (a plugin reload evaluates it again) must not register the
// same tab type twice: the registry throws "already registered", and that throw
// surfaced in the panel as a standing warning.
const registrationsBefore = registered.filter((entry) => entry.tabDefinition).length;
let secondApplyError;
try {
  module.apply(ctx);
} catch (error) {
  secondApplyError = error instanceof Error ? error.message : String(error);
}
check('a second apply() does not throw', secondApplyError === undefined, secondApplyError);
check(
  'a second apply() does not register the tab type twice',
  registered.filter((entry) => entry.tabDefinition).length === registrationsBefore,
  registered.filter((entry) => entry.tabDefinition).map((entry) => entry.tabDefinition.id),
);
// The injected face is the panel's own view of the failures, and unlike the
// one-shot report it is readable after every apply.
const secondBody = registered.find((entry) => entry.options?.name === 'sidebar.right.pane.tab');
const secondFace = typeof secondBody?.options?.inject === 'function' ? secondBody.options.inject() : {};
check(
  'the second apply() reported no seat failures',
  Array.isArray(secondFace?.onSeatFailures) && secondFace.onSeatFailures.length === 0,
  secondFace?.onSeatFailures,
);
check(
  'injects into the three expected slots',
  ['sidebar.right.pane.tab', 'conversation.session.header.utilities', 'settings.section'].every((key) => injected.includes(key)),
  injected,
);

const panelEntry = registered.find((entry) => entry.options?.name === 'sidebar.right.pane.tab');
const headerEntry = registered.find((entry) => entry.options?.name === 'conversation.session.header.utilities');
const settingsEntry = registered.find((entry) => entry.options?.name === 'settings.section');
const tabDefinition = registered.find((entry) => entry.tabDefinition)?.tabDefinition;
// The pane seat dispatches a tab's body with `entryKey: definition?.id ??
// tab.kind`, so the body must be keyed by the tab type's ID. Keying it by the
// kind silently misses the entry and leaves the pane on its "unavailable"
// fallback — a working chip above an empty body, which is exactly how the blank
// pane looked. This assertion is that contract.
check(
  'panel body is keyed by the tab type id, not the kind',
  panelEntry?.options.key !== undefined && panelEntry.options.key === lateTabDefinition?.id,
  { bodyKey: panelEntry?.options.key, typeId: lateTabDefinition?.id, kind: lateTabDefinition?.kind },
);
check('panel body is not keyed by the kind', panelEntry?.options.key !== lateTabDefinition?.kind, panelEntry?.options.key);
check('settings page labels itself', settingsEntry?.options.label() === '人物画像');

const wrapperProps = { ...panelEntry.options.inject() };
check('panel face carries the settings opener', typeof wrapperProps.onOpenSettings === 'function');
const wrapperElement = renderOnce(panelEntry.component, wrapperProps);
check(
  'slot component wraps the panel in its error boundary',
  typeof wrapperElement.type === 'function' && wrapperElement.type.name === 'PortraitBoundary',
  typeof wrapperElement.type,
);
// The boundary's child is the panel itself; a blank pane must never be the
// result of a render throw, so the boundary is part of the contract now.
const panelElement = (wrapperElement.children ?? [])[0];
check('the boundary wraps the inner panel', typeof panelElement?.type === 'function' && panelElement.type.name === 'PortraitPanel', typeof panelElement?.type);
check('slot component forwards the settings opener', panelElement?.props.openSettings === wrapperProps.onOpenSettings);
check('slot component forwards the seat failures', Array.isArray(panelElement?.props.seatFailures), panelElement?.props.seatFailures);

const Panel = panelElement.type;
const panelProps = panelElement.props;

const panelInstance = { hooks: [], cursor: 0, pendingEffects: [] };
const tree = await renderSettled(Panel, panelProps, panelInstance);
const all = texts(tree).join(' ');
// Buttons are wrapper atoms: this harness renders the tree without reconciling
// components, so their text lives on the `label` prop rather than in `.children`.
const buttonLabels = find(tree, (node) => isType(node, 'Button')).map((node) => node.props?.label);
const allWithButtons = [...texts(tree), ...buttonLabels].join(' ');
check('panel requests the Host snapshot', fetchCalls.some((call) => call.url.includes('/api/user-portrait') && call.url.includes('view=snapshot')), fetchCalls.map((call) => call.url));
// React rejects a component whose hook count changes between renders (error
// #310). The panel once held a hook BELOW its loading/error early returns, so the
// first pass called fewer hooks than the second and the whole pane crashed into
// blankness. Every render pass must therefore present the same hook order.
const hookOrders = panelInstance.hookOrders ?? [];
check(
  'the panel keeps one hook order across every render pass',
  hookOrders.length > 0 && hookOrders.every((order) => JSON.stringify(order) === JSON.stringify(hookOrders[0])),
  hookOrders.map((order) => order.length),
);
check(
  'no hook sits below an early return',
  hookOrders.length > 1 && hookOrders[0].length === hookOrders[hookOrders.length - 1].length,
  { first: hookOrders[0]?.length, last: hookOrders[hookOrders.length - 1]?.length },
);
check('renders the panel root', tree?.props?.className === 'dup-root', tree?.props?.className);
check('renders the title', all.includes('人物画像'), all.slice(0, 160));

// --- live updates instead of polling ------------------------------------------
// The panel used to poll the whole snapshot every 20s; it now holds one change
// stream and refreshes only when the Host says the profile moved.
check(
  'the panel no longer polls on a timer',
  !intervalDelays.includes(20000),
  intervalDelays,
);
check('the panel opens the change stream', eventSources.length === 1, eventSources.map((source) => source.url));
check('the stream asks for the stream view', String(eventSources[0]?.url ?? '').includes('view=stream'), eventSources[0]?.url);
const beforePush = fetchCalls.length;
eventSources[0].emit('profile', { updatedAt: now + 1, entries: 3 });
await new Promise((resolve) => setTimeout(resolve, 0));
await renderSettled(Panel, panelProps, panelInstance);
check('a pushed profile change triggers a refresh', fetchCalls.length > beforePush, { before: beforePush, after: fetchCalls.length });
// The same version must not cause a second fetch: the stream is quiet while the
// profile is unchanged.
const afterPush = fetchCalls.length;
eventSources[0].emit('profile', { updatedAt: now + 1, entries: 3 });
await new Promise((resolve) => setTimeout(resolve, 0));
await renderSettled(Panel, panelProps, panelInstance);
check('an unchanged version is ignored', fetchCalls.length === afterPush, { before: afterPush, after: fetchCalls.length });
check('renders the progress line', all.includes('条生效结论'), all.slice(0, 260));
check('renders the dimension catalog', all.includes('能力与技术栈') && all.includes('工作方式') && all.includes('兴趣与爱好'), all.slice(0, 320));
check('renders the entry with its confidence', all.includes('主要使用 Windows') && all.includes('置信度 高'));
// The出处 is collapsed: the entry shows a COUNT, and the session/turn/excerpt sit
// in the hover card (the `title` attribute) instead of on screen.
check('the entry hides its sources behind a count', all.includes('来源 1 处'), all.slice(0, 400));
check('the entry text does not print the session id', !all.includes('session-1#T2'), all.slice(0, 400));
const sourceCountNodes = find(tree, (node) => node.props?.className === 'dup-src-count');
check('the source count carries a hover card', sourceCountNodes.length >= 1, sourceCountNodes.length);
check(
  'the hover card names the session, the turn and the excerpt',
  sourceCountNodes.some((node) => {
    const tip = String(node.props?.title ?? '');
    return tip.includes('session-1') && tip.includes('第 2 轮') && tip.includes('我用的是 Windows');
  }),
  sourceCountNodes.map((node) => node.props?.title),
);
check(
  'the entry states whether it rests on my words or on the reply',
  all.includes('依据 · 用户的话') || all.includes('依据 · 模型应答'),
  all.slice(0, 400),
);
check(
  'an entry inferred from the reply is labelled as such',
  all.includes('依据 · 模型应答'),
  all.slice(0, 500),
);
// A conclusion merged from both bases names both, instead of silently becoming
// either one of them.
const basisChips = find(tree, (node) => isType(node, 'Chip') && String(node.props?.tone) === 'mixed').map((node) => ({
  tone: node.props?.tone,
  text: texts(node).join(''),
}));
check(
  'a mixed conclusion names both bases',
  all.includes('依据 · 用户的话 & 模型应答'),
  all.slice(0, 700),
);
check(
  'the mixed basis is painted with its own tone',
  basisChips.some((chip) => chip.tone === 'mixed' && chip.text.includes('用户的话 & 模型应答')),
  basisChips,
);
check('renders the whole tab strip', all.includes('画像维度') && all.includes('证据时间线') && all.includes('会话记录') && all.includes('检索') && all.includes('我的备注'));
// The tab order is part of the panel's contract: 画像维度、检索、我的备注、会话记录、证据时间线.
const tabOrder = find(tree, (node) => node.props?.className === 'dup-tab').map((node) => texts(node).join(''));
check(
  'the tabs appear in the required order',
  tabOrder.join('|') === '画像维度|我的备注|会话记录|证据时间线',
  tabOrder,
);
check('the first tab is the selected one', find(tree, (node) => node.props?.className === 'dup-tab')[0]?.props?.['data-active'] === true);
check('renders the manual-entry action', allWithButtons.includes('手动新增条目'));
check('renders the maintenance actions', allWithButtons.includes('立即重新提炼') && allWithButtons.includes('回填全部历史会话'));

// Each of the three maintenance entries explains itself on hover: they look alike
// but differ in whether they re-read sessions, what they skip, and what they cost.
const synthesizeTitle = String(byLabel(tree, 'Button', '立即重新提炼')?.props?.title ?? '');
const backfillTitle = String(byLabel(tree, 'Button', '回填全部历史会话')?.props?.title ?? '');
const redigestTitle = String(byLabel(tree, 'Button', '重新提炼全部历史')?.props?.title ?? '');
check(
  '立即重新提炼 explains that it does not re-read sessions',
  synthesizeTitle.includes('不重读会话') && synthesizeTitle.includes('只把现有证据重新合并'),
  synthesizeTitle,
);
check(
  '回填 explains what it skips and how many turns it takes',
  backfillTitle.includes('只补没提炼过的') && backfillTitle.includes('24 轮') && backfillTitle.includes('子代理'),
  backfillTitle,
);
check(
  '重新提炼全部历史 explains that it re-runs without rebuilding',
  redigestTitle.includes('重跑') && redigestTitle.includes('不是重建') && redigestTitle.includes('去重'),
  redigestTitle,
);
check(
  'all three mention the blacklist and the conclusion cap',
  [synthesizeTitle, backfillTitle, redigestTitle].every((title) => title.includes('黑名单')),
  [synthesizeTitle, backfillTitle, redigestTitle].map((title) => title.includes('黑名单')),
);
check(
  'the tooltips are multi-line so they stay readable',
  [synthesizeTitle, backfillTitle, redigestTitle].every((title) => title.split('\n').length >= 4),
  [synthesizeTitle, backfillTitle, redigestTitle].map((title) => title.split('\n').length),
);
check('the data directory lives in the refresh hover', String(byLabel(tree, 'Button', '刷新')?.props?.title ?? '').includes('.dsh/user-portrait'));

// ------------------------------------------------- official-design structure
const controls = find(tree, (node) => isType(node, 'Button'));
const variantOf = (label) => byLabel(tree, 'Button', label)?.props?.variant;
const iconNames = find(tree, (node) => isType(node, 'Button') && typeof node.props?.iconName === 'string').map(
  (node) => node.props.iconName,
);
check(
  'dimension groups are rendered with their labels',
  all.includes('日常画像') && all.includes('技术画像') && all.includes('能力与技术栈、工作方式、风险边界与敏感点'),
  all.slice(0, 400),
);
check('the daily group leads the technical one', all.indexOf('日常画像') < all.indexOf('技术画像'), all.slice(0, 300));
check(
  'the maintenance buttons use the official variants',
  variantOf('立即重新提炼') === 'primary' && variantOf('回填全部历史会话') === 'outline' && variantOf('刷新') === 'outline' && variantOf('反馈与建议') === 'outline',
  controls.map((node) => `${node.props?.label}:${node.props?.variant}`).slice(0, 8),
);
check('the toolbar asks for official glyph names', iconNames.length >= 4, iconNames);
check(
  'no glyph name is missing from the inlined official set',
  iconNames.every((name) => INLINED_GLYPH_KEYS.includes(name)),
  iconNames.filter((name) => !INLINED_GLYPH_KEYS.includes(name)),
);
check(
  'the tab strip is the segmented track with an indicator',
  find(tree, (node) => node.props?.className === 'dup-tab-indicator').length === 1 &&
    find(tree, (node) => isType(node, 'div') && node.props?.className === 'dup-tabs' && node.props?.role === 'tablist').length === 1,
);
const chipLabels = find(tree, (node) => isType(node, 'Chip')).map((node) => ({
  tone: node.props?.tone,
  text: texts(node).join(''),
}));
check(
  'status chips use the tone palette',
  chipLabels.some((chip) => chip.tone === 'success') && chipLabels.some((chip) => chip.tone === 'neutral'),
  chipLabels,
);
// Low confidence reads as a warning (red) rather than a muted grey, so a weak
// conclusion is visible at a glance.
check(
  'a low-confidence entry is rendered with the red tone',
  chipLabels.some((chip) => chip.tone === 'low' && chip.text.includes('置信度 低')),
  chipLabels,
);
check(
  'a high-confidence entry is rendered with the solid tone',
  chipLabels.some((chip) => chip.tone === 'success' && chip.text.includes('置信度 高')),
  chipLabels,
);

// Confidence must move in BOTH directions, but the per-row actions now live behind
// one 编辑 button: five always-visible buttons per conclusion read as a control
// panel, not a portrait.
const firstEntryCard = find(tree, (node) => node.props?.['data-kind'] === 'conclusion' && node.props?.['data-entry-id'])[0];
const entryEditButton = find(firstEntryCard, (node) => isType(node, 'button') && texts(node).join('') === '编辑')[0];
check('each conclusion has one 编辑 control', entryEditButton !== undefined);
check(
  '编辑 sits left of the confidence chip',
  (() => {
    const foot = find(firstEntryCard, (node) => node.props?.className === 'dup-entry-foot')[0];
    // DFS order follows child order, so the first control under the foot row is the
    // one rendered leftmost.
    const firstControl = find(foot, (node) => isType(node, 'button'))[0];
    return firstControl !== undefined && texts(firstControl).join('') === '编辑';
  })(),
  find(firstEntryCard, (node) => node.props?.className === 'dup-entry-foot').length,
);

// The first-seen stamp and the source count are reference detail: both moved out of
// the body, into a hover and into the 依据 line respectively.
check(
  'the first-seen stamp is not a standalone line',
  !texts(firstEntryCard).join('').includes('首次 '),
  texts(firstEntryCard).join('').slice(0, 200),
);
check(
  'the first-seen stamp lives in the status chip hover',
  find(firstEntryCard, (node) => isType(node, 'Chip') && String(node.props?.title ?? '').includes('首次 ')).length === 1,
  find(firstEntryCard, (node) => isType(node, 'Chip')).map((node) => node.props?.title),
);
check(
  'the source count sits with the basis line, not on its own row',
  find(firstEntryCard, (node) => node.props?.['data-inline'] === 'source').length === 1 &&
    find(firstEntryCard, (node) => node.props?.className === 'dup-entry-foot' && find(node, (child) => child.props?.['data-inline'] === 'source').length === 1).length === 1,
  find(firstEntryCard, (node) => node.props?.['data-inline'] === 'source').length,
);
entryEditButton.props.onClick();
const menuTree = await renderSettled(Panel, panelProps, panelInstance);
const menuButtons = find(menuTree, (node) => node.props?.['data-menu'] !== undefined)
  .flatMap((node) => find(node, (child) => isType(child, 'button')))
  .map((node) => texts(node).join(''));
check(
  'the menu offers raising confidence',
  menuButtons.some((text) => ['升为高', '升为中', '已最高'].includes(text)),
  menuButtons,
);
check(
  'the menu offers lowering confidence',
  menuButtons.some((text) => ['降为中', '降为低', '已最低'].includes(text)),
  menuButtons,
);
check(
  'the menu offers 编辑文字 for changing the text',
  menuButtons.includes('编辑文字'),
  menuButtons,
);
check(
  'the menu merges 废弃 and 删除 into the same place',
  menuButtons.some((text) => text === '废弃' || text === '恢复') && menuButtons.includes('删除'),
  menuButtons,
);
// 我的备注 is no longer duplicated inside 画像维度: notes live only in their own tab,
// so the dimensions view starts with what is believed (plus the 废弃 area).
check(
  'no note is rendered inside the dimensions tab',
  !all.includes('我在做 X 项目') && !all.includes('最高优先级'),
  all.slice(0, 400),
);
check(
  'the dimensions tab starts with 检索 and ends with the discard pen',
  all.indexOf('检索') < all.indexOf('日常画像') && all.indexOf('废弃') > all.indexOf('技术画像'),
  { search: all.indexOf('检索'), daily: all.indexOf('日常画像'), tech: all.indexOf('技术画像'), discard: all.indexOf('废弃') },
);

// --- the 废弃 area -------------------------------------------------------------
// It sits at the very bottom of the view: the page reads as the live portrait first,
// and the holding pen is still one click away. It is the ONLY place non-active
// conclusions appear: a dimension shows just what is believed.
/** The discard area's own section, marked semantically by the panel. */
const discardSection = find(tree, (node) => node.props?.['data-section'] === 'discard');
check('the 废弃 section exists', discardSection.length === 1, discardSection.length);
check(
  '废弃 sits below every dimension group',
  all.indexOf('已废弃 / 已取代 / 已删除的结论') > all.indexOf('日常画像') &&
    all.indexOf('已废弃 / 已取代 / 已删除的结论') > all.indexOf('技术画像'),
  { hint: all.indexOf('已废弃 / 已取代 / 已删除的结论'), daily: all.indexOf('日常画像'), tech: all.indexOf('技术画像') },
);
check(
  'the 废弃 area counts the non-active conclusions',
  texts(discardSection[0]).join(' ').includes('2 条'),
  texts(discardSection[0]).join(' '),
);
check(
  'the discard area uses the same card framework as a dimension',
  discardSection[0].props?.className === 'dup-section' &&
    find(discardSection[0], (node) => node.props?.className === 'dup-section-head').length === 1,
  discardSection[0].props?.className,
);
check('the discard area can be expanded', allWithButtons.includes('展开'), buttonLabels);
// Expanding it must reveal the retired / superseded / deleted rows with their
// full cards, which is the point of the area.
// The discard area toggles through its own control; the harness exposes declarative
// wrappers, so look the label up the same way the rest of this file does.
const expandButton = byLabel(tree, 'Button', '展开');
check('the discard area offers an expand control', expandButton !== undefined, buttonLabels);
expandButton.props.onClick();
const discardTree = await renderSettled(Panel, panelProps, panelInstance);
const discardText = texts(discardTree).join(' ');
check(
  'a retired conclusion is listed in the discard area, not in its dimension',
  find(discardTree, (node) => node.props?.['data-status'] === 'retired').length === 1,
  find(discardTree, (node) => node.props?.['data-status']).map((node) => node.props?.['data-status']),
);
check('a superseded conclusion is listed too', find(discardTree, (node) => node.props?.['data-status'] === 'superseded').length === 1);
check('a deleted conclusion is marked as deleted', discardText.includes('删除'));

// --- permanent deletion from the 废弃 area ------------------------------------
// In a dimension, 删除 only moves the conclusion to 废弃; in 废弃 it deletes for
// good, and only after a second click. Both live in the card's 编辑 menu now.
const discardRoot = find(discardTree, (node) => node.props?.['data-section'] === 'discard')[0];
const discardCards = find(discardRoot, (node) => node.props?.['data-kind'] === 'conclusion' && node.props?.['data-entry-id']);
check('the discard area lists its rows as conclusion cards', discardCards.length >= 2, discardCards.length);
const openMenu = async (card) => {
  const button = find(card, (node) => isType(node, 'button') && texts(node).join('') === '编辑')[0];
  button.props.onClick();
  return renderSettled(Panel, panelProps, panelInstance);
};
const firstDiscardMenu = await openMenu(discardCards[0]);
const discardMenuButtons = find(firstDiscardMenu, (node) => node.props?.['data-menu'] !== undefined)
  .flatMap((node) => find(node, (child) => isType(child, 'button')))
  .map((node) => texts(node).join(''));
check(
  'the discard area carries the 恢复 path for a discarded row',
  discardMenuButtons.includes('恢复'),
  discardMenuButtons,
);
check('the discard rows offer a permanent delete control', discardMenuButtons.includes('永久删除'), discardMenuButtons);
const callsBeforeArm = fetchCalls.length;
const purgeButton = find(firstDiscardMenu, (node) => isType(node, 'button') && texts(node).join('') === '永久删除')[0];
purgeButton.props.onClick();
// Arming closes the menu, so the confirmation label is only visible once it is
// reopened — which is exactly what the user does next.
const discardCardId = discardCards[0].props?.['data-entry-id'];
const freshDiscardCard = find(await renderSettled(Panel, panelProps, panelInstance), (node) => node.props?.['data-entry-id'] === discardCardId)[0];
const armedTree = await openMenu(freshDiscardCard);
check('the first click only arms the deletion', fetchCalls.length === callsBeforeArm, {
  before: callsBeforeArm,
  after: fetchCalls.length,
});
check(
  'the armed control asks for confirmation',
  find(armedTree, (node) => isType(node, 'button') && texts(node).join('') === '确认删除？').length === 1,
  find(armedTree, (node) => isType(node, 'button')).map((node) => texts(node).join('')).slice(0, 30),
);
const confirmButton = find(armedTree, (node) => isType(node, 'button') && texts(node).join('') === '确认删除？')[0];
confirmButton.props.onClick();
// The handler is fire-and-forget (`onClick: () => void confirmPurge(...)`), so give
// the request a turn to reach the stub before asserting on it.
await new Promise((resolve) => setTimeout(resolve, 20));
await renderSettled(Panel, panelProps, panelInstance);
check(
  'the second click sends the permanent delete',
  fetchCalls.some((call) => typeof call.body === 'string' && call.body.includes('purgeEntry')),
  fetchCalls.map((call) => call.body).filter(Boolean),
);
// A dimension card keeps the recoverable path: it must never send purgeEntry.
check(
  'only the discard area can delete for good',
  fetchCalls.filter((call) => typeof call.body === 'string' && call.body.includes('purgeEntry')).length === 1,
  fetchCalls.map((call) => call.body).filter((body) => typeof body === 'string' && body.includes('purgeEntry')),
);

// --- one-click clear of the whole discard area --------------------------------
const clearCandidate = find(discardRoot, (node) => isType(node, 'Button') && String(node.props?.label ?? '').includes('清空'));
check('the discard area offers a bulk clear', clearCandidate.length === 1, find(discardRoot, (node) => isType(node, 'Button')).map((node) => node.props?.label));
const callsBeforeClear = fetchCalls.length;
clearCandidate[0].props.onClick();
const armedClearTree = await renderSettled(Panel, panelProps, panelInstance);
check('the first click only arms the clear', fetchCalls.length === callsBeforeClear, {
  before: callsBeforeClear,
  after: fetchCalls.length,
});
const armedClear = find(armedClearTree, (node) => isType(node, 'Button') && String(node.props?.label ?? '').includes('确认清空？'));
check('the armed clear asks for confirmation', armedClear.length === 1, armedClear.length);
armedClear[0].props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
check(
  'the second click clears the discard area',
  fetchCalls.some((call) => typeof call.body === 'string' && call.body.includes('clearDiscard')),
  fetchCalls.map((call) => call.body).filter((body) => typeof body === 'string' && body.includes('clearDiscard')),
);

// --- 导出 / 结论上限 / 反馈与建议 ---------------------------------------------
const settle = () => renderSettled(Panel, panelProps, panelInstance);
const buttonByLabel = (root, label) =>
  find(root, (node) => isType(node, 'Button') && String(node.props?.label ?? '') === label)[0];
const allButtonLabels = (root) => find(root, (node) => isType(node, 'Button')).map((node) => String(node.props?.label ?? ''));

const orderTree = await settle();
const order = allButtonLabels(orderTree);
check(
  'the three controls sit after 手动新增条目 in the asked order',
  order.indexOf('手动新增条目') >= 0 &&
    order.indexOf('手动新增条目') < order.indexOf('结论上限') &&
    order.indexOf('结论上限') < order.indexOf('导出'),
  order,
);
const capButton = buttonByLabel(orderTree, '结论上限');
check(
  'the cap button reports the current budget and the manual exclusion',
  String(capButton?.props?.title ?? '').includes('当前上限') && String(capButton?.props?.title ?? '').includes('手动结论不计入'),
  capButton?.props?.title,
);
const feedbackButton = buttonByLabel(orderTree, '反馈与建议');
check('a 反馈与建议 button sits in the toolbar', feedbackButton !== undefined);
check('the feedback button is disabled while no URL is configured', feedbackButton?.props?.disabled === true, feedbackButton?.props?.disabled);
check(
  'the feedback button explains what is missing',
  String(feedbackButton?.props?.title ?? '').includes('feedbackUrl'),
  feedbackButton?.props?.title,
);
check(
  'the cap hover carries the manual count and the bypass rule',
  String(capButton?.props?.title ?? '').includes('手动新增不受上限阻挡') &&
    String(capButton?.props?.title ?? '').includes('手动结论'),
  capButton?.props?.title,
);
check(
  'the cap hover shows the larger of the two modes',
  String(capButton?.props?.title ?? '').includes('取较大者 50'),
  capButton?.props?.title,
);
check(
  'the panel no longer prints those details as body text',
  find(orderTree, (node) => textsDeep(node).join('').includes('手动新增不受上限阻挡')).length === 0,
);
const refreshHoverButton = buttonByLabel(orderTree, '刷新');
check(
  'the refresh hover carries the stamp, data directory and last refresh',
  ['更新于', '数据目录', '已刷新'].every((part) => String(refreshHoverButton?.props?.title ?? '').includes(part)),
  refreshHoverButton?.props?.title,
);
check(
  'the meta line under the title is gone',
  find(orderTree, (node) => String(node.props?.className ?? '') === 'dup-meta-line').length === 0,
);

// The cap dialog edits either one total or the two group budgets.
buttonByLabel(orderTree, '结论上限').props.onClick();
const capTree = await settle();
const capDialog = find(capTree, (node) => node.props?.['data-dialog'] === 'cap')[0];
check('the cap dialog opens', capDialog !== undefined);
check('the cap dialog offers both modes', buttonByLabel(capTree, '统一上限') !== undefined && buttonByLabel(capTree, '分组上限') !== undefined);
check(
  'the cap dialog shows the current automatic/manual split',
  find(capTree, (node) => textsDeep(node).join('').includes('手动 1 条不计入')).length > 0,
);
buttonByLabel(capTree, '分组上限').props.onClick();
const groupCapTree = await settle();
check(
  'switching to group mode asks for both group budgets',
  find(groupCapTree, (node) => node.props?.['data-cap-field'] === 'daily').length === 1 &&
    find(groupCapTree, (node) => node.props?.['data-cap-field'] === 'tech').length === 1,
);
// The same dialog also owns the per-conclusion character limit.
check(
  'the cap dialog offers a per-conclusion character limit',
  find(groupCapTree, (node) => node.props?.['data-cap-field'] === 'charLimit').length === 1,
  find(groupCapTree, (node) => typeof node.props?.['data-cap-field'] === 'string').map((node) => node.props['data-cap-field']),
);
const charField = find(groupCapTree, (node) => node.props?.['data-cap-field'] === 'charLimit')[0];
charField.props.onChange({ target: { value: '90' } });
const charTree = await renderSettled(Panel, panelProps, panelInstance);
const callsBeforeCapSave = fetchCalls.length;
buttonByLabel(charTree, '保存上限').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
check(
  'saving the dialog sends the character limit',
  fetchCalls
    .slice(callsBeforeCapSave)
    .some((call) => typeof call.body === 'string' && call.body.includes('setEntryCap') && call.body.includes('"charLimit":90')),
  fetchCalls.slice(callsBeforeCapSave).map((call) => call.body),
);
buttonByLabel(charTree, '取消').props.onClick();
await settle();
check('the cap dialog closes again', find(await settle(), (node) => node.props?.['data-dialog'] === 'cap').length === 0);

// Export: five optional fields, all unchecked by default, plus a locked core row.
const exportOpenTree = await settle();
buttonByLabel(exportOpenTree, '导出').props.onClick();
const exportTree = await settle();
check('the export dialog opens', find(exportTree, (node) => node.props?.['data-dialog'] === 'export').length === 1);
const exportFieldsPresent = find(exportTree, (node) => typeof node.props?.['data-export-field'] === 'string').map((node) => node.props['data-export-field']);
check(
  'the export dialog lists the five optional details',
  ['note', 'confidence', 'basis', 'updated', 'source'].every((key) => exportFieldsPresent.includes(key)),
  exportFieldsPresent,
);
check('every optional detail starts unchecked', find(exportTree, (node) => typeof node.props?.['data-export-field'] === 'string' && node.props.checked === true).length === 0);
check(
  'the core fields are shown as locked-on',
  find(exportTree, (node) => node.props?.['data-locked'] === 'true').length === 1,
);

const exportDialog = find(exportTree, (node) => node.props?.['data-dialog'] === 'export')[0];
const downloadsBefore = downloads.length;
// The 导出 label exists twice (the toolbar button and the dialog's confirm); only
// the dialog's own button downloads.
buttonByLabel(exportDialog, '导出').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
const exportDownload = downloads.slice(downloadsBefore).find((item) => item.kind === 'blob');
const markdown = typeof exportDownload?.blob?.parts?.[0] === 'string' ? exportDownload.blob.parts[0] : '';
check('exporting produces a Markdown document', markdown.startsWith('# 人物画像'), markdown.slice(0, 40));
check('the document keeps every dimension and the conclusion', markdown.includes('能力与技术栈') && markdown.includes('主要使用 Windows'), markdown.slice(0, 200));
check('the unchecked details stay out of the document', !markdown.includes('置信度：') && !markdown.includes('来源：'), markdown.slice(0, 300));
check('the download uses a dated file name', downloads.some((item) => item.kind === 'click' && /^user-portrait-\d{4}-\d{2}-\d{2}\.md$/.test(String(item.name))), downloads.filter((item) => item.kind === 'click'));

// Ticking a detail adds exactly that line.
buttonByLabel(await settle(), '导出').props.onClick();
const exportAgain = await settle();
const confidenceBox = find(exportAgain, (node) => node.props?.['data-export-field'] === 'confidence')[0];
confidenceBox.props.onChange({ target: { checked: true } });
const checkedTree = await settle();
const downloadsBeforeChecked = downloads.length;
buttonByLabel(find(checkedTree, (node) => node.props?.['data-dialog'] === 'export')[0], '导出').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
const checkedDownload = downloads.slice(downloadsBeforeChecked).find((item) => item.kind === 'blob');
const checkedMarkdown = typeof checkedDownload?.blob?.parts?.[0] === 'string' ? checkedDownload.blob.parts[0] : '';
check('a ticked detail appears in the document', checkedMarkdown.includes('置信度：高'), checkedMarkdown.slice(0, 300));

// Blacklist: counted on the timeline tab, and clearable.
const blacklistTimeline = await (async () => {
  const tab = find(await settle(), (node) => isType(node, 'button') && texts(node).join('') === '证据时间线')[0];
  tab.props.onClick();
  return settle();
})();
check(
  'the timeline reports the blacklisted evidence',
  find(blacklistTimeline, (node) => node.props?.['data-section'] === 'blacklist').length === 1,
  find(blacklistTimeline, (node) => typeof node.props?.['data-section'] === 'string').map((node) => node.props['data-section']),
);
check(
  'the blacklist bar states the count',
  // The label lives in a primitive's props, not in rendered host text, so the
  // composed element tree is the reliable place to look for it.
  JSON.stringify(blacklistTimeline).includes('已屏蔽 2 条证据 · 4 轮'),
);
check(
  'the blacklist bar no longer explains itself inline',
  !JSON.stringify(blacklistTimeline).includes('来自已废弃或已物理删除的结论'),
);
check(
  'the exclusion sentence lives on 清空黑名单 instead of the header',
  String(buttonByLabel(blacklistTimeline, '清空黑名单')?.props?.title ?? '').includes('因结论被物理删除；重新提炼时不计入'),
  buttonByLabel(blacklistTimeline, '清空黑名单')?.props?.title,
);
const clearCallsBefore = fetchCalls.length;
buttonByLabel(blacklistTimeline, '清空黑名单').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
check(
  'clearing the blacklist reaches the Host',
  fetchCalls.slice(clearCallsBefore).some((call) => typeof call.body === 'string' && call.body.includes('clearBlacklist')),
  fetchCalls.slice(clearCallsBefore).map((call) => call.body),
);

// --- timeline cleanup: preview first, then delete ---------------------------------
check(
  'the timeline advertises a pending cleanup after a re-run',
  find(blacklistTimeline, (node) => textsDeep(node).join('').includes('本次重跑后可清理 3 条无用证据')).length > 0,
  textsDeep(blacklistTimeline).join('').slice(0, 200),
);
const cleanupButton = buttonByLabel(blacklistTimeline, '清理时间线');
check('the timeline offers a cleanup control', cleanupButton !== undefined);
const planCallsBefore = fetchCalls.length;
cleanupButton.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
const cleanupTree = await renderSettled(Panel, panelProps, panelInstance);
check(
  'the cleanup control asks for a preview before deleting',
  fetchCalls.slice(planCallsBefore).some((call) => typeof call.body === 'string' && call.body.includes('timelinePlan')),
  fetchCalls.slice(planCallsBefore).map((call) => call.body),
);
check('the preview dialog opens', find(cleanupTree, (node) => node.props?.['data-dialog'] === 'timeline').length === 1);
check(
  'the preview states what would be removed and kept',
  find(cleanupTree, (node) => textsDeep(node).join('').includes('将删除 2 条') && textsDeep(node).join('').includes('保留 3 条')).length > 0,
  textsDeep(cleanupTree).join('').slice(0, 300),
);
const compactCallsBefore = fetchCalls.length;
buttonByLabel(cleanupTree, '确认清理').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
check(
  'confirming the preview sends the compaction',
  fetchCalls.slice(compactCallsBefore).some((call) => typeof call.body === 'string' && call.body.includes('compactTimeline')),
  fetchCalls.slice(compactCallsBefore).map((call) => call.body),
);
// The dimension card must show ONLY live conclusions — retired rows belong to the
// discard area, so a dimension reads as what is currently believed. Subtrees marked
// `data-section=discard` are skipped, since the discard area mirrors the same card
// framework (that is the point) and therefore contains non-active rows by design.
function collectOutsideDiscard(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectOutsideDiscard(child, out);
    return out;
  }
  if (node.props?.['data-section'] === 'discard') return out;
  if (node.props?.className === 'dup-section') out.push(node);
  const children = node.children ?? node.props?.children ?? [];
  for (const child of Array.isArray(children) ? children : [children]) collectOutsideDiscard(child, out);
  return out;
}
const dimensionSections = collectOutsideDiscard(tree);
check(
  'a dimension card lists only active conclusions',
  dimensionSections.length > 0 &&
    dimensionSections.every((section) =>
      find(section, (node) => node.props?.['data-kind'] === 'conclusion').every((entry) => entry.props?.['data-status'] === 'active'),
    ),
  dimensionSections.map((section) =>
    find(section, (node) => node.props?.['data-kind'] === 'conclusion').map((entry) => entry.props?.['data-status']),
  ),
);
check(
  'every conclusion card carries an explicit status',
  find(tree, (node) => node.props?.['data-kind'] === 'conclusion').length > 0 &&
    find(tree, (node) => node.props?.['data-kind'] === 'conclusion').every((entry) => typeof entry.props?.['data-status'] === 'string'),
  find(tree, (node) => node.props?.['data-kind'] === 'conclusion').map((entry) => entry.props?.['data-status']),
);
check(
  'no note cards appear in the dimensions view',
  find(tree, (node) => node.props?.['data-kind'] === 'note').length === 0,
  find(tree, (node) => node.props?.['data-kind'] === 'note').length,
);
check(
  'the discarded rows live in the discard area',
  find(discardTree, (node) => node.props?.['data-section'] === 'discard').length === 1 &&
    find(discardTree, (node) => node.props?.['data-status'] === 'retired').length === 1,
  find(discardTree, (node) => node.props?.['data-status']).map((node) => node.props?.['data-status']),
);
check(
  'the retired row lives under the 废弃 heading, after the dimension head',
  discardText.indexOf('能力与技术栈') < discardText.indexOf('长期只写 Java'),
  discardText.slice(0, 300),
);

// The low-confidence chip must be the SAME component and geometry as the
// high-confidence one — only the colour differs (red instead of green).
check(
  'low confidence uses the same chip component as high',
  chipLabels.some((chip) => chip.tone === 'low' && chip.text.includes('置信度 低')) &&
    chipLabels.some((chip) => chip.tone === 'success' && chip.text.includes('置信度 高')),
  chipLabels,
);
check(
  'no legacy underline action links remain',
  find(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dup-link')).length === 0,
);

// A mutation must surface its outcome in the tinted status bar, and must still
// restore the panel when the Host rejects it.
const refreshButton = byLabel(tree, 'Button', '刷新');
const synthButton = byLabel(tree, 'Button', '立即重新提炼');
check('refresh and synthesise controls are both present', refreshButton !== undefined && synthButton !== undefined);
// A failed re-read must report through the error bar while keeping the last
// good snapshot on screen.
failNextSnapshot = true;
await refreshButton.props.onClick();
const noticeTree = await renderSettled(Panel, panelProps, panelInstance);
const noticeBars = find(noticeTree, (node) => isType(node, 'StatusBar'));
check(
  'a failed refresh reports through the error status bar',
  noticeBars.some((node) => node.props?.tone === 'error' && String(node.props?.text).includes('snapshot 不可用')),
  noticeBars.map((node) => `${node.props?.tone}:${node.props?.text}`),
);
check(
  'a failed refresh keeps the last good snapshot on screen',
  texts(noticeTree).join(' ').includes('主要使用 Windows') && !texts(noticeTree).join(' ').includes('读取失败：snapshot 不可用'),
);

// A successful mutation replaces that bar with the success tone.
await synthButton.props.onClick();
const successTree = await renderSettled(Panel, panelProps, panelInstance);
check(
  'a successful mutation reports through the success status bar',
  find(successTree, (node) => isType(node, 'StatusBar') && node.props?.tone === 'success').length === 1,
);
check(
  'the synthesise call reached the Host with the maintain body',
  fetchCalls.some((call) => typeof call.body === 'string' && call.body.includes('synthesizeNow')),
  fetchCalls.map((call) => call.body).filter(Boolean),
);

// --- the refresh button -------------------------------------------------------
// It used to re-read silently, so with unchanged data it looked broken. It now
// reports what came back.
const freshRefreshButton = byLabel(successTree, 'Button', '刷新');
check('the refresh control is present', freshRefreshButton !== undefined);
const beforeRefresh = fetchCalls.length;
await freshRefreshButton.props.onClick();
const refreshedTree = await renderSettled(Panel, panelProps, panelInstance);
const refreshedText = texts(refreshedTree).join(' ');
/** Status bars carry their message in props, not as child text. */
const statusTexts = (root) => find(root, (node) => isType(node, 'StatusBar')).map((node) => String(node.props?.text ?? ''));
check('refresh re-reads the snapshot', fetchCalls.length > beforeRefresh, { before: beforeRefresh, after: fetchCalls.length });
check(
  'refresh reports what came back',
  statusTexts(refreshedTree).some((text) => text.startsWith('已刷新') && text.includes('条生效')),
  statusTexts(refreshedTree),
);
check(
  'the last refresh time is shown in the refresh hover',
  /已刷新 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(byLabel(refreshedTree, 'Button', '刷新')?.props?.title ?? '')),
  String(byLabel(refreshedTree, 'Button', '刷新')?.props?.title ?? ''),
);

// --- the finished-backfill banner is not permanent ----------------------------
// It used to render forever: `total > 0` stayed true after the run ended.
const progressBackup = snapshotPayload.progress;
snapshotPayload.progress = { ...progressBackup, backfill: { active: false, total: 17, done: 17, finishedAt: Date.now() } };
const bannerFresh = statusTexts(await renderSettled(Panel, panelProps, panelInstance));
check('a just-finished backfill is announced', bannerFresh.includes('历史回填已完成：17/17'), bannerFresh);
snapshotPayload.progress = { ...progressBackup, backfill: { active: false, total: 17, done: 17, finishedAt: Date.now() - 9000 } };
const bannerOld = statusTexts(await renderSettled(Panel, panelProps, panelInstance));
check('an old backfill result is gone', !bannerOld.some((text) => text.includes('历史回填已完成')), bannerOld);
snapshotPayload.progress = { ...progressBackup, backfill: { active: true, total: 17, done: 3 } };
const bannerRunning = statusTexts(await renderSettled(Panel, panelProps, panelInstance));
check('a running backfill keeps its progress', bannerRunning.includes('历史回填进行中：3/17'), bannerRunning);
// A state-driven effect never re-fires in this harness (it mounts once), so the
// watch is asserted against the source: `load()` must arm a 2s re-read while the
// run is active.
check(
  'a running backfill arms a two-second re-read',
  /backfill\?\.active === true\)\s*\{[\s\S]{0,400}?setTimeout\(\(\) => \{[\s\S]{0,200}?\}, 2000\)/.test(CLIENT_SOURCE),
  'no 2000ms re-read is armed from load()',
);
check(
  'the finished banner counts down from finishedAt',
  /finishedAt = Number\(info\.finishedAt \?\? 0\)[\s\S]{0,400}?BACKFILL_BANNER_MS - \(Date\.now\(\) - finishedAt\)/.test(CLIENT_SOURCE),
  'the countdown does not start at finishedAt',
);
snapshotPayload.progress = { ...progressBackup, backfill: { active: false, total: 17, done: 17, finishedAt: Date.now() } };
const bannerAfterFinish = statusTexts(await renderSettled(Panel, panelProps, panelInstance));
check(
  'the finished result replaces the progress line',
  bannerAfterFinish.includes('历史回填已完成：17/17') && !bannerAfterFinish.some((text) => text.includes('进行中')),
  bannerAfterFinish,
);
snapshotPayload.progress = progressBackup;
await renderSettled(Panel, panelProps, panelInstance);

const tabs = find(tree, (node) => isType(node, 'button') && node.props?.className === 'dup-tab');
check('tab strip has four buttons', tabs.length === 4, tabs.length);

const clickTab = async (label) => {
  const button = tabs.find((tab) => texts(tab).join('') === label);
  if (button === undefined) throw new Error(`no tab labelled ${label}`);
  button.props.onClick();
  return await renderSettled(Panel, panelProps, panelInstance);
};

const timelineTree = await clickTab('证据时间线');
const timelineText = texts(timelineTree).join(' ');
check('timeline lists evidence', timelineText.includes('主要使用 Windows'));
check('timeline shows the origin session', timelineText.includes('session-1#T2'));
check('timeline does not print the excerpt inline', !timelineText.includes('我用的是 Windows'), timelineText.slice(0, 260));
check('timeline marks the basis of each row', timelineText.includes('依据 · 用户的话'), timelineText.slice(0, 260));
check(
  'the timeline row keeps the excerpt in its hover card',
  find(timelineTree, (node) => node.props?.className === 'dup-src-count').some((node) =>
    String(node.props?.title ?? '').includes('我用的是 Windows'),
  ),
  find(timelineTree, (node) => node.props?.className === 'dup-src-count').map((node) => node.props?.title),
);

const sessionTree = await clickTab('会话记录');
const sessionText = texts(sessionTree).join(' ');
check('session tab shows the roll-up topic', sessionText.includes('做画像插件'), sessionText.slice(0, 260));
check('session tab shows what I asked', sessionText.includes('帮我做个画像插件'));
check('session tab shows my key points', sessionText.includes('要能看图'));
check('session tab shows the answer summary', sessionText.includes('确认扩展点'));
check('session tab shows my correction', sessionText.includes('不要用 iframe'));

const notesTree = await clickTab('我的备注');
const notesText = texts(notesTree).join(' ');
check('notes tab lists my note', notesText.includes('我在做 X 项目'));
check('notes tab states the authority rule', notesText.includes('优先级高于任何自动结论'));

// --- pinned 检索 inside 画像维度 -----------------------------------------------
// It used to be its own tab whose button posted to the Host and discarded the
// reply, so pressing it produced nothing. It now filters the conclusions that are
// already in memory, so every keystroke narrows the list.
const searchSection = find(tree, (node) => node.props?.['data-section'] === 'search');
check('检索 is pinned inside 画像维度', searchSection.length === 1, searchSection.length);
check(
  '检索 sits above the discard area and the dimension groups',
  all.indexOf('检索') < all.indexOf('已废弃 / 已取代 / 已删除的结论') && all.indexOf('检索') < all.indexOf('日常画像'),
  { search: all.indexOf('检索'), discard: all.indexOf('已废弃 / 已取代 / 已删除的结论'), daily: all.indexOf('日常画像') },
);
check(
  '检索 states what it searches',
  texts(searchSection[0]).join(' ').includes('输入关键词，即时筛选画像结论'),
  texts(searchSection[0]).join(' ').slice(0, 120),
);
/** Type into the pinned search box and re-render. */
async function typeSearch(base, value) {
  const box = find(base, (node) => node.type === 'input' && typeof node.props?.placeholder === 'string' && node.props.placeholder.includes('检索'))[0];
  box.props.onChange({ target: { value } });
  return renderSettled(Panel, panelProps, panelInstance);
}
// The earlier tabs changed the active view, so return to 画像维度 where 检索 lives.
const dimsTree = await clickTab('画像维度');
const searchTree = await typeSearch(dimsTree, 'Windows');
const searchText = texts(searchTree).join(' ');
const searchBlock = find(searchTree, (node) => node.props?.['data-section'] === 'search')[0];
// `highlight` splits the text into several nodes, so compare without whitespace.
const searchBlockText = texts(searchBlock).join(' ').replace(/\s+/gu, '');
check('typing filters the conclusions immediately', searchText.includes('2 条命中'), searchText.slice(0, 220));
check('a matching conclusion is listed', searchBlockText.includes('主要使用Windows'), searchBlockText.slice(0, 200));
check('only the matching conclusion is listed as a hit', !searchBlockText.includes('看起来熟悉PowerShell'), searchBlockText.slice(0, 300));
check('a hit carries the dimension it belongs to', searchBlockText.includes('能力与技术栈'));
check('the hit is marked with the query', find(searchTree, (node) => node.type === 'mark').some((node) => texts(node).join('') === 'Windows'));
check(
  'the profile list below the search stays complete',
  searchText.includes('看起来熟悉 PowerShell'),
  searchText.slice(searchText.indexOf('废弃'), searchText.indexOf('废弃') + 200),
);
const missTree = await typeSearch(searchTree, '完全不存在的词');
const missText = texts(missTree).join(' ');
check('a miss is reported, not silent', missText.includes('没有命中的结论'), missText.slice(0, 200));
check('the miss offers a way back', byLabel(missTree, 'Button', '清空') !== undefined, (() => find(missTree, (node) => isType(node, 'Button')).map((node) => node.props?.label))());

// Search covers the architecture but not the raw records: the panel answers
// "what does the portrait believe", not "what was said".
check('no evidence-timeline content leaks into the search results', !searchText.includes('session-1#T2'), searchText.slice(0, 300));

const headerElement = renderOnce(headerEntry.component, { ...headerEntry.options.inject() });
check('header action is a labelled button', headerElement?.type === 'button' && headerElement.props['aria-label'] === '打开人物画像面板', headerElement?.type);
check('header action carries a click handler', typeof headerElement.props.onClick === 'function');

const settingsElement = renderOnce(settingsEntry.component, { close: () => undefined });
check('settings page renders the inner panel', typeof settingsElement.type === 'function' && settingsElement.type.name === 'PortraitPanel', typeof settingsElement.type);

// --- resilience: one failing contribution must not blank the pane -----------
// The seat service isolates a throwing entry, so a half-completed apply() used to
// present as a blank pane with nothing in any log. Each seat now contributes
// independently and reports what failed through the panel's own props.
const resilientRegistered = [];
const resilientSlots = {
  inject(key, callback) {
    callback();
    return () => undefined;
  },
  register(options, component) {
    resilientRegistered.push({ options, component });
    return () => undefined;
  },
};
const resilientFailures = [];
const resilientCtx = {
  slots: resilientSlots,
  effect: () => () => undefined,
  on: () => () => undefined,
  get: (name) => {
    if (name === 'sidebarRightTabs') {
      return {
        register() {
          throw new Error('duplicate tab type');
        },
      };
    }
    if (name === 'layout' || name === 'sidebarRight') return {};
    return undefined;
  },
};
let applyThrew = false;
try {
  module.apply(resilientCtx);
} catch (error) {
  applyThrew = true;
  resilientFailures.push(error.message);
}
check('a failing tab registration does not abort apply()', applyThrew === false, resilientFailures);
check(
  'the panel body still registers when the tab type fails',
  resilientRegistered.some((entry) => entry.options?.name === 'sidebar.right.pane.tab'),
  resilientRegistered.map((entry) => entry.options?.name),
);
const resilientProps = resilientRegistered.find((entry) => entry.options?.name === 'sidebar.right.pane.tab')?.options.inject?.() ?? {};
check(
  'the failure is reported to the panel instead of vanishing',
  Array.isArray(resilientProps.onSeatFailures) &&
    resilientProps.onSeatFailures.some((line) => line.includes('duplicate tab type')),
  resilientProps.onSeatFailures,
);
if (Array.isArray(resilientProps.onSeatFailures) && resilientProps.onSeatFailures.length > 0) {
  const resilientTree = await renderSettled(
    Panel,
    { openSettings: undefined, seatFailures: resilientProps.onSeatFailures },
    { hooks: [], cursor: 0, pendingEffects: [] },
  );
  check(
    'the panel shows the registration failure',
    textsDeep(resilientTree).join(' ').includes('入口注册失败'),
    textsDeep(resilientTree).join(' ').slice(0, 160),
  );
}

// The error boundary must turn a render throw into readable text, never blank.
const boundaryPrototype = wrapperElement.type.prototype;
const boundaryInstance = Object.create(boundaryPrototype);
boundaryInstance.props = { children: null };
boundaryInstance.state = { error: 'boom' };
const fallback = boundaryPrototype.render.call(boundaryInstance);
check(
  'the error boundary renders a readable failure face',
  textsDeep(fallback).join(' ').includes('面板渲染失败') && textsDeep(fallback).join(' ').includes('boom'),
  textsDeep(fallback).join(' ').slice(0, 160),
);
check(
  'the boundary passes children through when nothing failed',
  (() => {
    boundaryInstance.state = { error: undefined };
    const child = { type: 'div', props: {}, children: ['x'] };
    boundaryInstance.props = { children: child };
    return boundaryPrototype.render.call(boundaryInstance) === child;
  })(),
);

// --- the composer portrait switch ------------------------------------------------
// It registers beside the permission selector and edits the per-session mode.
const modeSeat = registered.find((entry) => entry.options?.id === 'user-portrait-mode');
check('a composer portrait switch is registered', modeSeat !== undefined, registered.map((entry) => entry.options?.id));
check(
  'it registers into the list slot beside the permission selector',
  modeSeat?.options?.name === 'conversation.input.left',
  modeSeat?.options,
);
check(
  'it never touches the single permission slot',
  !registered.some((entry) => entry.options?.name === 'conversation.input.permission'),
  registered.map((entry) => entry.options?.name),
);
const modeInstance = { hooks: [], cursor: 0, pendingEffects: [], hookOrders: [] };
const modeProps = modeSeat?.options?.inject?.('session-1') ?? {};
const modeTree = await renderSettled(modeSeat.component, modeProps, modeInstance);
const modeTrigger = find(modeTree, (node) => node.props?.className === 'dup-mode-trigger')[0];
check('the switch reads the session mode from the Host', fetchCalls.some((call) => call.url.includes('view=sessionMode') && call.url.includes('session=session-1')));
check('the trigger reflects the enabled state', modeTrigger?.props?.['data-on'] === true, modeTrigger?.props?.['data-on']);
modeTrigger.props.onClick();
const modeOpen = await renderSettled(modeSeat.component, modeProps, modeInstance);
check('clicking the trigger opens the popover', find(modeOpen, (node) => node.props?.['data-pop'] === 'portrait-mode').length === 1);
const modeSwitches = find(modeOpen, (node) => node.props?.className === 'dup-mode-switch');
check('the popover offers three switches', modeSwitches.length === 3, modeSwitches.map((node) => node.props?.['data-key']));
check(
  'the group switch shows the stored value',
  modeSwitches.find((node) => node.props?.['data-key'] === 'tech')?.props?.['aria-checked'] === false,
  modeSwitches.map((node) => [node.props?.['data-key'], node.props?.['aria-checked']]),
);
const callsBeforeToggle = fetchCalls.length;
await modeSwitches.find((node) => node.props?.['data-key'] === 'daily').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
check(
  'toggling a group writes the session mode',
  fetchCalls.slice(callsBeforeToggle).some((call) => typeof call.body === 'string' && call.body.includes('setSessionMode') && call.body.includes('"daily":false')),
  fetchCalls.slice(callsBeforeToggle).map((call) => call.body),
);

console.log('\n--- registered slots ---');
for (const key of injected) console.log(`  ${key}`);
console.log(`--- renders: ${renderCount}; hooks: ${[...new Set(hookNames)].join(', ')} ---`);
console.log(`--- host requests: ${fetchCalls.length} ---`);
finish('CLIENT HARNESS PASSED');
