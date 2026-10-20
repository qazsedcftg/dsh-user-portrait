/**
 * Plugin configuration, expressed as a Standard Schema validator.
 *
 * Cordis resolves a plugin's config with `runtime.Config['~standard'].validate`,
 * so a plain object implementing that one method is enough and the plugin needs
 * no schema library at all — which also keeps the bundle free of imports that
 * would have to resolve from the installation's own `node_modules`.
 *
 * @module dsh-user-portrait/config
 */

/** Character budgets and cadence defaults. */
export const DEFAULTS = {
  // Fold every finished turn's evidence in (the per-turn path only calls the model
  // for the dimensions that turn actually touched, and skips turns with no new
  // evidence). Set higher to batch turns again.
  synthesizeEveryTurns: 1,
  /** Coalescing window for the per-turn synthesis (0 = run immediately). */
  turnSynthesisDelayMs: 3000,
  minEvidenceForSynthesis: 3,
  perUserMessage: 6000,
  perAssistantTurn: 4000,
  synthesisEvidence: 80,
  maxOutputTokens: 4000,
  sessionRollupMinTurns: 3,
  provider: '',
  model: '',
  /**
   * Where the panel's 反馈与建议 button goes.
   *
   * Deliberately empty by default: the button stays disabled until a URL is
   * configured, rather than opening a page nobody asked for.
   */
  feedbackUrl: '',
};

/**
 * Coerce one value to a string, or its fallback.
 * @param value - candidate value.
 * @param fallback - value used when the candidate is unusable.
 * @returns the string value.
 */
function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Coerce one value to a boolean, or its fallback.
 * @param value - candidate value.
 * @param fallback - value used when the candidate is unusable.
 * @returns the boolean value.
 */
function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Coerce one value to a whole number within bounds, or its fallback.
 * @param value - candidate value.
 * @param fallback - value used when the candidate is unusable.
 * @param minimum - smallest accepted value.
 * @returns the number value.
 */
function asCount(value, fallback, minimum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

/**
 * Resolve a raw config row into the shape the plugin uses.
 * @param raw - the loader row's config value.
 * @returns the normalized configuration.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const limits = source.limits !== null && typeof source.limits === 'object' ? source.limits : {};
  return {
    dataDir: asString(source.dataDir, '').trim(),
    enabled: asBoolean(source.enabled, true),
    loadHint: asBoolean(source.loadHint, true),
    backfillOnStart: asBoolean(source.backfillOnStart, true),
    synthesizeEveryTurns: asCount(source.synthesizeEveryTurns, DEFAULTS.synthesizeEveryTurns, 0),
    // How long the per-turn synthesis waits to coalesce a burst of turns. 0 makes
    // it run immediately, which tests and very small models may prefer.
    turnSynthesisDelayMs: asCount(source.turnSynthesisDelayMs, DEFAULTS.turnSynthesisDelayMs, 0),
    minEvidenceForSynthesis: asCount(source.minEvidenceForSynthesis, DEFAULTS.minEvidenceForSynthesis, 1),
    provider: asString(source.provider, DEFAULTS.provider).trim(),
    model: asString(source.model, DEFAULTS.model).trim(),
    rollupOnDispose: asBoolean(source.rollupOnDispose, true),
    sessionRollupMinTurns: asCount(source.sessionRollupMinTurns, DEFAULTS.sessionRollupMinTurns, 1),
    feedbackUrl: asString(source.feedbackUrl, DEFAULTS.feedbackUrl).trim(),
    limits: {
      perUserMessage: asCount(limits.perUserMessage, DEFAULTS.perUserMessage, 200),
      perAssistantTurn: asCount(limits.perAssistantTurn, DEFAULTS.perAssistantTurn, 200),
      synthesisEvidence: asCount(limits.synthesisEvidence, DEFAULTS.synthesisEvidence, 5),
      maxOutputTokens: asCount(limits.maxOutputTokens, DEFAULTS.maxOutputTokens, 256),
    },
  };
}

/**
 * The plugin's `Config` export: a Standard Schema whose validation never fails,
 * because every field has a sensible default and an unusable value falls back
 * rather than disabling the plugin.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'user-portrait',
    /**
     * Validate and normalize one config row.
     * @param value - the raw config.
     * @returns the validated value.
     */
    validate(value) {
      return { value: normalizeConfig(value) };
    },
  },
};
