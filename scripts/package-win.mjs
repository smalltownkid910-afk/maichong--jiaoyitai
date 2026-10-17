import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { Zip, ZipDeflate } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const electronVersion = '44.7.2';
// Electron release checksum; downloads may use the documented npmmirror mirror.
const runtimeSha256 = '10a89447ef64ac5cb9f782af48ffd83734a40ae91681259d1048ca3c9e6c5da4';
const sha = data => createHash('sha256').update(data).digest('hex');
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path)); else result.push(path);
  }
  return result;
}
export async function fingerprint() {
  const paths = (await Promise.all(['src', 'tests', 'scripts', 'desktop'].map(dir => files(join(root, dir))))).flat()
    .concat(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'vite.config.ts', '.env.example', '.gitignore', 'README.md'].map(p => join(root, p)))
    .map(p => relative(root, p).split(sep).join('/')).sort();
  const lines = [];
  for (const path of paths) lines.push(path + ':' + sha(await readFile(join(root, path))));
  return sha(lines.join('\n'));
}
if (process.argv.includes('--fingerprint')) { console.log(await fingerprint()); process.exit(0); }
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此打包命令需要 Windows x64');

const cache = join(root, '.cache', 'electron');
const archiveName = 'electron-v' + electronVersion + '-win32-x64.zip';
const archive = join(cache, archiveName);
await mkdir(cache, { recursive: true });
async function validRuntime() {
  try { return sha(await readFile(archive)) === runtimeSha256; } catch { return false; }
}
if (!(await validRuntime())) {
  const { createWriteStream } = await import('node:fs');
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  const urls = ['https://github.com/electron/electron/releases/download/v' + electronVersion + '/' + archiveName,
    'https://npmmirror.com/mirrors/electron/' + electronVersion + '/' + archiveName];
  let downloaded = false;
  for (const url of urls) {
    try {
      console.log('下载 Electron ' + electronVersion + '：' + new URL(url).hostname);
      const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
      if (!response.ok) throw new Error('下载 HTTP ' + response.status);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
      if (!(await validRuntime())) throw new Error('运行时 SHA256 不匹配');
      downloaded = true; break;
    } catch (error) { console.log(error.message); }
  }
  if (!downloaded) throw new Error('无法下载并验证 Electron 运行时；未生成软件包');
}

const release = join(root, 'release');
const name = 'Pulse-Trading-Demo-' + version + '-win-x64';
const out = join(release, name);
const zip = join(release, name + '.zip');
async function removeBuild(path) {
  const full = resolve(path);
  if (!isAbsolute(full) || dirname(full) !== resolve(release) || !basename(full).startsWith('Pulse-Trading-Demo-')) throw new Error('拒绝清理构建范围以外的路径');
  await rm(full, { recursive: true, force: true });
}
await mkdir(release, { recursive: true });
await removeBuild(out); await removeBuild(zip);
await mkdir(out);
const extracted = spawnSync('tar.exe', ['-xf', archive, '-C', out], { windowsHide: true, encoding: 'utf8' });
if (extracted.status !== 0) throw new Error('Electron 解压失败：' + extracted.stderr);
await rename(join(out, 'electron.exe'), join(out, 'Pulse.exe'));
const appDir = join(out, 'resources', 'app');
const modules = join(appDir, 'node_modules');
await mkdir(appDir, { recursive: true });
await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'pulse-trading-demo', productName: '脉冲 Pulse', version, type: 'module', main: 'main.cjs' }, null, 2));
await cp(join(root, 'desktop', 'main.cjs'), join(appDir, 'main.cjs'));
await cp(join(root, 'dist'), join(appDir, 'dist'), { recursive: true });
const configSample = (await readFile(join(root, '.env.example'), 'utf8')).split(/\r?\n/)
  .filter(line => !/^(HOST|PORT|DATABASE_PATH)=/.test(line)).map(line => /^OPENAI_API_KEY=/.test(line) ? 'OPENAI_API_KEY=' : line).join('\n');
await writeFile(join(appDir, 'settings.env.example'), configSample);
await cp(join(root, 'desktop', '使用说明.txt'), join(out, '使用说明.txt'));
await cp(join(root, 'README.md'), join(out, 'README.md'));
await writeFile(join(out, '打开网页版.cmd'), '@echo off\r\nstart "" "%~dp0Pulse.exe" --web\r\n', 'utf8');

// Materialize production dependencies; no pnpm junctions, developer modules, or native rebuilds.
const installed = new Map();
async function locate(name, from) {
  const require = createRequire(join(from, 'package.json'));
  let entry;
  try { entry = require.resolve(name + '/package.json'); }
  catch { entry = require.resolve(name); }
  let dir = dirname(await realpath(entry));
  for (;;) {
    try { if (JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).name === name) return dir; } catch { /* Walk to owning package. */ }
    const parent = dirname(dir); if (parent === dir) throw new Error('找不到依赖包：' + name); dir = parent;
  }
}
async function install(name, from, parent = modules) {
  const source = await locate(name, from);
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const shared = installed.get(name);
  if (shared?.version === pkg.version) return;
  const dest = join(shared ? parent : modules, name);
  try { if (JSON.parse(await readFile(join(dest, 'package.json'), 'utf8')).version === pkg.version) return; } catch { /* First copy. */ }
  if (!shared) installed.set(name, { version: pkg.version });
  await cp(source, dest, { recursive: true, dereference: true,
    filter: path => !relative(source, path).split(sep).some(part => ['node_modules', '.git', '.env', '.github',
      'test', 'tests', '__tests__', 'fixtures', 'docs', 'examples', 'example', 'benchmark', 'benchmarks', 'coverage'].includes(part)) });
  for (const dep of Object.keys(pkg.dependencies ?? {})) await install(dep, source, join(dest, 'node_modules'));
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
    try { await install(dep, source, join(dest, 'node_modules')); } catch { /* Optional platform acceleration. */ }
  }
}
for (const name of ['fastify', '@fastify/static', '@fastify/websocket', 'dotenv', 'technicalindicators', 'zod']) await install(name, root);
const listed = [];
for (const file of (await files(out)).sort()) listed.push({ path: relative(out, file).split(sep).join('/'), sha256: sha(await readFile(file)) });
const manifest = { product: name, version, electronVersion, runtimeSha256, sourceSha256: await fingerprint(), files: listed };
await writeFile(join(out, 'build-manifest.json'), JSON.stringify(manifest, null, 2));
// Only distributable code receives sandbox read/execute access; user data is elsewhere.
const acl = spawnSync('icacls.exe', [out, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '/T', '/Q'], { windowsHide: true, encoding: 'utf8' });
if (acl.status !== 0) throw new Error('无法设置 Windows 沙箱对程序文件的只读执行访问');
const output = createWriteStream(zip);
let drain = false;
const zipper = new Zip((error, chunk, final) => {
  if (error) { output.destroy(error); return; }
  if (!output.write(chunk)) drain = true;
  if (final) output.end();
});
for (const file of await files(out)) {
  const entry = new ZipDeflate(name + '/' + relative(out, file).split(sep).join('/'), { level: 6 });
  zipper.add(entry);
  for await (const chunk of createReadStream(file)) {
    entry.push(chunk);
    if (drain) { await once(output, 'drain'); drain = false; }
  }
  entry.push(new Uint8Array(), true);
}
zipper.end();
await finished(output);
const zipSha256 = sha(await readFile(zip));
await writeFile(zip + '.sha256', zipSha256 + '  ' + basename(zip) + '\n');
console.log(JSON.stringify({ directory: out, zip, sizeMB: (await stat(zip)).size / 1048576, zipSha256, sourceSha256: manifest.sourceSha256 }, null, 2));
