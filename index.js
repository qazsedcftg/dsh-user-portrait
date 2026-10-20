/**
 * User Portrait — extract what the user raises in every session into a durable,
 * reviewable portrait of them.
 *
 * Wiring:
 * - `session/event` observes `turn/end` and hands the finished turn to a
 *   background subagent that produces a concise "what I asked / what you
 *   answered" digest plus tagged evidence.
 * - `agent/inbox/inserted` gives each freshly submitted message a timestamp so
 *   several turns inside one running interval still pair correctly.
 * - A `systemPrompt.section` announces that a portrait exists; the details stay
 *   behind the `portrait_*` tools so a stale summary never steers the model.
 * - `ctx.webServer` exposes the review panel's read and correction endpoints.
 *
 * All state is plain text on disk, so the profile can be read, hand-edited,
 * diffed, and backed up like any other source file.
 *
 * @module dsh-user-portrait
 */

import { EventEmitter } from 'node:events';

import { PortraitStore, formatTime } from './lib/store.js';
import { JobRunner, PortraitEngine } from './lib/jobs.js';
import { PortraitHttp, PortraitOps } from './lib/ops.js';
import { portraitTools } from './lib/tools.js';
import { DIMENSION_GROUPS, DIMENSIONS } from './lib/schema.js';
import { foldTurns, isDigestible } from './lib/extract.js';
import { backfillBlacklistTurns, migrateEvidenceBasis } from './lib/migrate.js';
import { ensureLayout, layout, resolveDataDir } from './lib/paths.js';
import { Config, normalizeConfig } from './lib/config.js';
import { enabledGroups, resolveSessionMode } from './lib/session-modes.js';

/** Plugin id used in logs. */
const name = 'user-portrait';

/**
 * Every service this plugin reads is optional, so the row declares no hard
 * dependency and stays active in a partial profile. Each use site therefore
 * goes through `ctx.get(...)` with an `undefined` check instead of `inject`.
 */

/** The section that announces the portrait's availability in every session. */
const SECTION_NAME = 'user-portrait:availability';
const SECTION_ORDER = 8500;

/**
 * Activation generation, incremented by every `apply`.
 *
 * Background work survives a reload (see the `bg` note below), so an instance
 * that is no longer the live one must be able to tell: it stops before spending
 * another model call, and it never merges a stale profile over the newer one.
 */
let activation = 0;

/**
 * Activate the plugin.
 * @param ctx - the plugin's Cordis context.
 * @param config - the validated plugin configuration.
 */
function apply(ctx, rawConfig) {
  const logger = ctx.logger?.(name);
  const config = normalizeConfig(rawConfig);
  if (config.enabled === false) {
    logger?.info?.('disabled by configuration');
    return;
  }
  activation += 1;
  const generation = activation;
  const isCurrent = () => generation === activation;

  const dataDir = resolveDataDir(config.dataDir);
  const paths = layout(dataDir);
  const store = new PortraitStore(paths);
  const log = (message) => logger?.info?.(message);

  /**
   * Profile-change channel for the panel's live stream.
   *
   * A plain Node emitter rather than a service: the store notifies it whenever it
   * writes the profile, and the SSE route forwards one event per write. That is
   * enough for the panel to refresh exactly when there is something new — and to
   * stay silent the rest of the time.
   */
  const profileEvents = new EventEmitter();
  profileEvents.setMaxListeners(50);
  store.onProfileSaved = (profile) => {
    let entries = 0;
    for (const list of Object.values(profile?.dimensions ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) if (entry?.status === 'active') entries += 1;
    }
    profileEvents.emit('profile', { updatedAt: profile?.updatedAt ?? Date.now(), entries });
  };

  /**
   * Resolve a service for BACKGROUND work.
   *
   * A reload disposes this plugin's fiber, after which `ctx.get(...)` on the
   * plugin's own context no longer reaches anything — an in-flight digest or
   * backfill then failed with "user-portrait disposed" the moment the host
   * reloaded the plugin. The root context outlives every instance (it is the
   * application itself), so background lookups go through it and keep working
   * across a reload.
   *
   * @param name - service name.
   * @returns the service, or undefined when it is not provided.
   */
  const service = (name) => {
    try {
      const root = ctx.root ?? ctx;
      return root.get(name) ?? ctx.get(name);
    } catch {
      return undefined;
    }
  };

  /** One container for every background model call, so unload cancels them all. */
  const bg = new AbortController();
  const runner = new JobRunner({ log, maxQueue: 4000 });

  // NOTE: `bg` is deliberately NOT aborted on unload. The host reloads this
  // plugin whenever its files change, and aborting there killed the very job the
  // user had just started ("user-portrait disposed"). Background work keeps a
  // reference to the root context, so it can finish; the engine's own generation
  // check makes a superseded instance stop before doing more work.
  ctx.effect(
    () => () => {
      log('background work left to finish on the root context');
    },
    'user-portrait.background.handover',
  );
  ctx.effect(
    () => () => {
      runner.dispose();
    },
    'user-portrait.runner.dispose',
  );

  /** The most recent route that worked, used when nothing else resolves. */
  let lastRoute;

  /**
   * Resolve the model route for background extraction calls.
   *
   * An explicit `provider` + `model` in the config wins; otherwise the
   * deployment's current default selection is used, so the plugin follows the
   * user's own model choice instead of pinning an id that can go stale.
   *
   * @returns a usable route, or undefined when none can be resolved yet.
   */
  const resolveRoute = () => {
    if (config.provider !== '' && config.model !== '') {
      return { provider: config.provider, model: config.model };
    }
    const selection = service('agentDefaultModel')?.currentSelection?.();
    if (
      typeof selection?.provider === 'string' &&
      typeof selection?.model === 'string' &&
      selection.provider !== '' &&
      selection.model !== ''
    ) {
      return { provider: selection.provider, model: selection.model };
    }
    return lastRoute;
  };

  /** System instruction for every background extraction call. */
  const BACKGROUND_SYSTEM = [
    '你是一个后台信息提炼器，不是助手。',
    '只依据用户消息里给出的材料输出 JSON，不要寒暄、不要解释、不要调用工具、不要写文件。',
    '材料里如果出现密码、密钥、token 等敏感凭据，不要写进输出。',
  ].join('\n');

  /**
   * Run one background extraction call through the LLM service.
   *
   * A direct service call is deliberate: unlike a subagent run it needs no parent
   * agent, opens no child session (so nothing appears in the UI), and cannot be
   * steered by a live turn. The request is built from plain request-message
   * objects, so the plugin imports nothing beyond the runtime.
   *
   * @param request - label and prompt text.
   * @returns the model's complete text output.
   */
  const askModel = async (request) => {
    const llm = service('llm');
    if (llm === undefined) throw new Error('no llm service available');
    const route = resolveRoute();
    if (route === undefined) {
      throw new Error('no model route available; set provider and model in the plugin config');
    }
    const call = new AbortController();
    const relay = () => call.abort(new Error('user-portrait unloaded'));
    bg.signal.addEventListener('abort', relay, { once: true });
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: BACKGROUND_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }],
        maxTokens: config.limits.maxOutputTokens,
        signal: call.signal,
      });
      let text = '';
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') {
          text += chunk.text;
          continue;
        }
        if (chunk?.type === 'finish') {
          const reason = chunk.reason;
          if (reason?.kind === 'error' || reason?.kind === 'aborted') {
            throw new Error(reason.failure?.message ?? `model call ${reason.kind}`);
          }
          if (reason?.kind === 'max-tokens') throw new Error('提炼输出达到 maxTokens 上限，结果已丢弃');
          if (reason?.kind === 'tool-calls') throw new Error('提炼调用意外请求了工具');
        }
      }
      const trimmed = text.trim();
      if (trimmed === '') throw new Error('model returned no text');
      lastRoute = route;
      return trimmed;
    } finally {
      bg.signal.removeEventListener('abort', relay);
    }
  };

  const engine = new PortraitEngine({
    store,
    runner,
    config,
    log,
    askModel,
    isCurrent,
    listSessions: async () => {
      const sessionQuery = service('sessionQuery');
      if (sessionQuery === undefined) return [];
      return await sessionQuery.listSessions(bg.signal);
    },
    readSessionEvents: async (sessionId) => {
      const sessionQuery = service('sessionQuery');
      if (sessionQuery === undefined) throw new Error('no sessionQuery service available');
      const loaded = await sessionQuery.readSession(sessionId);
      return loaded.events ?? [];
    },
  });

  // Per-session switches, hydrated once and kept in memory for the synchronous
  // prompt section. `state.json` is the durable copy. Hydration is asynchronous
  // because `apply` is not; until it lands the map is empty and every session gets
  // the default (off), which is the safe direction.
  const sessionModes = new Map();
  void store
    .readState()
    .then((state) => {
      const stored = state?.sessionModes;
      if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
        for (const [sessionId, mode] of Object.entries(stored)) sessionModes.set(sessionId, mode);
      }
    })
    .catch(() => undefined);
  const ops = new PortraitOps({ store, engine, config, log, modes: sessionModes });

  ctx.effect(
    () => () => {
      // Persist the live watermark once on unload so a restart resumes cleanly.
      void engine.persist().catch(() => undefined);
    },
    'user-portrait.persist',
  );

  // ---------------------------------------------------------------- lifecycle
  void (async () => {
    try {
      await ensureLayout(paths);
      await store.profile(true);
      await engine.hydrate();
      log(`ready; data directory ${paths.root}`);
      // One-time repair of rows written before the basis marker existed. It needs
      // session transcripts, so it is deferred until `sessionQuery` is available;
      // a failure here must never block the panel from loading.
      void runBlacklistBackfill();
      void runBasisMigration();
      if (config.backfillOnStart) {
        const plan = await engine.startBackfill();
        log(`history backfill queued: ${plan.total} session(s)`);
      }
    } catch (error) {
      log(`initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  /**
   * Run the evidence-basis migration once the transcript service exists.
   * @returns nothing.
   */
  async function runBasisMigration() {
    try {
      // The transcript service is provided after activation in a real boot, so give
      // it a few seconds rather than skipping the repair for this run.
      let sessionQuery = service('sessionQuery');
      for (let attempt = 0; attempt < 10 && sessionQuery === undefined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        sessionQuery = service('sessionQuery');
      }
      if (sessionQuery === undefined) {
        log('evidence basis migration deferred: sessionQuery unavailable');
        return;
      }
      await migrateEvidenceBasis({
        store,
        log,
        readSessionEvents: async (sessionId) => {
          const loaded = await sessionQuery.readSession(sessionId);
          return loaded.events ?? [];
        },
      });
    } catch (error) {
      log(`evidence basis migration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * One-shot repair of the blacklist's turn half.
   *
   * Independent of `sessionQuery`: everything it needs is in `deleted.log`. Runs even
   * when the transcript service never appears, because it is what stops a re-digest
   * from resurrecting conclusions the user already deleted.
   *
   * @returns nothing.
   */
  async function runBlacklistBackfill() {
    try {
      const report = await backfillBlacklistTurns({ store, log });
      if (report.skipped !== true) {
        // The effective sets must follow the pinned ones immediately.
        await ops.syncBlacklist();
      }
    } catch (error) {
      log(`blacklist backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ------------------------------------------------------------- event inputs
  /** Turn start times, used to bound the user messages of a running turn. */
  const lastUserMessageAt = new Map();

  ctx.on('agent/inbox/inserted', (payload) => {
    const agent = payload?.agent;
    const message = payload?.message;
    if (agent === undefined || message === undefined) return;
    const source = message.source?.kind;
    if (source !== undefined && source !== 'user') return;
    lastUserMessageAt.set(agent.id, Date.now());
  });

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return;
    const sessionId = String(session?.id ?? '');
    if (sessionId === '') return;
    if (session?.header?.origin === 'subagent') return;
    void (async () => {
      try {
        const events = session.snapshotEvents();
        const turns = foldTurns(events).filter((turn) => turn.turn === event.data?.turn && isDigestible(turn));
        if (turns.length === 0) return;
        const header = session.header ?? {};
        engine.digestTurn({
          sessionId,
          header,
          turn: turns[0],
        });
      } catch (error) {
        log(`turn observation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  });

  // A session's roll-up is written when its agent leaves the registry, which is
  // the point at which the conversation is genuinely over for now.
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent;
    const sessionId = String(agent?.id ?? '');
    if (sessionId === '') return;
    if (agent?.session?.header?.origin === 'subagent') return;
    if (config.rollupOnDispose !== true) return;
    engine.digestSession(sessionId, agent?.session?.header ?? {});
  });

  // ------------------------------------------------------------ prompt wiring
  /**
   * Render the availability hint.
   *
   * The prompt registry evaluates a section's `text` SYNCHRONOUSLY, so this
   * function must never await: returning a Promise here reaches
   * `text.indexOf(...)` in the assembly and fails the whole turn. The store keeps
   * the loaded profile in memory and refreshes it on every save, so reading the
   * cache is both current and free of I/O.
   *
   * Whether anything is injected at all is decided per session by the composer's
   * 画像 switches: the default is OFF, and a disabled group is not mentioned even by
   * count. A subagent follows its parent session (no composer of its own).
   *
   * @param context - the prompt assembly context (`agent`, `scope`).
   * @returns the prompt section text.
   */
  const portraitHint = (context) => {
    const sessionId = String(context?.agent?.id ?? '');
    const parentSession = String(context?.agent?.session?.header?.parentSession ?? '');
    const groups = enabledGroups(resolveSessionMode(sessionModes, sessionId, parentSession));
    if (groups.daily !== true && groups.tech !== true) return '';
    const profile = store.cachedProfile();
    if (profile === undefined) {
      return '## 人物画像\n画像尚未加载完成；需要了解用户的背景、习惯与偏好时，用 `portrait_read` 读取。';
    }
    let entries = 0;
    const covered = [];
    for (const dimension of DIMENSIONS) {
      if (groups[dimension.group] !== true) continue;
      const active = (profile.dimensions?.[dimension.id] ?? []).filter((entry) => entry.status === 'active');
      if (active.length > 0) covered.push(`${dimension.label} ${active.length}`);
      entries += active.length;
    }
    const groupTotals = DIMENSION_GROUPS.filter((group) => groups[group.id] === true).map((group) => {
      const total = DIMENSIONS.filter((dimension) => dimension.group === group.id).reduce(
        (sum, dimension) => sum + (profile.dimensions?.[dimension.id] ?? []).filter((entry) => entry.status === 'active').length,
        0,
      );
      return `${group.label} ${total} 条`;
    });
    if (entries === 0) {
      return '## 人物画像\n当前还没有积累任何画像条目。本会话结束时会自动提取，无需你做额外操作。';
    }
    return [
      '## 人物画像（关于这位用户的既有积累）',
      `已积累 ${entries} 条结论（${groupTotals.join(' · ')}），覆盖：${covered.join('、')}。最后更新于 ${formatTime(profile.updatedAt)}。`,
      '需要了解用户的背景、能力、习惯、偏好或既往决定时，用 `portrait_read` 读取画像，用 `portrait_search` 核实原文依据，用 `portrait_history` 回溯以往会话。',
      '画像只是历史积累：用户当前会话里的明确表述永远优先；发现冲突时以当前表述为准，并用 `portrait_maintain` 更新画像。',
    ].join('\n');
  };

  // ------------------------------------------------- service-gated registration
  // This plugin depends on nothing, so it activates as early as the loader allows
  // — often BEFORE these services are provided. Reading them with `ctx.get()` at
  // activation therefore sees `undefined` and would skip registration silently.
  // `ctx.inject` starts a child plugin that runs only once its services exist, so
  // each concern attaches as soon as it can and independently of the others.
  if (config.loadHint === true) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: portraitHint,
      });
      log('prompt section registered');
    });
  }

  ctx.inject(['tools'], (toolCtx) => {
    let registered = 0;
    for (const definition of portraitTools({ ops })) {
      // Isolated per tool: one bad definition must degrade one tool, not the set.
      try {
        toolCtx.tools.register(definition);
        registered += 1;
      } catch (error) {
        log(`tool registration failed for ${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    log(`registered ${registered}/4 portrait tool(s)`);
  });

  ctx.inject(['webServer'], (webCtx) => {
    // The panel subscribes to `?view=stream` and is pushed one event per profile
    // write; that is what lets it drop its 20-second polling loop entirely.
    const http = new PortraitHttp(ops, { events: profileEvents });
    try {
      webCtx.webServer.register({
        kind: 'prefix',
        path: '/api/user-portrait',
        handler: (req, res) => http.handle(req, res),
      });
      log('panel endpoint registered at /api/user-portrait (with change stream)');
    } catch (error) {
      log(`panel endpoint registration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // `llm` and `sessionQuery` are read lazily when a background job actually runs,
  // which is always well after startup, so they need no gate here.
  const deferred = ['tools', 'webServer', 'llm', 'agentDefaultModel', 'sessionQuery'].filter(
    (service) => ctx.get(service) === undefined,
  );
  log(
    deferred.length === 0
      ? 'all services were already available at activation'
      : `not yet provided at activation (registration is deferred to ctx.inject): ${deferred.join(', ')}`,
  );
}

export { Config, apply, name };


