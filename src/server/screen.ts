import type { Candle, PairView } from '../shared/types.js';
import type { Book, Instrument, Ticker } from './okx.js';

export const SCREEN = {
  minAgeDays: 90,
  minQuoteVolume: 10_000_000,
  maxSpreadPct: 0.2,
  depthBandPct: 0.5,
  minDepth: 100_000,
  maxFiveMinuteMovePct: 5,
  volatilityPauseMs: 30 * 60_000,
  candleMs: 5 * 60_000,
  minCandles: 30,
  excludedStableBases: ['USDC', 'DAI', 'FDUSD', 'TUSD', 'PYUSD', 'USDD', 'USDE', 'USD1', 'RLUSD', 'EURC', 'USDG']
} as const;
export type ScreenRules = { minAgeDays: number; minQuoteVolume: number; maxSpreadPct: number; depthBandPct: number; minDepth: number; maxFiveMinuteMovePct: number; volatilityPauseMs: number; candleMs: number; minCandles: number; excludedStableBases: readonly string[] };

export function basePair(instrument: Instrument, ticker: Ticker | undefined, now: number, rules: ScreenRules = SCREEN): PairView {
  const ageDays = Number.isFinite(Number(instrument.listTime)) && Number(instrument.listTime) > 0
    ? (now - Number(instrument.listTime)) / 86_400_000 : null;
  const price = ticker ? Number(ticker.last) : NaN;
  // SWAP volCcy24h is base currency volume; SPOT is quote currency turnover.
  const estimated = instrument.instType === 'SWAP';
  const volume = ticker ? Number(ticker.volCcy24h) * (estimated ? price : 1) : NaN;
  const bid = ticker ? Number(ticker.bidPx) : NaN;
  const ask = ticker ? Number(ticker.askPx) : NaN;
  const spread = bid > 0 && ask >= bid ? ((ask - bid) / ((ask + bid) / 2)) * 100 : NaN;
  const open = ticker ? Number(ticker.open24h) : NaN;
  const reasons: string[] = [];
  if (instrument.state !== 'live') reasons.push('交易状态非正常');
  if (rules.excludedStableBases.includes(instrument.baseCcy.toUpperCase())) reasons.push('命中稳定币基础币排除名单');
  if (ageDays === null || ageDays < rules.minAgeDays) reasons.push(`上市不足${rules.minAgeDays}天或上市时间缺失`);
  if (!Number.isFinite(volume) || volume < rules.minQuoteVolume) reasons.push(`24小时成交额不足${rules.minQuoteVolume.toLocaleString('zh-CN')}`);
  if (!Number.isFinite(price) || price <= 0) reasons.push('价格数据无效');
  if (!Number.isFinite(spread) || spread > rules.maxSpreadPct) reasons.push(`买卖价差超过${rules.maxSpreadPct}%或缺失`);
  const ts = ticker ? Number(ticker.ts) : NaN;
  if (!Number.isFinite(ts) || now - ts > 15_000 || ts > now + 5_000) reasons.push('行情数据过期');
  return {
    symbol: instrument.instId, price: Number.isFinite(price) && price > 0 ? price : null,
    change24h: Number.isFinite(open) && open > 0 && Number.isFinite(price) ? (price / open - 1) * 100 : null,
    quoteVolume24h: Number.isFinite(volume) ? volume : null, ...(estimated ? { quoteVolumeEstimated: true } : {}),
    spreadPct: Number.isFinite(spread) ? spread : null,
    bidDepth: null, askDepth: null, ageDays, eligible: reasons.length === 0, reasons,
    signal: 'WAIT', ema9: null, ema21: null, rsi14: null, lastCandleAt: null,
    updatedAt: Number.isFinite(ts) ? ts : null
  };
}

export function addBook(pair: PairView, book: Book, rules: ScreenRules = SCREEN): PairView {
  const bid = Number(book.bids[0]?.[0]);
  const ask = Number(book.asks[0]?.[0]);
  const mid = (bid + ask) / 2;
  const reasons = [...pair.reasons];
  if (!Number.isFinite(mid) || mid <= 0) reasons.push('盘口数据无效');
  const sum = (rows: string[][], keep: (price: number) => boolean) => rows.reduce((total, row) => {
    const price = Number(row[0]);
    const size = Number(row[1]);
    return Number.isFinite(price) && Number.isFinite(size) && keep(price) ? total + price * size : total;
  }, 0);
  const bidDepth = mid > 0 ? sum(book.bids, price => price >= mid * (1 - rules.depthBandPct / 100)) : 0;
  const askDepth = mid > 0 ? sum(book.asks, price => price <= mid * (1 + rules.depthBandPct / 100)) : 0;
  if (bidDepth < rules.minDepth || askDepth < rules.minDepth) reasons.push(`盘口深度不足${rules.minDepth.toLocaleString('zh-CN')}`);
  return { ...pair, bidDepth, askDepth, eligible: reasons.length === 0, reasons };
}

export function addCandles(pair: PairView, candles: Candle[], now: number, volatilityUntil = 0, rules: ScreenRules = SCREEN): PairView {
  const reasons = [...pair.reasons];
  const closed = candles.filter(c => c.confirmed && c.timestamp + rules.candleMs <= now).sort((a, b) => a.timestamp - b.timestamp);
  if (closed.length < rules.minCandles) reasons.push('已收盘K线不足');
  if (closed.some((c, i) => i > 0 && c.timestamp - closed[i - 1].timestamp !== rules.candleMs)) reasons.push('K线存在时间缺口');
  const last = closed.at(-1);
  if (!last || now - (last.timestamp + rules.candleMs) > 6 * 60_000) reasons.push('K线数据过期');
  if (volatilityPauseUntil(closed, now, volatilityUntil, rules) > now) reasons.push(`5分钟波动超过${rules.maxFiveMinuteMovePct}%，暂停30分钟`);
  return { ...pair, lastCandleAt: last?.timestamp ?? null, eligible: reasons.length === 0, reasons };
}

export function volatilityPauseUntil(candles: Candle[], now: number, existingUntil = 0, rules: ScreenRules = SCREEN): number {
  let until = existingUntil;
  for (const candle of candles) {
    if (!candle.confirmed || candle.timestamp + rules.candleMs > now) continue;
    const expiresAt = candle.timestamp + rules.candleMs + rules.volatilityPauseMs;
    if (expiresAt <= now || candle.open <= 0) continue;
    if (Math.abs(candle.close / candle.open - 1) * 100 > rules.maxFiveMinuteMovePct) {
      until = Math.max(until, expiresAt);
    }
  }
  return until;
}

export function sortPairs(a: PairView, b: PairView) {
  return (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0) || a.symbol.localeCompare(b.symbol);
}
