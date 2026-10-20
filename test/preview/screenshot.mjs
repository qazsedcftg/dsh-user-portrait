/**
 * Screenshot the offline preview with the app's own Electron runtime.
 *
 * The page is loaded from disk (file://) into an offscreen BrowserWindow and
 * captured with `capturePage()`, so the result is exactly what Chromium renders
 * — real CSS, real layout, real fonts. Nothing leaves the machine.
 *
 * Usage:
 *   node test/preview/screenshot.mjs [input.html] [output.png] [width] [height]
 *
 * The Electron executable is discovered from the DSH installation (the parent of
 * `resources/app`), or supplied through `DSH_EXE`.
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ROOT, PLUGIN_ROOT } from '../_paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXE = process.env.DSH_EXE ?? (APP_ROOT === undefined ? undefined : resolve(APP_ROOT, '..', '..', 'DSH Desktop.exe'));
const input = resolve(process.argv[2] ?? join(PLUGIN_ROOT, 'assets', 'user-portrait-preview.html'));
const output = resolve(process.argv[3] ?? join(HERE, 'preview-shot.png'));
const width = Number(process.argv[4] ?? 1180);
const height = Number(process.argv[5] ?? 860);

if (EXE === undefined || !existsSync(EXE)) {
  console.error('DSH Desktop executable not found; set DSH_EXE to its full path');
  process.exit(1);
}
if (!existsSync(input)) {
  console.error(`input not found: ${input}`);
  process.exit(1);
}
rmSync(output, { force: true });

const script = `
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const OUT = ${JSON.stringify(output)};
const failures = [];
app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: ${width}, height: ${height}, webPreferences: { webSecurity: false } });
  win.webContents.on('console-message', (_event, _level, message) => failures.push(String(message)));
  win.webContents.on('did-fail-load', (_event, code, description) => failures.push('did-fail-load ' + code + ' ' + description));
  try {
    await win.loadFile(${JSON.stringify(input)});
    await new Promise((resolve) => setTimeout(resolve, 400));
    const image = await win.webContents.capturePage();
    writeFileSync(OUT, image.toPNG());
    const size = win.webContents.executeJavaScript('({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, text: document.body.innerText.length, styles: document.querySelectorAll("style").length })');
    size.then((info) => console.log('# page ' + JSON.stringify(info))).catch(() => {});
  } catch (error) {
    failures.push('capture: ' + String(error));
  }
  if (failures.length > 0) console.log('# page messages: ' + failures.slice(0, 6).join(' | '));
  setTimeout(() => app.quit(), 300);
});
`;

const runner = join(HERE, 'screenshot-runner.cjs');
writeFileSync(runner, script, 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
await new Promise((done) => {
  const child = spawn(EXE, [runner], { stdio: 'inherit', env });
  child.on('exit', (code) => {
    console.log(`# electron exit ${code}`);
    done();
  });
  child.on('error', (error) => {
    console.log(`# spawn error ${error.message}`);
    done();
  });
});

if (existsSync(output)) console.log(`screenshot: ${output}`);
else console.log('screenshot: NOT WRITTEN');
process.exitCode = existsSync(output) ? 0 : 1;
