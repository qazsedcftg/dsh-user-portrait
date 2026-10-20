/**
 * Boot the real client bundle against the real React, under the module system's
 * own resolution rules, to surface the error the browser swallows.
 *
 * Run with the bundled DSH node binary:
 *   node test/portrait-boot-check.mjs
 *
 * Why a simulation instead of the browser: the shell's live console is not
 * reachable from here, and a failing client half leaves nothing in the Host log
 * — the slot service isolates the throwing entry. This harness therefore
 * reproduces the two things that decide the outcome:
 *   1. `require` resolves ONLY the platform seed words, exactly like
 *      dsh-client-modules `makeRequire` (anything else throws).
 *   2. React is the app's own react 18.3.1, evaluated in a Node vm with the
 *      DOM globals the panel touches.
 * It then walks the returned plugin's registration surface and renders the
 * panel element tree the same way the slot seat would.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

import { APP_PACKAGE_JSON, CLIENT, PLUGIN_ID, skip } from './_paths.mjs';

if (APP_PACKAGE_JSON === undefined) skip('no DSH application found; set DSH_APP_ROOT to run the boot simulation');
const REQUIRE_FROM = APP_PACKAGE_JSON;

import { check, finish } from './_harness.mjs';

// --------------------------------------------------------------- real react
const appRequire = createRequire(REQUIRE_FROM);
const React = appRequire('react');
console.log(`# react ${React.version ?? 'unknown'}`);

// --------------------------------------------------------- the module table
/** The platform seed words, from the shell's static module table. */
const SEED_WORDS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]);

const requireAttempts = [];
function makeRequire() {
  return (spec) => {
    requireAttempts.push(spec);
    if (spec === 'react') return React;
    // The real loader's message, so a failure here reads like the browser's.
    throw new Error(
      `client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory`,
    );
  };
}

// ------------------------------------------------------------- DOM globals
const styleTags = [];
const createdElements = [];
function makeStyle() {
  return {
    dataset: {},
    textContent: '',
    setAttribute() {},
    getAttribute(name) {
      const key = name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return this.dataset[key] ?? null;
    },
    remove() {
      this.removed = true;
    },
  };
}
const document = {
  head: { appendChild: (tag) => styleTags.push(tag) },
  createElement(tagName) {
    createdElements.push(tagName);
    return makeStyle();
  },
  querySelector(selector) {
    const wanted = /^style\[data-plugin-css="(.*)"\]$/.exec(String(selector));
    if (wanted === null) return null;
    return styleTags.find((tag) => tag.dataset.pluginCss === wanted[1]) ?? null;
  },
  querySelectorAll: () => styleTags,
};

let loadedRegistration;
const sandbox = {
  React,
  document,
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => undefined,
  fetch: async () => ({ status: 200, json: async () => ({ ok: true, groups: [], dimensions: [], profile: { dimensions: {}, notes: [] }, progress: {}, sessions: [], evidence: [], dataDir: 'x', updatedAt: 0 }) }),
  URL,
  Date,
  Math,
  JSON,
  Number,
  String,
  Object,
  Array,
  Map,
  Set,
  Error,
  Promise,
  Symbol,
  RegExp,
};
sandbox.window = {
  location: { origin: 'http://127.0.0.1:43120' },
  setInterval: () => 0,
  clearInterval: () => undefined,
  __ModuleLoader__: {
    load(registration) {
      loadedRegistration = registration;
    },
  },
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const source = await readFile(CLIENT, 'utf8');
const context = vm.createContext(sandbox);
try {
  vm.runInContext(source, context, { filename: CLIENT });
  check('the bundle evaluates and calls the module loader', loadedRegistration !== undefined);
} catch (error) {
  check('the bundle evaluates and calls the module loader', false, error.message);
}

check('it registers under the package id', loadedRegistration?.id === PLUGIN_ID, loadedRegistration?.id);

// ------------------------------------------------- evaluate the plugin factory
let plugin;
try {
  plugin = loadedRegistration.factory(makeRequire());
  check('the factory runs without throwing', true);
} catch (error) {
  check('the factory runs without throwing', false, `${error.message}\n${error.stack?.split('\n').slice(0, 4).join('\n')}`);
}
console.log(`# requires attempted in order: ${JSON.stringify(requireAttempts)}`);
const foreign = requireAttempts.filter((spec) => !SEED_WORDS.has(spec));
check('it only requires platform seed words', foreign.length === 0, foreign);
check('it requires react', requireAttempts.includes('react'), requireAttempts);

// ---------------------------------------------------------------- activate it
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
  sidebarRightTabs: { register: (definition) => registered.push({ tabDefinition: definition }) },
  layout: { selectPanel: () => undefined, openRightbar: () => undefined },
  sidebarRight: { openTab: () => undefined },
};
const ctx = {
  slots,
  effect(callback, label) {
    effects.push(label);
    return typeof callback === 'function' ? callback() ?? (() => undefined) : () => undefined;
  },
  get: (name) => services[name],
  on: () => () => undefined,
};

try {
  plugin.apply(ctx);
  check('apply() completes without throwing', true);
} catch (error) {
  check('apply() completes without throwing', false, `${error.message}\n${error.stack?.split('\n').slice(0, 5).join('\n')}`);
}

check('it registered into the pane tab seat', injected.includes('sidebar.right.pane.tab'), injected);
check(
  'the stylesheet went into the document head',
  styleTags.length === 1 && typeof styleTags[0].textContent === 'string' && styleTags[0].textContent.includes('.dup-root'),
  styleTags.map((tag) => tag.dataset.pluginCss),
);

// ------------------------------------------------- render the panel for real
const seat = registered.find((entry) => entry.options?.name === 'sidebar.right.pane.tab');
check('the pane seat has a component', typeof seat?.component === 'function', typeof seat?.component);

if (typeof seat?.component === 'function') {
  // The seat passes the entry's own injected props; the panel expects optional
  // ones, so render with the real shape the sidebar gives it.
  const injectedProps = typeof seat.options.inject === 'function' ? seat.options.inject() : {};
  let element;
  try {
    element = seat.component({ ...(injectedProps ?? {}) });
    check('the slot component returns an element', element !== null && typeof element === 'object', typeof element);
  } catch (error) {
    check('the slot component returns an element', false, `${error.message}\n${error.stack?.split('\n').slice(0, 5).join('\n')}`);
  }

  // Walk the tree calling wrapper components, exactly as React would, so a
  // wrapper that throws surfaces here rather than as a blank pane.
  const walkErrors = [];
  const seen = new Set();
  function walk(node, depth) {
    if (node === null || node === undefined || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth);
      return;
    }
    if (typeof node.type === 'function') {
      const name = node.type.name || 'anonymous';
      if (seen.has(node.type)) return;
      seen.add(node.type);
      // Class components (the error boundary) only render through React's
      // reconciler; there is no way to invoke them as a plain function, so the
      // boundary itself is checked by the harness that inspects its fallback.
      if (node.type.prototype?.isReactComponent !== undefined) return;
      let rendered;
      try {
        rendered = node.type(node.props ?? {});
      } catch (error) {
        walkErrors.push(`${name}: ${error.message}`);
        return;
      }
      walk(rendered, depth + 1);
      return;
    }
    const children = node.props?.children ?? node.children ?? [];
    for (const child of Array.isArray(children) ? children : [children]) walk(child, depth + 1);
  }
  try {
    walk(element, 0);
  } catch (error) {
    walkErrors.push(`walk: ${error.message}`);
  }
  check('every component in the panel renders without throwing', walkErrors.length === 0, walkErrors);
}

finish('BOOT SIMULATION PASSED');
