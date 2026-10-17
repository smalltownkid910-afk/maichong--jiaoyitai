import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OkxTickerStream } from '../src/server/market-stream.js';
import { Scanner } from '../src/server/scanner.js';
import { Broker } from '../src/server/broker.js';
import { openDatabase } from '../src/server/db.js';
import { loadConfig } from '../src/server/config.js';
import type { OkxClient, Ticker } from '../src/server/okx.js';

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  send(message: string) { this.sent.push(message); }
  open() { this.readyState = 1; this.onopen?.(); }
  frame(value: unknown) { this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
const ticker = (symbol: string, price: number, ts = Date.now()): Ticker => ({ instId: symbol, last: String(price), open24h: '100',
  bidPx: String(price * 0.9995), askPx: String(price * 1.0005), volCcy24h: '50000000', ts: String(ts) });

test('公共行情按候选订阅，坏帧忽略，订阅变更和停止不留下重连', async () => {
  const sockets: FakeSocket[] = [], prices: Ticker[] = [];
  const stream = new OkxTickerStream('ws://fixture', ticks => prices.push(...ticks), () => {}, () => {
    const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket;
  });
  stream.start(['BTC-USDT']); sockets[0].open();
  assert.equal(JSON.parse(sockets[0].sent[0]).args[0].instId, 'BTC-USDT');
  sockets[0].frame('invalid json');
  sockets[0].frame({ arg: { channel: 'tickers' }, data: [ticker('BTC-USDT', 101), ticker('ETH-USDT', 200)] });
  assert.equal(prices.length, 1);
  stream.setSymbols(['ETH-USDT']);
  assert.equal(JSON.parse(sockets[0].sent[1]).op, 'unsubscribe');
  assert.equal(JSON.parse(sockets[0].sent[2]).args[0].instId, 'ETH-USDT');
  stream.stop(); await delay(30);
  assert.equal(sockets.length, 1); assert.equal(stream.state, 'idle');
});

test('心跳无响应和订阅错误触发有限重连，并重新订阅', async () => {
  const sockets: FakeSocket[] = [];
  const stream = new OkxTickerStream('ws://fixture', () => {}, () => {}, () => {
    const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket;
  }, { connectMs: 300, idleMs: 15, pongMs: 15, heartbeatMs: 3, retryMs: 5, maxRetryMs: 20 });
  try {
    stream.start(['BTC-USDT']); sockets[0].open();
    for (let i = 0; i < 100 && sockets.length < 2; i++) await delay(3);
    assert.ok(sockets[0].sent.includes('ping')); assert.ok(sockets.length >= 2);
    sockets[1].open();
    assert.equal(JSON.parse(sockets[1].sent[0]).args[0].instId, 'BTC-USDT');
    sockets[1].frame({ event: 'error', code: '60012' });
    for (let i = 0; i < 100 && sockets.length < 3; i++) await delay(3);
    assert.ok(sockets.length >= 3); assert.ok(stream.reconnects >= 2);
  } finally { stream.stop(); }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'market-stream-test-'));
  const db = openDatabase(join(dir, 'test.sqlite'));
  const start = Math.floor(Date.now() / 300000) * 300000 - 40 * 300000;
  let rejected = false;
  const client = {
    instruments: async () => [{ instId: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', state: rejected ? 'suspend' : 'live', listTime: String(Date.now() - 200 * 86400000) }],
    tickers: async () => [ticker('BTC-USDT', 100)],
    book: async () => ({ bids: [['99.95', '4000']], asks: [['100.05', '4000']] }),
    candles: async () => Array.from({ length: 40 }, (_, i) => ({ timestamp: start + i * 300000, open: 100, high: 100.1, low: 99.9, close: 100, volume: 10000, confirmed: true }))
  } as unknown as OkxClient;
  const scanner = new Scanner(client, db, { info() {}, error() {} }, loadConfig({ OKX_WS_URL: '' }));
  const broker = new Broker(db, scanner, loadConfig({}));
  let closed = false;
  return { db, scanner, broker, client, exclude() { rejected = true; }, close() { if (closed) return; closed = true; scanner.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('关闭服务后丢弃未完成行情请求的返回值，不再访问已关闭数据库', async () => {
  const env = setup();
  let finish!: (tickers: Ticker[]) => void;
  try {
    env.client.tickers = () => new Promise<Ticker[]>(resolve => { finish = resolve; });
    const pending = env.scanner.refreshTickers();
    env.close();
    finish([ticker('BTC-USDT', 100)]);
    await pending;
  } finally { env.close(); }
});

test('旧REST与重复帧不能覆盖新WS，非法及未来报价不成交，退出候选仍止损', async () => {
  const env = setup();
  try {
    await env.scanner.discover();
    const initial = env.scanner.getSelected()[0].updatedAt!;
    env.scanner.acceptTickers([ticker('BTC-USDT', 101, initial + 20)], 'websocket');
    env.scanner.acceptTickers([ticker('BTC-USDT', 99, initial + 10)], 'rest');
    env.scanner.acceptTickers([ticker('BTC-USDT', 99, initial + 20)], 'rest');
    assert.equal(env.scanner.getSelected()[0].price, 101);
    assert.equal(env.scanner.getSelected()[0].quoteSource, 'websocket');
    env.scanner.acceptTickers([ticker('BTC-USDT', 1, Date.now() + 10000), { ...ticker('BTC-USDT', 1, initial + 30), bidPx: '' }], 'websocket');
    assert.equal(env.scanner.getSelected()[0].price, 101);
    assert.equal(env.broker.open('BTC-USDT', 'LONG').ok, true);
    env.exclude(); await env.scanner.discover();
    assert.equal(env.scanner.getSelected().length, 0);
    env.scanner.acceptTickers([ticker('BTC-USDT', 98, initial + 100)], 'websocket');
    env.scanner.acceptTickers([ticker('BTC-USDT', 98, initial + 100)], 'websocket');
    assert.equal(env.broker.account().positions.length, 0);
    assert.equal(env.broker.account().trades.length, 1);
    assert.equal(env.broker.account().trades[0].exitReason, 'stop_loss');
    assert.equal(env.broker.open('BTC-USDT', 'LONG').ok, false);
  } finally { env.close(); }
});

test('高频行情限制为每秒一次行情快照和权益采样，不重复传K线', async () => {
  const env = setup();
  let incremental = 0;
  const off = env.scanner.subscribe((_snapshot, full) => { if (!full) incremental++; });
  try {
    env.scanner.start();
    for (let i = 0; i < 100 && env.scanner.snapshot().status !== 'live'; i++) await delay(5);
    const before = incremental, ts = Date.now();
    const countBefore = (env.db.prepare('SELECT COUNT(*) AS n FROM equity_samples').get() as { n: number }).n;
    for (let i = 1; i <= 500; i++) env.scanner.acceptTickers([ticker('BTC-USDT', 100 + i * 0.00001, ts + i)], 'websocket');
    assert.ok(incremental - before <= 1);
    const countAfter = (env.db.prepare('SELECT COUNT(*) AS n FROM equity_samples').get() as { n: number }).n;
    assert.ok(countAfter - countBefore <= 1);
    assert.equal(env.scanner.getSelected()[0].price, 100.005);
    assert.equal(env.broker.account().trades.length, 0);
  } finally { off(); env.close(); }
});
