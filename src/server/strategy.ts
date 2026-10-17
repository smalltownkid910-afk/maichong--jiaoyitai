import { EMA, RSI } from 'technicalindicators';
import type { Candle, PairView, Signal } from '../shared/types.js';

export type Analysis = { signal: Signal; ema9: number | null; ema21: number | null; rsi14: number | null; candleAt: number | null };
const PERIOD_MS = 5 * 60_000;

export function analyzeCandles(candles: Candle[], now: number): Analysis {
  const closed = candles.filter(c => c.confirmed && c.timestamp + PERIOD_MS <= now).sort((a, b) => a.timestamp - b.timestamp);
  const candleAt = closed.at(-1)?.timestamp ?? null;
  const unavailable: Analysis = { signal: 'WAIT', ema9: null, ema21: null, rsi14: null, candleAt };
  if (closed.length < 30 || closed.some((c, i) =>
    !Number.isFinite(c.close) || c.close <= 0 || (i > 0 && c.timestamp - closed[i - 1].timestamp !== PERIOD_MS))) return unavailable;
  const values = closed.map(c => c.close);
  const ema9 = EMA.calculate({ period: 9, values }).at(-1);
  const ema21 = EMA.calculate({ period: 21, values }).at(-1);
  const rsi14 = RSI.calculate({ period: 14, values }).at(-1);
  if (ema9 === undefined || ema21 === undefined || rsi14 === undefined || !Number.isFinite(rsi14)) return unavailable;
  const signal: Signal = ema9 > ema21 && rsi14 > 50 ? 'LONG' : ema9 < ema21 && rsi14 < 50 ? 'SHORT' : 'WAIT';
  return { signal, ema9, ema21, rsi14, candleAt };
}

export function addAnalysis(pair: PairView, candles: Candle[], now: number): PairView {
  const analysis = analyzeCandles(candles, now);
  return { ...pair, signal: analysis.signal, ema9: analysis.ema9, ema21: analysis.ema21, rsi14: analysis.rsi14, lastCandleAt: analysis.candleAt };
}
