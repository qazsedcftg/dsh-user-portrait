/**
 * Sensitive-value masking. Anything the user pastes can contain a credential,
 * and portrait data is durable plain text, so values are masked before they are
 * written to disk or handed to a background model call.
 *
 * @module dsh-user-portrait/redact
 */

/** Paired-key patterns: the value after the key is replaced, the key is kept. */
const SECRET_ASSIGNMENT = /((?:api[_-]?key|apikey|secret|token|access[_-]?token|refresh[_-]?token|password|passwd|pwd|authorization|auth|bearer|client[_-]?secret|private[_-]?key|session[_-]?id|cookie)\s*["']?\s*[:=]\s*["']?)([^\s"',;)}\]]{4,})/gi;

/** Standalone token shapes that are almost never ordinary prose. */
const SECRET_SHAPES = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

const REPLACEMENT = '[已脱敏]';

/**
 * Mask credential-looking values in one text.
 * @param text - arbitrary text.
 * @returns the masked text.
 */
export function maskSecrets(text) {
  if (typeof text !== 'string' || text === '') return '';
  let masked = text.replace(SECRET_ASSIGNMENT, (_match, prefix) => `${prefix}${REPLACEMENT}`);
  for (const pattern of SECRET_SHAPES) masked = masked.replace(pattern, REPLACEMENT);
  return masked;
}

/**
 * Mask and clip one text block for durable storage or a model prompt.
 * @param text - arbitrary text.
 * @param limit - maximum characters to keep.
 * @returns the masked, clipped text.
 */
export function maskAndClip(text, limit) {
  const masked = maskSecrets(text);
  if (masked.length <= limit) return masked;
  return `${masked.slice(0, limit)}\n…[已截断 ${masked.length - limit} 字]`;
}
