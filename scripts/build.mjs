import { build } from 'esbuild';
import { buildRunners } from './build-runner.mjs';
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? sources(`${directory}/${e.name}`) : [`${directory}/${e.name}`]))).flat().sort();
}
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const digest = createHash('sha256');
for (const filename of [...await sources('src'), 'scripts/build.mjs','scripts/build-runner.mjs', 'package.json', 'package-lock.json']) { digest.update(filename); digest.update(await readFile(filename)); }
const buildId = `${pkg.version}-${digest.digest('hex').slice(0, 16)}`;
const define = { __LAB_BUILD_ID__: JSON.stringify(buildId) };
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/host/index.ts'], outfile: 'dist/index.js', bundle: true, platform: 'node', target: 'node24', format: 'esm', sourcemap: false, define });
await build({ entryPoints: ['src/host/contest-mcp.ts'], outfile: 'dist/contest-mcp.mjs', bundle: true, platform: 'node', target: 'node24', format: 'esm', define });
await build({ entryPoints: ['src/host/contest-duel-main.ts'], outfile: 'dist/contest-duel.mjs', bundle: true, platform: 'node', target: 'node24', format: 'esm', define });
await buildRunners('dist');
const client = await build({ entryPoints: ['src/client/index.tsx'], bundle: true, write: false, platform: 'browser', target: 'es2022', format: 'cjs', external: ['react', 'react/jsx-runtime'], loader: { '.css': 'text' }, define });
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:"local-laboratory",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
await build({ entryPoints: ['scripts/preview-client.tsx'], outfile: 'dist/preview.js', bundle: true, platform: 'browser', target: 'es2022', format: 'esm', loader: { '.css': 'text' } });
// Reuse the user's existing Desktop link to Laboratory/bundle; no profile edits.
await mkdir('bundle', { recursive: true });
for (const file of ['index.js', 'client.js', 'runner.mjs','vision-worker.mjs','contest-mcp.mjs','contest-duel.mjs']) await copyFile('dist/' + file, 'bundle/' + file);
await copyFile('node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe','bundle/ffmpeg.exe');
await copyFile('node_modules/@ffmpeg-installer/win32-x64/package.json','bundle/ffmpeg-NOTICES.json');
await copyFile('cordis.patch.yml', 'bundle/cordis.patch.yml');
await writeFile('bundle/package.json', JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', description: pkg.description, engines: pkg.engines, main: './index.js', exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' }, dsh: pkg.dsh }, null, 2));
await writeFile('bundle/build-info.json', JSON.stringify({ version: pkg.version, buildId, builtAt: new Date().toISOString() }, null, 2));
console.log(`Built DSH host and client ${buildId}, script runner and local QA preview.`);

await copyFile('node_modules/jpeg-js/LICENSE','bundle/jpeg-js-LICENSE.txt');
await copyFile('node_modules/jpeg-js/README.md','bundle/jpeg-js-NOTICES.md');
await copyFile('src/shared/IBM-Plex-OFL.txt','bundle/IBM-Plex-OFL.txt');
await copyFile('src/shared/Noto-Sans-SC-OFL.txt','bundle/Noto-Sans-SC-OFL.txt');
