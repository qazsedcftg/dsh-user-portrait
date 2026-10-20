/**
 * Regression check for the bug where an async prompt-section provider failed
 * every turn with `text.indexOf is not a function`.
 *
 * The contract: a `systemPrompt.section` text provider is evaluated
 * SYNCHRONOUSLY by the prompt registry, so it must return a string, never a
 * Promise. This imports the real plugin, applies it, and inspects the value
 * without awaiting it.
 */
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PLUGIN_ROOT } from './_paths.mjs';

const PLUGIN = join(PLUGIN_ROOT, 'index.js');

import { check, finish } from './_harness.mjs';

/** Apply the plugin against a mock context over a throwaway data directory. */
async function applyPlugin(dataDir) {
  const sections = [];
  const tools = [];
  const logs = [];
  const logger = Object.assign((m) => logs.push(String(m)), {
    info: (m) => logs.push(String(m)),
    warn: (m) => logs.push(`WARN ${String(m)}`),
    error: (m) => logs.push(`ERROR ${String(m)}`),
  });
  const services = {
    tools: { register: (d) => { tools.push(d); return () => undefined; } },
    systemPrompt: { section: (s) => { sections.push(s); return () => undefined; } },
    webServer: { register: () => () => undefined },
  };
  const ctx = {
    logger: () => logger,
    effect: (callback) => (typeof callback === 'function' ? callback() ?? (() => undefined) : () => undefined),
    on: () => () => undefined,
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
  const module = await import(`${pathToFileURL(PLUGIN).href}?v=${Date.now()}`);
  module.apply(ctx, { dataDir, backfillOnStart: false });
  // Let the plugin's asynchronous initialization finish loading the profile.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { sections, tools, logs };
}

const dataDir = await mkdtemp(join(tmpdir(), 'portrait-sync-'));
// The composer switch is off by default, so the prompt section only renders for a
// session that opted in — seed one before the plugin activates.
await mkdir(dataDir, { recursive: true });
await writeFile(join(dataDir, 'state.json'), JSON.stringify({ sessionModes: { 'session-sync': { enabled: true, daily: true, tech: true } } }), 'utf8');
try {
  // --- case 1: empty portrait (cache not yet populated at first call)
  const first = await applyPlugin(dataDir);
  check('registers exactly one prompt section', first.sections.length === 1, first.sections.length);
  const section = first.sections[0];
  const syncContext = { agent: { id: 'session-sync' } };
  const emptyRaw = section.text(syncContext);
  check('section provider returns a STRING, not a Promise', typeof emptyRaw === 'string', typeof emptyRaw);
  check('section text is not thenable', emptyRaw === null || typeof emptyRaw?.then !== 'function', typeof emptyRaw?.then);
  check('empty-state text mentions no entries yet', emptyRaw.includes('还没有积累'), emptyRaw.slice(0, 120));
  check('section text contains no {{variable}} reference', !emptyRaw.includes('{{'), emptyRaw.slice(0, 120));
  check('section order is a finite number', Number.isFinite(section.order), section.order);

  // --- case 2: a populated portrait, so the hint switches branch
  const profile = {
    version: 1,
    updatedAt: Date.now(),
    synthesizedTurns: 2,
    lastSynthesisAt: Date.now(),
    notes: [],
    dimensions: {
      skill: [
        {
          text: '主要使用 Windows',
          confidence: 'high',
          status: 'active',
          sources: [{ sessionId: 'session-1', turn: 2 }],
          firstSeenAt: 1,
          lastConfirmedAt: 2,
        },
      ],
      workstyle: [
        {
          text: '喜欢先看方案再动手',
          confidence: 'medium',
          status: 'active',
          sources: [],
          firstSeenAt: 1,
          lastConfirmedAt: 2,
        },
      ],
    },
  };
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'profile.json'), JSON.stringify(profile), 'utf8');
  const second = await applyPlugin(dataDir);
  const populatedRaw = second.sections[0].text(syncContext);
  check('populated provider still returns a STRING', typeof populatedRaw === 'string', typeof populatedRaw);
  check('populated hint counts the active entries', populatedRaw.includes('2 条结论'), populatedRaw.slice(0, 200));
  check(
    'populated hint names the covered dimensions and groups',
    populatedRaw.includes('能力与技术栈 1') && populatedRaw.includes('工作方式 1') && populatedRaw.includes('日常画像'),
    populatedRaw.slice(0, 240),
  );
  check('populated hint points at the reading tools', populatedRaw.includes('portrait_read'), populatedRaw.slice(0, 260));
  check('populated hint states the current-statement-wins rule', populatedRaw.includes('优先'), populatedRaw.slice(0, 320));

  // --- case 3: the exact failing call shape from the shipped registry
  const text = second.sections[0].text(syncContext);
  let indexOfError = null;
  try {
    // dsh-system-prompt does exactly this on the provider's return value.
    text.indexOf('{{');
  } catch (error) {
    indexOfError = error instanceof Error ? error.message : String(error);
  }
  check('survives the registry\'s own text.indexOf("{{") call', indexOfError === null, indexOfError);

  // --- case 4: no tool or provider may hand the framework a Promise either
  const asyncProviders = [];
  for (const tool of second.tools) {
    if (tool.output?.render !== undefined && tool.output.render.constructor.name === 'AsyncFunction') {
      asyncProviders.push(`${tool.name}.output.render`);
    }
    if (typeof tool.parameters !== 'object') asyncProviders.push(`${tool.name}.parameters`);
  }
  check('no tool output.render is async', asyncProviders.length === 0, asyncProviders);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

finish('REGRESSION CHECK PASSED');
