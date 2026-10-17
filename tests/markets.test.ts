import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/server/config.js';
import { OkxClient } from '../src/server/okx.js';
import { basePair, addBook } from '../src/server/screen.js';
import { marketDatabasePath } from '../src/server/markets.js';
import { startServer } from '../src/server/app.js';

async function fixture() {
  const closedEnd = Math.floor(Date.now() / 300000) * 300000;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const swap = url.searchParams.get('instType') === 'SWAP' || url.searchParams.get('instId')?.endsWith('-SWAP');
    const symbols = ['BTC-USDT', 'ETH-USDT'].map(s => s + (swap ? '-SWAP' : ''));
    const price = (s: string) => (s.startsWith('ETH') ? 2 : 1) * (swap ? 98 : 100);
    let data: unknown;
    if (url.pathname.endsWith('/instruments')) {
      data = symbols.map(instId => ({ instId, baseCcy: swap ? '' : instId.split('-')[0], quoteCcy: swap ? '' : 'USDT',
        instType: swap ? 'SWAP' : 'SPOT', instCategory: '1', ruleType: 'normal', ctType: 'linear', ctVal: '0.01', ctMult: '1', settleCcy: 'USDT', ctValCcy: instId.split('-')[0],
        listTime: String(Date.now() - 200 * 86400000), state: 'live' }));
      if (swap) (data as object[]).push({ instId: 'BTC-USD-SWAP', instType: 'SWAP', ctType: 'inverse', settleCcy: 'BTC' },
        { instId: 'BAD-USDT-SWAP', instType: 'SWAP', ctType: 'linear', settleCcy: 'USDT', ctVal: '0', ctMult: '1', ctValCcy: 'BAD' });
      if (swap) {
        const template = (data as Record<string, string>[])[0];
        for (const [base, overrides] of [['SNDK', { instCategory: '3' }], ['XAU', { instCategory: '4' }],
          ['PRE', { ruleType: 'pre_market' }], ['UNKNOWN', { instCategory: '' }], ['MULT', { ctMult: '2' }]] as const) {
          (data as object[]).push({ ...template, instId: `${base}-USDT-SWAP`, ctValCcy: base, ...overrides });
        }
      }
    } else if (url.pathname.endsWith('/tickers')) {
      data = symbols.map(instId => ({ instId, last: String(price(instId)), open24h: String(price(instId) * .99),
        volCcy24h: swap ? '800000' : '80000000', bidPx: String(price(instId) * .9995), askPx: String(price(instId) * 1.0005), ts: String(Date.now()) }));
    } else if (url.pathname.endsWith('/books')) {
      const p = price(url.searchParams.get('instId')!);
      data = [{ bids: [[String(p * .9995), swap ? '400000' : '4000']], asks: [[String(p * 1.0005), swap ? '400000' : '4000']] }];
    } else {
      const p = price(url.searchParams.get('instId')!), after = Number(url.searchParams.get('after'));
      data = Array.from({ length: 320 }, (_, i) => [String(closedEnd - (320 - i) * 300000), String(p), String(p * 1.001), String(p * .999), String(p),
        swap ? '1000000' : '10000', swap ? '10000' : String(p * 10000), String(p * 10000), '1'])
        .reverse().filter(c => !after || Number(c[0]) < after).slice(0, Number(url.searchParams.get('limit') || 100));
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: '0', data }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(done => server.close(() => done())) };
}

test('USDT线性永续只接收可换算合约，张数/基础币/报价量转换各自正确', async () => {
  const source = await fixture();
  const client = new OkxClient(loadConfig({ OKX_REST_URL: source.url }), 'swap');
  try {
    const instruments = await client.instruments();
    assert.deepEqual(instruments.map(i => i.instId), ['BTC-USDT-SWAP', 'ETH-USDT-SWAP']);
    assert.equal(instruments[0].baseCcy, 'BTC'); assert.equal(instruments[0].quoteCcy, 'USDT');
    const ticker = (await client.tickers())[0];
    const pair = basePair(instruments[0], ticker, Date.now());
    assert.equal(pair.price, 98); assert.equal(pair.quoteVolume24h, 800000 * 98); assert.equal(pair.quoteVolumeEstimated, true);
    const book = await client.book('BTC-USDT-SWAP');
    assert.equal(Number(book.bids[0][1]), 4000);
    assert.equal(addBook(pair, book).bidDepth, 98 * .9995 * 4000);
    assert.equal((await client.candles('BTC-USDT-SWAP'))[0].volume, 10000);
    assert.equal((await client.historyCandles('BTC-USDT-SWAP', 300))[0].volume, 10000);
    await assert.rejects(client.book('UNKNOWN-USDT-SWAP'), /缺少永续合约面值/);
  } finally { await source.close(); }
});

test('双市场HTTP/WS、账户、回测、重置和重启隔离，现货默认路由兼容', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-markets-test-'));
  const source = await fixture();
  const config = { ...loadConfig({ OKX_REST_URL: source.url, OKX_WS_URL: '', DATABASE_PATH: join(dir, 'account.sqlite') }), PORT: 0 };
  let service = await startServer({ config, clientDir: join(dir, 'no-client'), logger: false });
  async function request(path: string, body?: object, status = 200): Promise<any> {
    const response = await service.app.inject({ method: body === undefined ? 'GET' : 'POST', url: path, ...(body ? { payload: body } : {}) });
    assert.equal(response.statusCode, status, response.body); return response.json();
  }
  async function live() {
    for (let i = 0; i < 100; i++) {
      const s = await request('/api/snapshot'), w = await request('/api/snapshot?market=swap');
      if (s.status === 'live' && w.status === 'live') return;
      await delay(100);
    }
    throw new Error('双市场未进入实时状态');
  }
  try {
    assert.equal(marketDatabasePath(config.DATABASE_PATH, 'spot'), config.DATABASE_PATH);
    assert.equal(marketDatabasePath(config.DATABASE_PATH, 'swap'), join(dir, 'account.swap.sqlite'));
    await live();
    const spot = await request('/api/snapshot'), swap = await request('/api/snapshot?market=swap');
    assert.equal(spot.market, 'spot'); assert.equal(swap.market, 'swap');
    assert.equal(spot.pairs[0].price, 100); assert.ok(swap.pairs.every((p: any) => p.symbol.endsWith('-SWAP')));
    assert.equal(swap.pairs.find((p: any) => p.symbol === 'BTC-USDT-SWAP').price, 98);
    await request('/api/snapshot?market=invalid', undefined, 400);
    await request('/ws?market=invalid', undefined, 400);
    await request('/api/trades/open?market=swap', { symbol: 'BTC-USDT', side: 'LONG' }, 400);
    await request('/api/trades/open', { symbol: 'BTC-USDT-SWAP', side: 'LONG' }, 400);
    for (const market of ['spot', 'swap']) {
      const ws = new WebSocket(service.url.replace('http:', 'ws:') + '/ws?market=' + market);
      try { const [message] = await once(ws, 'message'); assert.equal(JSON.parse(message.data).market, market); } finally { ws.close(); }
    }
    await request('/api/trades/open', { symbol: 'BTC-USDT', side: 'LONG' });
    await request('/api/trades/open?market=swap', { symbol: 'BTC-USDT-SWAP', side: 'SHORT' });
    const spotHolding = await request('/api/account');
    assert.equal(spotHolding.positions.length, 1);
    const swapHolding = await request('/api/account?market=swap'); assert.equal(swapHolding.positions.length, 1);
    await request('/api/auto?market=swap', { enabled: true });
    assert.equal((await request('/api/account')).autoTrading, false);
    const history = await request('/api/backtest?market=swap', { source: 'historical', bars: 300 });
    assert.equal(history.market, 'swap'); assert.equal(history.bars, 300); assert.ok(history.symbols.every((s: string) => s.endsWith('-SWAP')));
    assert.deepEqual(await request('/api/account'), spotHolding);
    await request('/api/trades/' + swapHolding.positions[0].id + '/close?market=swap', {});
    assert.equal((await request('/api/account?market=swap')).trades.length, 1);
    assert.deepEqual(await request('/api/account'), spotHolding);
    await service.close(); service = await startServer({ config, clientDir: join(dir, 'no-client'), logger: false });
    await live();
    assert.equal((await request('/api/account')).positions[0].symbol, 'BTC-USDT');
    assert.equal((await request('/api/account?market=swap')).trades[0].symbol, 'BTC-USDT-SWAP');
    const beforeReset = await request('/api/account');
    await request('/api/account/reset?market=swap', { confirm: true });
    assert.deepEqual(await request('/api/account'), beforeReset);
    assert.equal((await request('/api/account?market=swap')).trades.length, 0);
    assert.equal((await request('/api/account?market=swap')).autoTrading, false);
  } finally {
    await service.close(); await source.close();
    assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('pulse-markets-test-'));
    rmSync(dir, { recursive: true, force: true });
  }
});
