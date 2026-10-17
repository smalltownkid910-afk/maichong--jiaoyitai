import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Only this local fixture is used here. Real OKX connectivity is verified separately.
const root = fileURLToPath(new URL('../', import.meta.url));
const tempDir = await mkdtemp(join(tmpdir(), 'okx-demo-smoke-'));
const symbols = ['BTC-USDT', 'ETH-USDT'];
const barMs = 300000;
const lastClosed = Math.floor(Date.now() / barMs) * barMs - barMs;
let btcPrice = 100;
let stale = false;
let child;
let logs = '';
const factor = symbol => symbol === 'ETH-USDT' ? 2 : 1;
const rows = symbol => Array.from({ length: 320 }, (_, i) => {
  const price = (97 + i * 0.01) * factor(symbol);
  return [String(lastClosed - (319 - i) * barMs), String(price), String(price * 1.0001),
    String(price * 0.9999), String(price), '10000', '1000000', '1000000', '1'];
}).reverse();

const fixture = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const symbol = url.searchParams.get('instId');
  let data;
  if (url.pathname.endsWith('/public/instruments')) {
    data = [...symbols, 'USDG-USDT', 'BAD-USDT'].map(instId => ({ instId, baseCcy: instId.split('-')[0],
      quoteCcy: 'USDT', state: 'live', listTime: String(Date.now() - 200 * 86400000) }));
  } else if (url.pathname.endsWith('/market/tickers')) {
    data = [...symbols, 'USDG-USDT', 'BAD-USDT'].map((instId, i) => {
      const price = instId === 'BTC-USDT' ? btcPrice : 100 * factor(instId);
      return { instId, last: String(price), open24h: String(price * 0.99),
        volCcy24h: instId === 'BAD-USDT' ? '100' : String(80000000 - i * 10000000),
        bidPx: String(price * 0.9995), askPx: String(price * 1.0005), ts: String(Date.now() - (stale ? 30000 : 0)) };
    });
  } else if (url.pathname.endsWith('/market/books')) {
    const price = 100 * factor(symbol);
    data = [{ bids: [[String(price * 0.9995), '4000']], asks: [[String(price * 1.0005), '4000']] }];
  } else if (url.pathname.endsWith('/market/candles') || url.pathname.endsWith('/market/history-candles')) {
    const after = Number(url.searchParams.get('after'));
    data = rows(symbol).filter(row => !after || Number(row[0]) < after).slice(0, Number(url.searchParams.get('limit') ?? 100));
  } else {
    response.writeHead(404).end(); return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: '0', data }));
});

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return server.address().port;
}
async function until(action, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('服务意外退出：' + logs);
    try { const result = await action(); if (result) return result; } catch (error) {
      if (Date.now() + 200 >= end) throw error;
    }
    await delay(100);
  }
  throw new Error(message);
}
async function stopApp() {
  const running = child;
  if (!running || running.exitCode !== null || running.signalCode !== null) return;
  const exiting = once(running, 'exit');
  const timer = setTimeout(() => running.kill('SIGKILL'), 5000);
  running.kill();
  try { await exiting; } finally { clearTimeout(timer); }
}

try {
  const fixturePort = await listen(fixture);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise(resolveClose => reservation.close(resolveClose));
  const base = 'http://127.0.0.1:' + port;
  async function request(path, options = {}) {
    const response = await fetch(base + path, { method: options.method ?? 'GET',
      ...(options.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    assert.equal(response.status, options.status ?? 200, path + ': ' + text);
    return JSON.parse(text);
  }
  async function startApp() {
    child = spawn(process.execPath, ['dist/server/index.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_PATH: join(tempDir, 'smoke.sqlite'),
        OKX_REST_URL: 'http://127.0.0.1:' + fixturePort, OKX_WS_URL: '', SCREEN_MIN_AGE_DAYS: '90', SCREEN_MIN_QUOTE_VOLUME: '10000000',
        SCREEN_MAX_SPREAD_PCT: '0.2', SCREEN_MIN_DEPTH: '100000', SCREEN_MAX_5M_MOVE_PCT: '5',
        SCREEN_EXCLUDED_STABLE_BASES: 'USDG', SIM_FEE_RATE: '0.001', SIM_SLIPPAGE_RATE: '0.0005',
        OPENAI_BASE_URL: '', OPENAI_MODEL: '', OPENAI_API_KEY: '' } });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
    await until(async () => (await request('/api/health')).ok, '服务未能启动');
  }
  async function live() {
    return until(async () => { const snapshot = await request('/api/snapshot'); return snapshot.status === 'live' && snapshot; }, '受控行情未进入 live');
  }

  await startApp();
  const snapshot = await live();
  assert.deepEqual(snapshot.pairs.filter(p => p.eligible).map(p => p.symbol), symbols);
  assert.ok(snapshot.pairs.find(p => p.symbol === 'USDG-USDT').reasons.some(r => r.includes('稳定币')));
  assert.ok(snapshot.pairs.find(p => p.symbol === 'BAD-USDT').reasons.some(r => r.includes('成交额')));
  assert.ok(symbols.every(s => snapshot.candles[s].length === 100 && snapshot.pairs.find(p => p.symbol === s).signal === 'LONG'));
  const home = await fetch(base);
  assert.equal(home.status, 200); assert.match(await home.text(), /<div id="root"><\/div>/);
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws');
  try {
    const message = await Promise.race([once(socket, 'message'), delay(5000, null, { ref: false }).then(() => { throw new Error('WebSocket 未推送'); })]);
    assert.equal(JSON.parse(message[0].data).status, 'live');
  } finally { socket.close(); }

  const initial = await request('/api/account');
  assert.equal(initial.equity, 10000); assert.equal(initial.autoTrading, false);
  await request('/api/trades/open', { method: 'POST', body: { symbol: 'BTC-USDT', side: 'LONG' } });
  await request('/api/trades/open', { method: 'POST', body: { symbol: 'ETH-USDT', side: 'SHORT' } });
  const holding = await request('/api/account'); assert.equal(holding.positions.length, 2);
  await request('/api/trades/open', { method: 'POST', body: { symbol: 'BTC-USDT', side: 'LONG' }, status: 409 });
  await stopApp(); await startApp(); await live();
  const restored = await request('/api/account');
  assert.deepEqual(restored.positions, holding.positions); assert.equal(restored.balance, holding.balance); assert.equal(restored.trades.length, 0);
  const beforeResearch = await request('/api/account');
  const replay = await request('/api/backtest', { method: 'POST', body: { source: 'replay' } });
  assert.equal(replay.source, 'replay'); assert.equal(replay.frames.length, 180); assert.equal(replay.trades.length, 27);
  const historical = await request('/api/backtest', { method: 'POST', body: { source: 'historical', bars: 300 } });
  assert.equal(historical.source, 'historical'); assert.equal(historical.bars, 300); assert.deepEqual(historical.symbols, symbols);
  assert.deepEqual(await request('/api/account'), beforeResearch);
  await request('/api/ai/explain', { method: 'POST', body: {}, status: 503 });
  assert.equal((await request('/api/ai/status')).configured, false);
  assert.equal((await request('/api/auto', { method: 'POST', body: { enabled: true } })).autoTrading, true);
  assert.equal((await request('/api/auto', { method: 'POST', body: { enabled: false } })).autoTrading, false);

  btcPrice = 98;
  const stopped = await until(async () => { const a = await request('/api/account'); return a.trades.length === 1 && a; }, '跌价后未自动止损', 15000);
  assert.equal(stopped.trades[0].symbol, 'BTC-USDT'); assert.equal(stopped.trades[0].exitReason, 'stop_loss');
  assert.equal(stopped.positions[0].symbol, 'ETH-USDT');
  await request('/api/trades/' + stopped.positions[0].id + '/close', { method: 'POST', body: {} });
  const closed = await request('/api/account'); assert.equal(closed.positions.length, 0); assert.equal(closed.trades.length, 2);
  for (const t of closed.trades) {
    const gross = (t.exitPrice - t.entryPrice) * t.quantity * (t.side === 'LONG' ? 1 : -1);
    assert.ok(Math.abs(t.netPnl - (gross - t.entryFee - t.exitFee)) < 1e-8);
  }
  assert.ok(Math.abs(closed.equity - 10000 - closed.trades.reduce((sum, t) => sum + t.netPnl, 0)) < 1e-8);
  assert.equal(closed.metrics.tradeCount, 2);
  const csv = await (await fetch(base + '/api/trades.csv')).text();
  assert.equal(csv.trim().split('\r\n').length, 3); assert.ok(csv.includes('stop_loss'));
  stale = true;
  await until(async () => (await request('/api/snapshot')).status === 'stale', '旧行情未标为 stale', 15000);
  await request('/api/trades/open', { method: 'POST', body: { symbol: 'BTC-USDT', side: 'LONG' }, status: 409 });
  await request('/api/account/reset', { method: 'POST', body: { confirm: false }, status: 400 });
  assert.deepEqual(await request('/api/account'), closed);
  const reset = await request('/api/account/reset', { method: 'POST', body: { confirm: true } });
  assert.equal(reset.equity, 10000); assert.equal(reset.positions.length, 0); assert.equal(reset.trades.length, 0); assert.equal(reset.autoTrading, false);
  console.log(JSON.stringify({ result: 'PASS', dataSource: '本机受控行情，非真实 OKX', candidates: symbols,
    restartPositions: 2, closedTrades: closed.trades.length, netPnl: closed.realizedPnl,
    historicalBars: historical.bars, replayFrames: replay.frames.length,
    checks: ['启动/首页/REST/WS', '自动筛选与指标', '多空入场与重启恢复', '独立回测/回放', 'AI缺失', '价格止损与费用', 'CSV', '旧价拒绝', '确认重置'] }, null, 2));
} catch (error) {
  console.error(logs); throw error;
} finally {
  await stopApp();
  await new Promise(resolveClose => fixture.close(resolveClose));
  if (dirname(resolve(tempDir)) !== resolve(tmpdir()) || !basename(tempDir).startsWith('okx-demo-smoke-')) throw new Error('临时清理路径校验失败');
  await rm(tempDir, { recursive: true, force: true });
}
