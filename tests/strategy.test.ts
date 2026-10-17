import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeCandles } from '../src/server/strategy.js';
import type { Candle } from '../src/shared/types.js';

const period = 300_000;
const now = Date.UTC(2026, 9, 14, 12, 0);
const sample = (closes: number[]): Candle[] => closes.map((close, i) => ({
  timestamp: now - (closes.length - i) * period,
  open: close, high: close + 1, low: close - 1, close, volume: 100,
  confirmed: true
}));

test('线性上涨和下跌样本产生可核对的 EMA、RSI 与信号', () => {
  const up = analyzeCandles(sample(Array.from({ length: 40 }, (_, i) => i + 1)), now);
  assert.equal(up.signal, 'LONG');
  assert.ok(Math.abs(up.ema9! - 36) < 1e-8);
  assert.ok(Math.abs(up.ema21! - 30) < 1e-8);
  assert.equal(up.rsi14, 100);
  const down = analyzeCandles(sample(Array.from({ length: 40 }, (_, i) => 40 - i)), now);
  assert.equal(down.signal, 'SHORT');
  assert.ok(Math.abs(down.ema9! - 5) < 1e-8);
  assert.ok(Math.abs(down.ema21! - 11) < 1e-8);
  assert.equal(down.rsi14, 0);
});

test('未确认或尚未收盘的 K 线不能改变已收盘信号', () => {
  const candles = sample(Array.from({ length: 40 }, (_, i) => i + 1));
  const original = analyzeCandles(candles, now);
  const unconfirmed = { ...candles.at(-1)!, timestamp: now, close: 0.01, confirmed: false };
  const premature = { ...unconfirmed, confirmed: true };
  assert.deepEqual(analyzeCandles([...candles, unconfirmed], now), original);
  assert.deepEqual(analyzeCandles([...candles, premature], now), original);
});

test('数据不足或有时间缺口时等待，不输出指标', () => {
  const short = analyzeCandles(sample(Array.from({ length: 20 }, (_, i) => i + 1)), now);
  assert.equal(short.signal, 'WAIT');
  assert.equal(short.ema9, null);
  const broken = sample(Array.from({ length: 40 }, (_, i) => i + 1)).filter((_, i) => i !== 20);
  const result = analyzeCandles(broken, now);
  assert.equal(result.signal, 'WAIT');
  assert.equal(result.rsi14, null);
});
