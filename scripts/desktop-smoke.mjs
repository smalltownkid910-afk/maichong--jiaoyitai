import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const name = 'Pulse-Trading-Demo-' + version + '-win-x64';
const zip = join(root, 'release', name + '.zip');
const temp = await mkdtemp(join(tmpdir(), 'pulse-desktop-smoke-'));
const unpack = join(temp, 'installed app with spaces');
const userData = join(temp, 'user account');
let child;
let output = '';
let base;
let fixture;
const sha = data => createHash('sha256').update(data).digest('hex');
const exited = p => p.exitCode !== null || p.signalCode !== null;
async function until(fn, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child && exited(child)) {
      const diagnostic = await readFile(join(userData, 'error.json'), 'utf8').catch(() => '无启动错误文件');
      throw new Error('打包程序提前退出：' + child.exitCode + '/' + child.signalCode + ' ' + diagnostic + output);
    }
    try { const result = await fn(); if (result) return result; } catch { /* Wait for startup or network. */ }
    await delay(150);
  }
  throw new Error(message + '\n' + output);
}
async function request(path, body, status = 200) {
  const response = await fetch(base + path, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
}
async function gracefulStop() {
  if (!child || exited(child)) return;
  const running = child;
  await writeFile(join(userData, 'request-quit'), 'quit');
  const end = Date.now() + 12000;
  while (!exited(running) && Date.now() < end) await delay(100);
  if (!exited(running)) { running.kill(); throw new Error('桌面正常退出未能结束进程'); }
  assert.equal(running.exitCode, 0, '桌面退出状态');
  if (base) { let reachable = true; try { await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) }); } catch { reachable = false; } assert.equal(reachable, false, '退出后端口必须关闭'); }
}
async function launch(exe) {
  await rm(join(userData, 'request-quit'), { force: true });
  await rm(join(userData, 'ready.json'), { force: true });
  const env = { ...process.env, PATH: join(process.env.SystemRoot, 'System32'), NODE_OPTIONS: '', PULSE_TEST_MODE: '1', PULSE_USER_DATA_DIR: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(exe, [], { cwd: temp, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000); });
  const ready = await until(async () => JSON.parse(await readFile(join(userData, 'ready.json'), 'utf8')), '实际 EXE 未加载桌面页面');
  base = ready.url;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(ready.rendererLoaded, true); assert.match(ready.node, /^24\./);
  assert.deepEqual(ready.rendererSecurity, { nodeIntegration: false, contextIsolation: true, sandbox: true });
  assert.equal(ready.userData, userData); assert.equal((await request('/api/health')).ok, true);
  return ready;
}

try {
  const expected = (await readFile(zip + '.sha256', 'utf8')).split(/\s/)[0];
  assert.equal(sha(await readFile(zip)), expected);
  await mkdir(unpack); await mkdir(userData);
  const extracted = spawnSync('tar.exe', ['-xf', zip, '-C', unpack], { windowsHide: true, encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  const installed = join(unpack, name);
  const manifest = JSON.parse(await readFile(join(installed, 'build-manifest.json'), 'utf8'));
  for (const file of manifest.files) assert.equal(sha(await readFile(join(installed, file.path))), file.sha256, file.path);
  assert.ok(!manifest.files.some(f => /(^|\/)\.env$|\.sqlite(?:-|$)|(^|\/)\.pnpm\//.test(f.path)), '发布包不能含用户配置/数据库/pnpm链接');
  // Managed temp folders may have app-specific ACLs. Grant RX only to extracted code,
  // after confirming no private config/database is present; never change userData ACLs.
  const acl = spawnSync('icacls.exe', [installed, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '/T', '/Q'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(acl.status, 0, 'Windows 沙箱无法读取已解压的程序文件');
  const exe = join(installed, 'Pulse.exe');
  const candleEnd = Math.floor(Date.now() / 300000) * 300000;
  fixture = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const swap = url.searchParams.get('instType') === 'SWAP' || url.searchParams.get('instId')?.endsWith('-SWAP');
    const symbols = ['BTC-USDT', 'ETH-USDT'].map(symbol => symbol + (swap ? '-SWAP' : ''));
    let data;
    if (url.pathname.endsWith('/instruments')) data = symbols.map(instId => ({ instId, baseCcy: instId.split('-')[0], quoteCcy: swap ? '' : 'USDT', instType: swap ? 'SWAP' : 'SPOT', instCategory: '1', ruleType: 'normal', ctType: 'linear', settleCcy: 'USDT', ctVal: '0.01', ctMult: '1', ctValCcy: instId.split('-')[0], state: 'live', listTime: String(Date.now() - 200 * 86400000) }));
    else if (url.pathname.endsWith('/tickers')) data = symbols.map((instId, i) => ({ instId, last: String((swap ? 98 : 100) * (i + 1)), open24h: '99', volCcy24h: String(swap ? 800000 : 80000000 - i * 10000000), bidPx: String((swap ? 97.951 : 99.95) * (i + 1)), askPx: String((swap ? 98.049 : 100.05) * (i + 1)), ts: String(Date.now()) }));
    else if (url.pathname.endsWith('/books')) { const n = url.searchParams.get('instId')?.startsWith('ETH-') ? 2 : 1; data = [{ bids: [[String((swap ? 97.951 : 99.95) * n), swap ? '400000' : '4000']], asks: [[String((swap ? 98.049 : 100.05) * n), swap ? '400000' : '4000']] }]; }
    else {
      const n = url.searchParams.get('instId')?.startsWith('ETH-') ? 2 : 1, after = Number(url.searchParams.get('after'));
      data = Array.from({ length: 320 }, (_, i) => { const p = (99 + i * 0.001) * n; return [String(candleEnd - (320 - i) * 300000), String(p), String(p * 1.0001), String(p * 0.9999), String(p), swap ? '1000000' : '10000', swap ? '10000' : '1000000', '1000000', '1']; })
        .reverse().filter(r => !after || Number(r[0]) < after).slice(0, Number(url.searchParams.get('limit') || 100));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: '0', data }));
  });
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  await writeFile(join(userData, 'settings.env'), 'OKX_REST_URL=http://127.0.0.1:' + fixture.address().port + '\nOKX_WS_URL=\nOPENAI_API_KEY=\nOPENAI_MODEL=\n');
  const ready = await launch(exe);
  const snapshot = await until(async () => { const s = await request('/api/snapshot'); return s.status === 'live' && s; }, 'EXE 自动扫描失败');
  assert.deepEqual(snapshot.pairs.filter(p => p.eligible).map(p => p.symbol), ['BTC-USDT', 'ETH-USDT']);
  const html = await (await fetch(base)).text(); assert.match(html, /assets\/index-/);
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws');
  try { const [event] = await once(ws, 'message'); assert.equal(JSON.parse(event.data).status, 'live'); } finally { ws.close(); }
  const swapSnapshot = await until(async () => { const s = await request('/api/snapshot?market=swap'); return s.status === 'live' && s; }, 'EXE 永续自动扫描失败');
  assert.equal(swapSnapshot.market, 'swap');
  assert.deepEqual(swapSnapshot.pairs.filter(p => p.eligible).map(p => p.symbol).sort(), ['BTC-USDT-SWAP','ETH-USDT-SWAP']);
  assert.equal(swapSnapshot.pairs.find(p => p.symbol === 'BTC-USDT-SWAP').price, 98);
  await request('/api/trades/open?market=swap', { symbol:'BTC-USDT-SWAP', side:'SHORT' });
  const swapHolding = await request('/api/account?market=swap');
  assert.equal(swapHolding.positions.length, 1);
  assert.equal((await request('/api/account')).positions.length, 0);
  await request('/api/trades/open', { symbol: 'BTC-USDT', side: 'LONG' });
  const holding = await request('/api/account'); assert.equal(holding.positions.length, 1);
  const replay = await request('/api/backtest', { source: 'replay' }); assert.equal(replay.frames.length, 180);
  const historical = await request('/api/backtest', { source: 'historical', bars: 300 }); assert.equal(historical.bars, 300);
  assert.deepEqual(await request('/api/account'), holding);
  await request('/api/ai/explain', {}, 503);
  const secondEnv = { ...process.env, PATH: join(process.env.SystemRoot, 'System32'), NODE_OPTIONS: '', PULSE_TEST_MODE: '1', PULSE_USER_DATA_DIR: userData };
  delete secondEnv.ELECTRON_RUN_AS_NODE;
  const second = spawn(exe, ['--web'], { cwd: temp, windowsHide: true, stdio: 'ignore', env: secondEnv });
  const [secondCode] = await once(second, 'exit'); assert.equal(secondCode, 0);
  assert.equal((await until(async () => JSON.parse(await readFile(join(userData, 'second-instance.json'), 'utf8')), '单实例消息未收到')).received, true);
  await gracefulStop();
  await launch(exe);
  assert.deepEqual((await request('/api/account')).positions, holding.positions);
  assert.deepEqual((await request('/api/account?market=swap')).positions, swapHolding.positions);
  await until(async () => (await request('/api/snapshot')).status === 'live', '重启未恢复行情');
  await request('/api/trades/' + holding.positions[0].id + '/close', {});
  await request('/api/account/reset?market=swap', { confirm: true });
  assert.equal((await request('/api/account?market=swap')).positions.length, 0);
  assert.equal((await request('/api/account')).trades.length, 1);
  const account = await request('/api/account'); assert.equal(account.trades.length, 1);
  const trade = account.trades[0]; assert.ok(Math.abs(trade.netPnl - (trade.grossPnl - trade.entryFee - trade.exitFee)) < 1e-8);
  assert.equal((await (await fetch(base + '/api/trades.csv')).text()).trim().split('\r\n').length, 2);
  await gracefulStop();
  let realEvidence;
  if (process.argv.includes('--real')) {
    await writeFile(join(userData, 'settings.env'), 'OPENAI_API_KEY=\nOPENAI_MODEL=\n');
    await launch(exe);
    const swapReal = await until(async () => { const s=await request('/api/snapshot?market=swap'); return s.status === 'live' && s.pairs.some(p=>p.eligible) && s; }, '真实永续行情未接通', 120000);
    assert.ok(swapReal.pairs.filter(p=>p.eligible).every(p=>p.symbol.endsWith('-SWAP')));
    const real = await until(async () => { const s = await request('/api/snapshot'); return s.status === 'live' && s.pairs.some(p => p.eligible) && s; }, '实际软件未连上真实 OKX', 120000);
    const samples = [], swapSamples = [];
    for (let i = 0; i < 8; i++) {
      const s = await request('/api/snapshot'), btc = s.pairs.find(p => p.symbol === 'BTC-USDT');
      if (btc) samples.push({ price: btc.price, timestamp: btc.updatedAt, ageMs: Date.now() - btc.updatedAt, source: btc.quoteSource, mode: s.feed?.mode });
      const swap=await request('/api/snapshot?market=swap'), sw=swap.pairs.find(p=>p.symbol==='BTC-USDT-SWAP');
      if(sw) swapSamples.push({price:sw.price,timestamp:sw.updatedAt,ageMs:Date.now()-sw.updatedAt,source:sw.quoteSource});
      await delay(1000);
    }
    assert.ok(new Set(samples.map(s => s.timestamp)).size >= 3, '实际软件报价时间没有按秒推进');
    assert.ok(new Set(swapSamples.map(s=>s.timestamp)).size>=3, '真实永续报价未推进');
    realEvidence = { swapCandidates:swapReal.pairs.filter(p=>p.eligible).map(p=>p.symbol), swapSamples, status: real.status, candidates: real.pairs.filter(p => p.eligible).map(p => p.symbol), candleSets: Object.keys(real.candles).length, samples };
    await gracefulStop();
  }
  console.log(JSON.stringify({ result: 'PASS', zipSha256: expected, sourceSha256: manifest.sourceSha256,
    electron: ready.electron, node: ready.node, noSystemNodePath: true, arbitraryCwdAndSpaces: true, rendererLoaded: true,
    singleInstance: true, markets: ['spot','swap'], isolatedAccounts: true, restoredPositions: 2, closedTrades: 1, replayFrames: replay.frames.length,
    historicalBars: historical.bars, gracefulPortClosed: true, realEvidence }, null, 2));
} finally {
  if (child && !exited(child)) { try { await gracefulStop(); } catch { child.kill(); } }
  if (fixture) await new Promise(done => fixture.close(done));
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !basename(temp).startsWith('pulse-desktop-smoke-')) throw new Error('临时清理路径校验失败');
  await rm(temp, { recursive: true, force: true });
}
