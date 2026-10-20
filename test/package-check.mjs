#!/usr/bin/env node
/**
 * Release gate: the facts `npm publish` cannot check for us.
 *
 * Verifies the manifest a registry will accept, that every path the manifest
 * promises exists, that no author-machine path leaked into a shipped file, and
 * that the version in package.json is also in CHANGELOG.md.
 *
 * Usage: `npm run check:package`
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const check = (label, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${condition || detail === undefined ? '' : ` :: ${detail}`}`);
  if (!condition) failures.push(label);
};
const read = (path) => readFile(join(ROOT, path), 'utf8');
const exists = async (path) => {
  try {
    await stat(join(ROOT, path));
    return true;
  } catch {
    return false;
  }
};

const manifest = JSON.parse(await read('package.json'));

check('name is a publishable package id', /^[a-z0-9][a-z0-9._~-]*$/.test(manifest.name), manifest.name);
check('private flag is gone', manifest.private !== true, manifest.private);
check('version is semver', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version), manifest.version);
check('license is declared', typeof manifest.license === 'string' && manifest.license.length > 0, manifest.license);
check('description is present', typeof manifest.description === 'string' && manifest.description.length > 20);
check('engines.dsh is declared', typeof manifest.engines?.dsh === 'string', manifest.engines);
check('repository is a GitHub URL', /^git\+https:\/\/github\.com\/[^/]+\/[^/]+\.git$/.test(manifest.repository?.url ?? ''), manifest.repository);
check('homepage points at the same repository', (manifest.homepage ?? '').startsWith(`https://github.com/${(manifest.repository?.url ?? '').replace(/^git\+https:\/\/github\.com\//, '').replace(/\.git$/, '')}`), manifest.homepage);
check('bugs points at the repository issues', /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues$/.test(manifest.bugs?.url ?? ''), manifest.bugs);
check('type is module', manifest.type === 'module', manifest.type);
check('dsh.bundle.patch points at a file', typeof manifest.dsh?.bundle?.patch === 'string' && (await exists(manifest.dsh.bundle.patch)), manifest.dsh?.bundle?.patch);
check('dsh.client declares the web platform', manifest.dsh?.client?.platform === 'web', manifest.dsh?.client?.platform);

for (const [key, target] of Object.entries(manifest.exports ?? {})) {
  if (target.includes('*')) continue;
  check(`exports["${key}"] exists`, await exists(target), target);
}
check('LICENSE exists', await exists('LICENSE'));
check('README.md exists', await exists('README.md'));
check('README.zh.md exists', await exists('README.zh.md'));
check('CHANGELOG.md mentions the version', (await read('CHANGELOG.md')).includes(manifest.version), manifest.version);
check('LICENSE is MIT', (await read('LICENSE')).includes('MIT License'));

// The package must never ship a path that only exists on the author's machine.
const shipped = ['package.json', 'cordis.patch.yml', 'index.js', 'client.js', ...(manifest.files ?? [])];
const absolute = /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/[^/]+)/;
for (const file of new Set(shipped)) {
  if (file.includes('*')) continue;
  let text;
  try {
    text = await read(file);
  } catch {
    continue; // directories such as `lib` are covered by their files
  }
  check(`no absolute path in ${relative(ROOT, join(ROOT, file))}`, !absolute.test(text), (text.match(absolute) ?? [])[0]);
}

// The local alias must not survive anywhere a consumer can see.
const alias = /@local\/dsh-user-portrait/;
for (const file of ['package.json', 'cordis.patch.yml', 'client.js', 'index.js', 'README.md', 'README.zh.md']) {
  check(`no local package alias in ${file}`, !alias.test(await read(file)));
}

// The suites must stay portable: no author-machine path may appear in test/.
async function walk(directory) {
  const out = [];
  for (const entry of await readdir(join(ROOT, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}
const machinePath = /(?:^|[\s"'(=])[A-Za-z]:[\\/]/;
for (const file of await walk('test')) {
  if (!/\.(?:mjs|cjs|js|json)$/.test(file)) continue;
  const text = await read(file);
  check(`no machine path in ${file}`, !machinePath.test(text), (text.match(machinePath) ?? [])[0]);
}

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} PACKAGE CHECK(S) FAILED`);
  process.exit(1);
}
console.log('PACKAGE CHECK PASSED');
