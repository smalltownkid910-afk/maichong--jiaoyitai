import assert from 'node:assert/strict';
import test from 'node:test';
import { BAR_MS, candleExit, replaySamples, runBacktest } from '../src/server/backtest.js';
import { calculateMetrics, entryTerms } from '../src/shared/trading.js';
import type { Candle, Position } from '../src/shared/types.js';

const rates = { feeRate: 0.001, slippageRate: 0.0005 };
const samples = () => Array.from({ length: 31 }, (_, i): Candle => ({ timestamp: Date.UTC(2026, 0, 1) + i * BAR_MS,
  open: 100 + i * 0.1, high: 100.05 + i * 0.1, low: 99.95 + i * 0.1, close: 100 + i * 0.1, volume: 10000, confirmed: true }));
const position = (side: 'LONG' | 'SHORT'): Position => ({ ...entryTerms(100, side, rates), id: 1, symbol: 'BTC-USDT', quantity: 2, entryFee: 0.2, openedAt: 0, signalCandleAt: 0 });

test('指标预热后在下一根开盘入场，费用与实时共用计算一致', () => {
  const candles = samples();
  candles[30] = { ...candles[30], open: 500, high: 500.1, low: 499.9, close: 500 };
  const result = runBacktest({ 'BTC-USDT': candles }, rates);
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.openedAt, candles[30].timestamp);
  assert.equal(trade.signalCandleAt, candles[29].timestamp);
  assert.equal(trade.entryPrice, 500 * 1.0005);
  assert.equal(trade.exitPrice, 500 * 0.9995);
  const expectedEntryFee = trade.quantity * 500 * 1.0005 * 0.001;
  const expectedExitFee = trade.quantity * 500 * 0.9995 * 0.001;
  const expectedNet = (500 * 0.9995 - 500 * 1.0005) * trade.quantity - expectedEntryFee - expectedExitFee;
  assert.ok(Math.abs(trade.netPnl - expectedNet) < 1e-8);
  assert.ok(Math.abs(result.finalEquity - (10000 + trade.netPnl)) < 1e-8);
});

test('同根双触及止损优先；多空跳空均按开盘价处理', () => {
  const candle = { ...samples()[0], high: 110, low: 90 };
  assert.deepEqual(candleExit(position('LONG'), candle), { price: position('LONG').stopLoss, reason: 'stop_loss' });
  assert.deepEqual(candleExit(position('SHORT'), candle), { price: position('SHORT').stopLoss, reason: 'stop_loss' });
  assert.deepEqual(candleExit(position('LONG'), { ...candle, open: 90 }), { price: 90, reason: 'stop_loss' });
  assert.deepEqual(candleExit(position('SHORT'), { ...candle, open: 110 }), { price: 110, reason: 'stop_loss' });
});

test('追加未来行情不改变之前的信号、持仓、权益和成交', () => {
  const full = replaySamples();
  const prefix = Object.fromEntries(Object.entries(full).map(([symbol, candles]) => [symbol, candles.slice(0, 80)]));
  const partial = runBacktest(prefix, { ...rates, liquidateAtEnd: false });
  const extended = runBacktest(full, { ...rates, liquidateAtEnd: false });
  assert.deepEqual(extended.frames.slice(0, 80), partial.frames);
  assert.deepEqual(extended.trades.filter(trade => trade.closedAt <= partial.endAt), partial.trades);
  for (const frame of extended.frames) {
    assert.ok(frame.positions.length <= 3);
  }
});

test('结束时间错位时按共同窗口平仓，不在短历史币种缺价期间保留旧价', () => {
  const btc = samples();
  btc[30] = { ...btc[30], open: 500, high: 500.1, low: 499.9, close: 500 };
  const eth = Array.from({ length: 80 }, (_, i): Candle => ({
    timestamp: btc[0].timestamp + i * BAR_MS, open: 50, high: 50.1, low: 49.9, close: 50, volume: 10000, confirmed: true
  }));
  const result = runBacktest({ 'BTC-USDT': btc, 'ETH-USDT': eth }, rates);
  const historicalEnd = btc.at(-1)!.timestamp + BAR_MS;
  assert.equal(result.bars, 31);
  assert.equal(result.endAt, historicalEnd);
  assert.equal(result.frames.at(-1)?.timestamp, historicalEnd);
  assert.ok(result.frames.every(frame => frame.timestamp <= historicalEnd));
  assert.ok(result.trades.every(trade => trade.closedAt <= historicalEnd));
  assert.equal(result.trades.find(trade => trade.symbol === 'BTC-USDT')?.exitReason, 'window_end');
  assert.equal(result.trades.find(trade => trade.symbol === 'BTC-USDT')?.closedAt, historicalEnd);
  assert.ok(result.warnings.some(warning => warning.includes('截取共同覆盖窗口')));
});

test('开始时间错位时舍弃共同窗口之前的行情和交易', () => {
  const samplesBySymbol = replaySamples();
  const btc = samplesBySymbol['BTC-USDT'].slice(0, 80);
  const eth = samplesBySymbol['ETH-USDT'].slice(20, 80);
  const staggered = runBacktest({ 'BTC-USDT': btc, 'ETH-USDT': eth }, rates);
  const aligned = runBacktest({ 'BTC-USDT': btc.slice(20), 'ETH-USDT': eth }, rates);
  assert.equal(staggered.startAt, eth[0].timestamp);
  assert.equal(staggered.endAt, eth.at(-1)!.timestamp + BAR_MS);
  assert.equal(staggered.bars, 60);
  assert.deepEqual(staggered.frames, aligned.frames);
  assert.deepEqual(staggered.trades, aligned.trades);
  assert.equal(staggered.finalEquity, aligned.finalEquity);
  assert.ok(staggered.warnings.some(warning => warning.includes('截取共同覆盖窗口')));
});

test('共同窗口不足策略预热和下一根成交所需的31根K线时拒绝', () => {
  const btc = samples();
  const eth = btc.map(c => ({ ...c, timestamp: c.timestamp + BAR_MS }));
  assert.throws(() => runBacktest({ 'BTC-USDT': btc, 'ETH-USDT': eth }, rates), /共同覆盖窗口.*不足 31 根/);
});

test('同起止时间的多币种回测结果保持不变', () => {
  const samplesBySymbol = replaySamples();
  const result = runBacktest({ 'BTC-USDT': samplesBySymbol['BTC-USDT'].slice(0, 80),
    'ETH-USDT': samplesBySymbol['ETH-USDT'].slice(0, 80) }, rates);
  assert.equal(result.startAt, Date.UTC(2026, 0, 1));
  assert.equal(result.endAt, Date.UTC(2026, 0, 1) + 80 * BAR_MS);
  assert.equal(result.bars, 80);
  assert.equal(result.trades.length, 6);
  assert.ok(Math.abs(result.finalEquity - 9996.62835825425) < 1e-8);
  assert.equal(result.warnings.some(warning => warning.includes('截取共同覆盖窗口')), false);
});

test('历史缺口与未确认数据明确拒绝，回放稳定且不修改输入', () => {
  const candles = samples();
  assert.throws(() => runBacktest({ 'BTC-USDT': candles.slice(1, 10) }, rates), /不足/);
  assert.throws(() => runBacktest({ 'BTC-USDT': candles.filter((_c, i) => i !== 10).concat({ ...candles[30], timestamp: candles[30].timestamp + BAR_MS }) }, rates), /缺口/);
  assert.throws(() => runBacktest({ 'BTC-USDT': candles.map((c, i) => i === 30 ? { ...c, confirmed: false } : c) }, rates), /无效/);
  const input = replaySamples();
  const copy = structuredClone(input);
  const first = runBacktest(input, { ...rates, source: 'replay' });
  assert.deepEqual(input, copy);
  assert.deepEqual(first, runBacktest(replaySamples(), { ...rates, source: 'replay' }));
  assert.ok(first.trades.length > 0);
});

test('零交易及无亏损分母显示不适用，最大回撤按权益峰值核对', () => {
  const empty = calculateMetrics([], 10000, 10000);
  assert.equal(empty.winRatePct, null); assert.equal(empty.profitFactor, null);
  assert.equal(empty.avgWin, null); assert.equal(empty.avgLoss, null);
  const metrics = calculateMetrics([], 10000, 9000, [10000, 11000, 9000]);
  assert.ok(Math.abs(metrics.maxDrawdownPct - 2000 / 11000 * 100) < 1e-10);
  assert.ok(Math.abs(metrics.returnPct! + 10) < 1e-10);
});
