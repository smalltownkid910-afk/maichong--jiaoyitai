import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/server/config.js';
import { openDatabase } from '../src/server/db.js';
import { Broker } from '../src/server/broker.js';
import { Scanner } from '../src/server/scanner.js';
import type { OkxClient } from '../src/server/okx.js';

test('自动发现最多20个候选，行情故障显示错误并在恢复后转为实时', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'virtual-trader-test-'));
  const db = openDatabase(join(dir, 'test.sqlite'));
  const now = Date.now();
  const symbols = Array.from({ length: 25 }, (_, i) => `COIN${String(i).padStart(2, '0')}-USDT`);
  const instruments = symbols.map(symbol => ({ instId: symbol, baseCcy: symbol.split('-')[0], quoteCcy: 'USDT', state: 'live', listTime: String(now - 200 * 86_400_000) }));
  const tickers = symbols.map((symbol, i) => ({ instId: symbol, last: '100', open24h: '99', volCcy24h: String(50_000_000 - i * 100_000), bidPx: '99.95', askPx: '100.05', ts: String(Date.now()) }));
  const start = Math.floor(now / 300_000) * 300_000 - 40 * 300_000;
  const candles = Array.from({ length: 40 }, (_, i) => ({ timestamp: start + i * 300_000, open: 100, high: 101, low: 99, close: 100, volume: 50, confirmed: true }));
  let disconnected = false;
  const okx = {
    instruments: async () => instruments,
    tickers: async () => { if (disconnected) throw new Error('模拟断线'); return tickers.map(t => ({ ...t, ts: String(Date.now()) })); },
    book: async () => ({ bids: [['99.95', '2000']], asks: [['100.05', '2000']] }),
    candles: async () => candles
  } as unknown as OkxClient;
  const scanner = new Scanner(okx, db, { info() {}, error() {} }, loadConfig({}));
  const emitted: string[] = [];
  scanner.onSignal(pair => emitted.push(`${pair.symbol}:${pair.lastCandleAt}`));
  try {
    await scanner.discover();
    assert.equal(scanner.getSelected().length, 20);
    assert.equal(emitted.length, 20);
    await scanner.refreshCandles();
    assert.equal(emitted.length, 20);
    const restarted = new Scanner(okx, db, { info() {}, error() {} }, loadConfig({}));
    restarted.onSignal(pair => emitted.push(`${pair.symbol}:${pair.lastCandleAt}`));
    await restarted.discover();
    assert.equal(emitted.length, 20, '重启后同一根K线不得再次发出信号事件');
    assert.equal(scanner.snapshot().status, 'live');
    assert.deepEqual(scanner.getSelected().map(p => p.symbol), symbols.slice(0, 20));
    disconnected = true;
    await scanner.refreshTickers();
    assert.equal(scanner.snapshot().status, 'error');
    disconnected = false;
    await scanner.refreshTickers();
    assert.equal(scanner.snapshot().status, 'live');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('首次发现失败后按退避重试并自动恢复，无需等待30分钟', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scanner-retry-test-'));
  const db = openDatabase(join(dir, 'test.sqlite'));
  const now = Date.now();
  const start = Math.floor(now / 300_000) * 300_000 - 40 * 300_000;
  let attempts = 0;
  const okx = {
    instruments: async () => {
      attempts++;
      if (attempts === 1) throw new Error('模拟首次断线');
      return [{ instId: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live', listTime: String(now - 200 * 86_400_000) }];
    },
    tickers: async () => [{ instId: 'BTC-USDT', last: '100', open24h: '99', volCcy24h: '20000000', bidPx: '99.95', askPx: '100.05', ts: String(Date.now()) }],
    book: async () => ({ bids: [['99.95', '2000']], asks: [['100.05', '2000']] }),
    candles: async () => Array.from({ length: 40 }, (_, i) => ({ timestamp: start + i * 300_000, open: 100, high: 101, low: 99, close: 100, volume: 50, confirmed: true }))
  } as unknown as OkxClient;
  const scanner = new Scanner(okx, db, { info() {}, error() {} }, loadConfig({}), 10);
  try {
    scanner.start();
    for (let i = 0; i < 100 && scanner.snapshot().status !== 'live'; i++) await delay(20);
    assert.ok(attempts >= 2);
    assert.equal(scanner.snapshot().status, 'live');
    assert.equal(scanner.getSelected()[0].symbol, 'BTC-USDT');
  } finally { scanner.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('发现失败不能被成功的行情刷新清除，成功发现零候选后才显示实时', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scanner-discovery-state-test-'));
  const db = openDatabase(join(dir, 'test.sqlite'));
  let instrumentsOffline = true;
  const okx = {
    instruments: async () => {
      if (instrumentsOffline) throw new Error('instruments offline');
      return [];
    },
    tickers: async () => [{ instId: 'BTC-USDT', last: '100', open24h: '99', volCcy24h: '20000000',
      bidPx: '99.95', askPx: '100.05', ts: String(Date.now()) }]
  } as unknown as OkxClient;
  const scanner = new Scanner(okx, db, { info() {}, error() {} }, loadConfig({}));
  try {
    await scanner.refreshTickers();
    assert.equal(scanner.snapshot().status, 'loading', '尚未成功发现时，单独刷新行情不能宣称扫描完成');
    await scanner.discover();
    assert.equal(scanner.snapshot().status, 'error');
    assert.equal(scanner.snapshot().error, 'instruments offline');
    await scanner.refreshTickers();
    assert.equal(scanner.snapshot().status, 'error');
    assert.equal(scanner.snapshot().error, 'instruments offline');
    assert.equal(scanner.snapshot().pairs.length, 0);

    instrumentsOffline = false;
    await scanner.discover();
    assert.equal(scanner.snapshot().status, 'live');
    assert.equal(scanner.snapshot().error, undefined);
    assert.equal(scanner.snapshot().pairs.length, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('首次自动发现会排除上一根K线剧烈波动的币种', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'virtual-trader-test-'));
  const db = openDatabase(join(dir, 'test.sqlite'));
  const now = Date.now();
  const start = Math.floor(now / 300_000) * 300_000 - 40 * 300_000;
  const candles = Array.from({ length: 40 }, (_, i) => ({
    timestamp: start + i * 300_000, open: 100, high: 106, low: 99,
    close: i === 38 ? 106 : 100, volume: 50, confirmed: true
  }));
  const okx = {
    instruments: async () => [{ instId: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live', listTime: String(now - 200 * 86_400_000) }],
    tickers: async () => [{ instId: 'BTC-USDT', last: '100', open24h: '99', volCcy24h: '50000000', bidPx: '99.95', askPx: '100.05', ts: String(Date.now()) }],
    book: async () => ({ bids: [['99.95', '2000']], asks: [['100.05', '2000']] }),
    candles: async () => candles
  } as unknown as OkxClient;
  const scanner = new Scanner(okx, db, { info() {}, error() {} }, loadConfig({}));
  try {
    await scanner.discover();
    assert.equal(scanner.getSelected().length, 0);
    assert.ok(scanner.snapshot().pairs[0]?.reasons.some(reason => reason.includes('波动')));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('币种退出候选池后仍按新鲜行情止损，零候选状态保持更新且禁止新开仓', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scanner-position-test-'));
  const db = openDatabase(join(dir, 'test.sqlite'));
  const config = loadConfig({});
  const now = Date.now();
  const start = Math.floor(now / 300_000) * 300_000 - 40 * 300_000;
  const candles = Array.from({ length: 40 }, (_, i) => ({
    timestamp: start + i * 300_000, open: 100, high: 101, low: 99, close: 100, volume: 50, confirmed: true
  }));
  let excluded = false;
  const okx = {
    instruments: async () => [{ instId: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live', listTime: String(now - 200 * 86_400_000) }],
    tickers: async () => [{ instId: 'BTC-USDT', last: excluded ? '90' : '100', open24h: '99',
      volCcy24h: excluded ? '5000000' : '20000000', bidPx: '99.95', askPx: '100.05', ts: String(Date.now()) }],
    book: async () => ({ bids: [['99.95', '2000']], asks: [['100.05', '2000']] }),
    candles: async () => candles
  } as unknown as OkxClient;
  const scanner = new Scanner(okx, db, { info() {}, error() {} }, config);
  const broker = new Broker(db, scanner, config);
  try {
    await scanner.discover();
    assert.equal(scanner.getSelected().length, 1);
    assert.equal(broker.open('BTC-USDT', 'LONG').ok, true);
    assert.equal(broker.account().positions.length, 1);

    excluded = true;
    await scanner.discover();
    assert.equal(scanner.getSelected().length, 0);
    assert.equal(scanner.snapshot().status, 'live');
    assert.equal(broker.account().positions.length, 0);
    assert.equal(broker.account().trades.length, 1);
    assert.equal(broker.account().trades[0].exitReason, 'stop_loss');
    assert.equal(broker.open('BTC-USDT', 'LONG').ok, false);
    await scanner.refreshTickers();
    assert.equal(scanner.snapshot().status, 'live');
    assert.equal(broker.account().trades.length, 1, '后续报价不得重复平仓');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
