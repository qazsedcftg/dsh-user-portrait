/**
 * Shared path resolution for the test suites.
 *
 * The suites used to carry absolute author-machine paths. Resolving from this
 * file instead keeps them portable: the plugin root is the parent directory, the
 * DSH installation is discovered from the environment or from the running Node
 * binary, and the two suites that replay real portrait data skip cleanly when no
 * sample data is present.
 *
 * @module test/_paths
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

/** Directory containing the suites. */
export const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** The plugin package root. */
export const PLUGIN_ROOT = resolve(TEST_DIR, '..');

const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));

/** Package id, read from package.json so a rename touches one line only. */
export const PLUGIN_ID = manifest.name;

/** The client half's source file. */
export const CLIENT = join(PLUGIN_ROOT, 'client.js');

/** True when a directory looks like an unpacked DSH application. */
function looksLikeApp(directory) {
  return existsSync(join(directory, 'package.json')) && existsSync(join(directory, 'node_modules', '@deepseek-ai'));
}

/** Locate the DSH application, which supplies the runtime validators and React. */
function findAppRoot() {
  const candidates = [];
  if (process.env.DSH_APP_ROOT) candidates.push(process.env.DSH_APP_ROOT);
  // A checkout inside the desktop workspace: <app>/work-space/plugins/<pkg>.
  candidates.push(resolve(PLUGIN_ROOT, '..', '..', '..', 'resources', 'app'));
  let directory = dirname(process.execPath);
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(directory, join(directory, 'resources', 'app'));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const candidate of candidates) {
    if (looksLikeApp(candidate)) return candidate;
  }
  return undefined;
}

/** The unpacked DSH application, or undefined on a machine without one. */
export const APP_ROOT = findAppRoot();

/** The runtime's JSON-schema helpers. */
export const RUNTIME_TOOLS = APP_ROOT === undefined ? undefined : join(APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');

/** The official UI primitives package that owns the inlined icon geometry. */
export const PRIMITIVES = APP_ROOT === undefined ? undefined : join(APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'index.js');

/** A package.json from the application, used as the resolution base for React. */
export const APP_PACKAGE_JSON = APP_ROOT === undefined ? undefined : join(APP_ROOT, 'package.json');

/** A real portrait directory to replay, or undefined when none is available. */
export function portraitDataDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  const candidates = [
    process.env.PORTRAIT_DATA,
    join(home, 'user-portrait'),
    // A workspace-local copy, used when the suite runs from the author's checkout.
    resolve(PLUGIN_ROOT, '..', '..', '.dsh', 'user-portrait'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Exit successfully with an explicit SKIP line. A suite that cannot run on this
 * machine must say so: silently printing "0 failed" is how a broken run once
 * looked green.
 * @param reason - why this suite is skipping.
 */
export function skip(reason) {
  console.log(`SKIP ${reason}`);
  process.exit(0);
}
