import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/server/config.js';
import { SCREEN, addBook, addCandles, basePair, sortPairs, volatilityPauseUntil } from '../src/server/screen.js';
import type { Candle } from '../src/shared/types.js';

const now = Date.UTC(2026, 9, 14, 12, 0);
const instrument = { instId: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live', listTime: String(now - 365 * 86_400_000) };
const ticker = { instId: 'BTC-USDT', last: '100', open24h: '90', volCcy24h: '20000000', bidPx: '99.95', askPx: '100.05', ts: String(now) };
const book = { bids: [['99.95', '2000']], asks: [['100.05', '2000']] };
const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({
  timestamp: now - (40 - i) * SCREEN.candleMs,
  open: 100, high: 101, low: 99, close: 100, volume: 100,
  confirmed: true
}));

test('正常交易对通过上市、成交额、价差、深度和连续 K 线筛选', () => {
  const result = addCandles(addBook(basePair(instrument, ticker, now), book), candles, now);
  assert.equal(result.eligible, true);
  assert.equal(result.reasons.length, 0);
  assert.equal(result.bidDepth, 199900);
});

test('缺失必要行情、浅盘口与 K 线缺口均明确拒绝', () => {
  const missing = basePair(instrument, undefined, now);
  assert.equal(missing.eligible, false);
  assert.ok(missing.reasons.some(reason => reason.includes('过期')));
  const shallow = addBook(basePair(instrument, ticker, now), { bids: [['99.95', '1']], asks: [['100.05', '1']] });
  assert.equal(shallow.eligible, false);
  assert.ok(shallow.reasons.some(reason => reason.includes('盘口深度')));
  const gap = addCandles(addBook(basePair(instrument, ticker, now), book), candles.filter((_, i) => i !== 20), now);
  assert.equal(gap.eligible, false);
  assert.ok(gap.reasons.some(reason => reason.includes('时间缺口')));
});

test('剧烈波动暂停入场，候选按成交额与交易对稳定排序', () => {
  const volatile = candles.map(c => ({ ...c }));
  volatile.at(-1)!.close = 106;
  const result = addCandles(addBook(basePair(instrument, ticker, now), book), volatile, now);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some(reason => reason.includes('波动')));
  const a = basePair({ ...instrument, instId: 'A-USDT' }, ticker, now);
  const b = basePair({ ...instrument, instId: 'B-USDT' }, ticker, now);
  assert.deepEqual([b, a].sort(sortPairs).map(pair => pair.symbol), ['A-USDT', 'B-USDT']);
});

test('前一根已收盘K线剧烈波动时持续暂停30分钟，并保留已有较晚到期时间', () => {
  const volatile = candles.map(c => ({ ...c }));
  volatile.at(-2)!.close = 106;
  const expectedUntil = now + 25 * 60_000;
  const result = addCandles(addBook(basePair(instrument, ticker, now), book), volatile, now);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some(reason => reason.includes('波动')));
  assert.equal(volatilityPauseUntil(volatile, now), expectedUntil);
  assert.equal(volatilityPauseUntil(volatile, now, now + 40 * 60_000), now + 40 * 60_000);
  assert.equal(volatilityPauseUntil(volatile, expectedUntil), 0);
});

test('USDG 在默认已知稳定币名单中，可配置的基础币名单生效', () => {
  assert.equal(basePair({ ...instrument, instId: 'USDC-USDT', baseCcy: 'USDC' }, { ...ticker, instId: 'USDC-USDT' }, now).eligible, false);
  const usdg = basePair({ ...instrument, instId: 'USDG-USDT', baseCcy: 'USDG' }, { ...ticker, instId: 'USDG-USDT' }, now);
  assert.equal(usdg.eligible, false);
  assert.ok(usdg.reasons.some(reason => reason.includes('稳定币')));

  const configured = loadConfig({ SCREEN_EXCLUDED_STABLE_BASES: ' xyz, USDC,xyz ' });
  assert.deepEqual(configured.SCREEN_EXCLUDED_STABLE_BASES, ['XYZ', 'USDC']);
  const xyz = basePair({ ...instrument, instId: 'XYZ-USDT', baseCcy: 'XYZ' }, { ...ticker, instId: 'XYZ-USDT' }, now,
    { ...SCREEN, excludedStableBases: configured.SCREEN_EXCLUDED_STABLE_BASES });
  assert.equal(xyz.eligible, false);
  assert.equal(basePair({ ...instrument, instId: 'USDG-USDT', baseCcy: 'USDG' }, { ...ticker, instId: 'USDG-USDT' }, now,
    { ...SCREEN, excludedStableBases: configured.SCREEN_EXCLUDED_STABLE_BASES }).eligible, true);
  assert.throws(() => loadConfig({ SCREEN_EXCLUDED_STABLE_BASES: 'INVALID!' }), /配置无效/);
});
