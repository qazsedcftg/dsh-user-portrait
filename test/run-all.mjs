#!/usr/bin/env node
/**
 * Run every portrait suite and print one line per suite.
 *
 * A suite passes only when it exits 0, prints no FAIL line, and prints at least
 * one `ok` assertion (or an explicit SKIP when the local machine lacks the DSH
 * application or sample data). That last rule exists because a suite that crashes
 * before its first assertion used to look green at "0 failed".
 *
 * Usage: `npm test` or `node test/run-all.mjs [name-filter]`
 */
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? '';
const files = (await readdir(here))
  .filter((file) => /^portrait-.*\.mjs$/.test(file) && file.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(`no suite matches "${filter}"`);
  process.exit(1);
}

const rows = [];
let failed = 0;
for (const file of files) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [join(here, file)], {
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const ok = (output.match(/^ok\s/gm) ?? []).length;
  const fail = (output.match(/^FAIL/gm) ?? []).length;
  const skipped = /^SKIP\b/m.test(output);
  const clean = result.status === 0 && fail === 0 && (ok > 0 || skipped);
  if (!clean) failed += 1;
  rows.push({
    suite: file.replace(/^portrait-|\.mjs$/g, ''),
    status: skipped ? 'SKIP' : clean ? 'PASS' : 'FAIL',
    ok,
    fail,
    ms: Date.now() - started,
  });
  if (!clean) {
    const interesting = output
      .split('\n')
      .filter((line) => /^(FAIL|SKIP|Error|\s+at )/.test(line))
      .slice(0, 25);
    console.log(`\n--- ${file} (exit ${result.status ?? 'signal'}) ---`);
    console.log(interesting.join('\n'));
  }
}

const width = Math.max(...rows.map((row) => row.suite.length));
console.log('');
for (const row of rows) {
  console.log(
    `${row.status.padEnd(4)}  ${row.suite.padEnd(width)}  ok=${String(row.ok).padStart(3)}  fail=${row.fail}  ${row.ms}ms`,
  );
}
const total = rows.reduce((sum, row) => sum + row.ok, 0);
const skipped = rows.filter((row) => row.status === 'SKIP').length;
console.log(`\n${rows.length - failed - skipped}/${rows.length} suite(s) passed, ${skipped} skipped, ${total} assertion(s) ok`);
process.exit(failed === 0 ? 0 : 1);
