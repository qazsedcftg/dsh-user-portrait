/**
 * Per-session portrait switches.
 *
 * Whether the portrait is injected into a session's prompt is a per-session choice,
 * persisted in `state.json` under `sessionModes`. The defaults are deliberately
 * conservative: **off**, so a conversation only sees the portrait when the user
 * turns it on next to the permission selector.
 *
 * @module dsh-user-portrait/session-modes
 */

/** What a session starts with when it has never been configured. */
export const DEFAULT_SESSION_MODE = Object.freeze({ enabled: false, daily: true, tech: true });

/**
 * Coerce one stored value into a complete mode document.
 * @param value - raw stored mode.
 * @returns `{ enabled, daily, tech }`.
 */
export function normalizeSessionMode(value) {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const flag = (input, fallback) => (typeof input === 'boolean' ? input : fallback);
  return {
    enabled: flag(source.enabled, DEFAULT_SESSION_MODE.enabled),
    daily: flag(source.daily, DEFAULT_SESSION_MODE.daily),
    tech: flag(source.tech, DEFAULT_SESSION_MODE.tech),
  };
}

/**
 * Resolve the mode that applies to one session.
 *
 * A subagent session has no composer of its own, so it follows its parent: an
 * explicit setting on the subagent wins, otherwise the parent's mode is used.
 *
 * @param modes - Map of sessionId -> stored mode.
 * @param sessionId - the session being assembled.
 * @param parentSession - its parent session id, when it is a subagent.
 * @returns the effective mode.
 */
export function resolveSessionMode(modes, sessionId, parentSession) {
  const direct = modes instanceof Map ? modes.get(sessionId) : undefined;
  if (direct !== undefined) return normalizeSessionMode(direct);
  const parent = modes instanceof Map && typeof parentSession === 'string' ? modes.get(parentSession) : undefined;
  if (parent !== undefined) return normalizeSessionMode(parent);
  return { ...DEFAULT_SESSION_MODE };
}

/**
 * Which dimension groups the mode lets through.
 * @param mode - a normalized mode.
 * @returns `{ daily, tech }`.
 */
export function enabledGroups(mode) {
  const safe = normalizeSessionMode(mode);
  if (safe.enabled !== true) return { daily: false, tech: false };
  return { daily: safe.daily, tech: safe.tech };
}
