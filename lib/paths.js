/**
 * Resolve where portrait data lives. The directory is plain text on disk so it
 * can be read, hand-edited, diffed, and backed up like any other source file.
 *
 * A relative `dataDir` resolves against the process working directory, which is
 * the workspace the Host was started in; the shipped patch sets
 * `.dsh/user-portrait`, so the portrait lives beside the work it describes.
 *
 * @module dsh-user-portrait/paths
 */

import { isAbsolute, join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';

/**
 * Resolve the configured data directory.
 * @param configured - the plugin's `dataDir` config value; empty means the default.
 * @returns an absolute directory path.
 */
export function resolveDataDir(configured) {
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (value === '') {
    const home = process.env.DSH_HOME;
    return join(home !== undefined && home.trim() !== '' ? home : join(homedir(), '.dsh'), 'user-portrait');
  }
  return isAbsolute(value) ? value : resolve(value);
}

/**
 * The directory layout, created on first use.
 * @param dataDir - absolute data directory.
 * @returns every named path the plugin writes.
 */
export function layout(dataDir) {
  return {
    root: dataDir,
    profile: join(dataDir, 'profile.json'),
    profileMarkdown: join(dataDir, 'profile.md'),
    evidence: join(dataDir, 'evidence.jsonl'),
    turns: join(dataDir, 'turns'),
    sessions: join(dataDir, 'sessions'),
    views: join(dataDir, 'views'),
    state: join(dataDir, 'state.json'),
    clientReport: join(dataDir, 'client-report.json'),
    /** Append-only audit trail for conclusions deleted for good. */
    deletedLog: join(dataDir, 'deleted.log'),
    /** Evidence rows that must never re-enter extraction (set by permanent deletes). */
    blacklist: join(dataDir, 'blacklist.json'),
  };
}

/**
 * Create every directory in the layout.
 * @param paths - the layout produced by {@link layout}.
 */
export async function ensureLayout(paths) {
  for (const dir of [paths.root, paths.turns, paths.sessions, paths.views]) {
    await mkdir(dir, { recursive: true });
  }
}
