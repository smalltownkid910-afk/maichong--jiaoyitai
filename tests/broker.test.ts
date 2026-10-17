import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { openDatabase } from '../src/server/db.js';
import { Broker } from '../src/server/broker.js';
import type { Scanner } from '../src/server/scanner.js';
import type { PairView } from '../src/shared/types.js';
import type { Ticker } from '../src/server/okx.js';

const candleAt = Math.floor(Date.now() / 300_000) * 300_000 - 300_000;
const pair = (symbol: string, signal: PairView['signal'] = 'LONG'): PairView => ({
  symbol, price: 100, change24h: 1, quoteVolume24h: 20_000_000, spreadPct: 0.1,
  bidDepth: 200_000, askDepth: 200_000, ageDays: 200, eligible: true, reasons: [],
  signal, ema9: 101, ema21: 100, rsi14: 60, lastCandleAt: candleAt, updatedAt: Date.now()
});

function fakeScanner(pairs: PairView[]) {
  let onPrices: (tickers: Map<string, Ticker>, now: number) => void = () => {};
  const scanner = {
    setAccountProvider() {}, publish() {},
    onPrices(fn: typeof onPrices) { onPrices = fn; return () => {}; },
    getSelected() { return pairs; },
    snapshot() { return { status: 'live' }; }
  } as unknown as Scanner;
  return {
    scanner,
    feed(prices: Record<string, number>) {
      const now = Date.now();
      onPrices(new Map(Object.entries(prices).map(([symbol, price]) => [symbol, { instId: symbol, last: String(price), ts: String(now) } as Ticker])), now);
    }
  };
}

function setup(pairs: PairView[]) {
  const dir = mkdtempSync(join(tmpdir(), 'broker-test-'));
  const path = join(dir, 'account.sqlite');
  const db = openDatabase(path);
  const source = fakeScanner(pairs);
  const broker = new Broker(db, source.scanner, loadConfig({}));
  return { dir, path, db, broker, source, cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('权益采样持久化，缺价不制造回撤或收益，重置清除统计', () => {
  const env = setup([pair('A-USDT')]);
  try {
    env.source.feed({ 'A-USDT': 100 }); env.broker.open('A-USDT', 'LONG');
    env.source.feed({ 'A-USDT': 100.5 });
    env.source.feed({ 'A-USDT': 99.5 });
    assert.ok(env.broker.account().metrics!.maxDrawdownPct > 0);
    const recorded = env.broker.account().metrics!.maxDrawdownPct;
    assert.ok((env.db.prepare('SELECT COUNT(*) AS count FROM equity_samples').get() as { count: number }).count > 0);
    env.source.feed({});
    assert.equal(env.broker.account().valuationStale, true);
    assert.equal(env.broker.account().metrics!.returnPct, null);
    assert.equal(env.broker.account().metrics!.maxDrawdownPct, recorded);
    env.broker.reset();
    assert.equal(env.broker.account().metrics!.maxDrawdownPct, 0);
    assert.equal((env.db.prepare('SELECT COUNT(*) AS count FROM equity_samples').get() as { count: number }).count, 0);
  } finally { env.cleanup(); }
});

test('多空模拟交易计入双边手续费、滑点并保存净盈亏', () => {
  const env = setup([pair('A-USDT'), pair('B-USDT')]);
  try {
    env.source.feed({ 'A-USDT': 100, 'B-USDT': 100 });
    const long = env.broker.open('A-USDT', 'LONG');
    assert.equal(long.ok, true);
    if (!long.ok) return;
    assert.ok(long.position!.quantity * long.position!.entryPrice <= 10_000);
    env.source.feed({ 'A-USDT': 103, 'B-USDT': 100 });
    const longTrade = env.broker.account().trades[0];
    assert.equal(longTrade.exitReason, 'take_profit');
    assert.ok(Math.abs(longTrade.netPnl - (longTrade.grossPnl - longTrade.entryFee - longTrade.exitFee)) < 1e-8);
    const short = env.broker.open('B-USDT', 'SHORT');
    assert.equal(short.ok, true);
    env.source.feed({ 'A-USDT': 103, 'B-USDT': 97 });
    const account = env.broker.account();
    assert.equal(account.positions.length, 0);
    assert.equal(account.trades.length, 2);
    assert.ok(Math.abs(account.realizedPnl - account.trades.reduce((sum, trade) => sum + trade.netPnl, 0)) < 1e-8);
    assert.ok(Math.abs(account.equity - (10_000 + account.realizedPnl)) < 1e-8);
  } finally { env.cleanup(); }
});

test('仓位和总风险受限，重启后账户与未平仓持仓恢复', () => {
  const env = setup([pair('A-USDT'), pair('B-USDT'), pair('C-USDT'), pair('D-USDT')]);
  try {
    env.source.feed({ 'A-USDT': 100, 'B-USDT': 100, 'C-USDT': 100, 'D-USDT': 100 });
    assert.equal(env.broker.open('A-USDT', 'LONG').ok, true);
    const first = env.broker.account().positions[0];
    const risk = (first.entryPrice - first.stopLoss * (1 - first.slippageRate) + first.entryPrice * first.feeRate + first.stopLoss * (1 - first.slippageRate) * first.feeRate) * first.quantity;
    assert.ok(risk <= 100 + 1e-8);
    assert.equal(env.broker.open('A-USDT', 'SHORT').ok, false);
    const before = env.broker.account();
    env.db.close();
    const reopened = openDatabase(env.path);
    const restored = new Broker(reopened, fakeScanner([pair('A-USDT')]).scanner, loadConfig({}));
    assert.equal(restored.account().positions.length, 1);
    assert.ok(Math.abs(restored.account().balance - before.balance) < 1e-8);
    reopened.close();
    const db2 = openDatabase(env.path);
    db2.prepare(`INSERT INTO positions(symbol,side,quantity,entry_price,stop_loss,take_profit,entry_fee,opened_at,signal_candle_at,fee_rate,slippage_rate)
      VALUES('B-USDT','LONG',1,100,99,102,0.1,1,0,0.001,0.0005),('C-USDT','LONG',1,100,99,102,0.1,2,0,0.001,0.0005)`).run();
    const source = fakeScanner([pair('D-USDT')]);
    const limit = new Broker(db2, source.scanner, loadConfig({}));
    source.feed({ 'D-USDT': 100 });
    assert.equal(limit.account().positions.length, 3);
    assert.equal(limit.open('D-USDT', 'LONG').ok, false);
    db2.close();
  } finally { rmSync(env.dir, { recursive: true, force: true }); }
});

test('多币种自动入场后的总名义仓位和风险不超过当前权益上限', () => {
  const symbols = ['A-USDT', 'B-USDT', 'C-USDT', 'D-USDT'];
  const env = setup(symbols.map(symbol => pair(symbol)));
  try {
    env.db.prepare("UPDATE settings SET value='true' WHERE key='auto_trading'").run();
    env.db.prepare("UPDATE settings SET value='0' WHERE key='auto_started_at'").run();
    for (const symbol of symbols) env.db.prepare('INSERT INTO processed_signals(symbol,candle_at) VALUES(?,?)').run(symbol, candleAt);
    env.source.feed(Object.fromEntries(symbols.map(symbol => [symbol, 100])));
    const account = env.broker.account();
    assert.ok(account.positions.length <= 3);
    const notional = account.positions.reduce((sum, p) => sum + p.entryPrice * p.quantity, 0);
    const risk = account.positions.reduce((sum, p) => {
      const exit = p.stopLoss * (p.side === 'LONG' ? 1 - p.slippageRate : 1 + p.slippageRate);
      return sum + (Math.abs(p.entryPrice - exit) + p.entryPrice * p.feeRate + exit * p.feeRate) * p.quantity;
    }, 0);
    assert.ok(notional <= account.equity + 1e-7);
    assert.ok(risk <= account.equity * 0.03 + 1e-7);
  } finally { env.cleanup(); }
});

test('自动交易从数据库已记录信号恢复，重复报价不重复入场', () => {
  const env = setup([pair('A-USDT')]);
  try {
    env.db.prepare("UPDATE settings SET value='true' WHERE key='auto_trading'").run();
    env.db.prepare("UPDATE settings SET value='0' WHERE key='auto_started_at'").run();
    env.db.prepare('INSERT INTO processed_signals(symbol,candle_at) VALUES(?,?)').run('A-USDT', candleAt);
    env.source.feed({ 'A-USDT': 100 });
    assert.equal(env.broker.account().positions.length, 1);
    env.source.feed({ 'A-USDT': 100 });
    assert.equal(env.broker.account().positions.length, 1);
    assert.equal((env.db.prepare('SELECT candle_at FROM handled_signals WHERE symbol=?').get('A-USDT') as { candle_at: number }).candle_at, candleAt);
  } finally { env.cleanup(); }
});

test('跳空止损按新鲜市价与不利滑点退出，缺价期间不编造成交', () => {
  const env = setup([pair('A-USDT')]);
  try {
    env.source.feed({ 'A-USDT': 100 });
    const opened = env.broker.open('A-USDT', 'LONG');
    assert.equal(opened.ok, true);
    env.source.feed({});
    assert.equal(env.broker.account().positions.length, 1);
    env.source.feed({ 'A-USDT': 97 });
    const account = env.broker.account();
    assert.equal(account.positions.length, 0);
    assert.equal(account.trades[0].exitReason, 'stop_loss');
    assert.ok(account.trades[0].exitPrice < 97);
    assert.ok(account.trades[0].netPnl < -100, '跳空可超过预设单笔风险');
  } finally { env.cleanup(); }
});
