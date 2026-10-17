import type { BacktestFrame, BacktestResult, Candle, Position, Side, Trade } from '../shared/types.js';
import { calculateMetrics, entryTerms, exitTerms, markPnl, RISK, sizeForRisk, type Rates } from '../shared/trading.js';
import { analyzeCandles } from './strategy.js';

export const BAR_MS = 300_000;
const MIN_BARS = 31;
export type BacktestOptions = Rates & { source?: 'historical' | 'replay'; warnings?: string[]; maxMovePct?: number; liquidateAtEnd?: boolean };

function validate(symbol: string, candles: Candle[]) {
  if (candles.length < MIN_BARS) throw new Error(`${symbol} 已收盘 K 线不足 ${MIN_BARS} 根`);
  candles.forEach((c, i) => {
    if (!c.confirmed || !Number.isSafeInteger(c.timestamp) || ![c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0)
      || !Number.isFinite(c.volume) || c.volume < 0 || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)
      || (i > 0 && c.timestamp - candles[i - 1].timestamp !== BAR_MS)) throw new Error(`${symbol} 历史数据无效或存在时间缺口`);
  });
}

/** Intrabar ambiguity is resolved conservatively: gap first, then stop before take. */
export function candleExit(position: Position, candle: Candle): { price: number; reason: string } | null {
  const long = position.side === 'LONG';
  if (long ? candle.open <= position.stopLoss : candle.open >= position.stopLoss) return { price: candle.open, reason: 'stop_loss' };
  if (long ? candle.open >= position.takeProfit : candle.open <= position.takeProfit) return { price: candle.open, reason: 'take_profit' };
  if (long ? candle.low <= position.stopLoss : candle.high >= position.stopLoss) return { price: position.stopLoss, reason: 'stop_loss' };
  if (long ? candle.high >= position.takeProfit : candle.low <= position.takeProfit) return { price: position.takeProfit, reason: 'take_profit' };
  return null;
}

export function runBacktest(input: Record<string, Candle[]>, options: BacktestOptions): BacktestResult {
  const symbols = Object.keys(input).sort();
  if (!symbols.length) throw new Error('没有可回测的数据');
  const data = new Map(symbols.map(symbol => {
    const candles = [...input[symbol]].sort((a, b) => a.timestamp - b.timestamp);
    validate(symbol, candles);
    return [symbol, candles] as const;
  }));
  const sharedStart = Math.max(...symbols.map(symbol => data.get(symbol)![0].timestamp));
  const sharedLast = Math.min(...symbols.map(symbol => data.get(symbol)!.at(-1)!.timestamp));
  const timeline = data.get(symbols[0])!.filter(c => c.timestamp >= sharedStart && c.timestamp <= sharedLast).map(c => c.timestamp);
  if (timeline.length < MIN_BARS) throw new Error(`币种共同覆盖窗口已收盘 K 线不足 ${MIN_BARS} 根`);
  const aligned = new Map(symbols.map(symbol => {
    const candles = data.get(symbol)!.filter(c => c.timestamp >= sharedStart && c.timestamp <= sharedLast);
    if (candles.length !== timeline.length || candles.some((c, i) => c.timestamp !== timeline[i])) {
      throw new Error('币种共同覆盖窗口 K 线时间未对齐');
    }
    return [symbol, candles] as const;
  }));
  const truncated = symbols.some(symbol => aligned.get(symbol)!.length !== data.get(symbol)!.length);
  const histories = new Map<string, Candle[]>(symbols.map(s => [s, []]));
  const barsByTime = new Map<string, Map<number, Candle>>(symbols.map(s => [s, new Map(aligned.get(s)!.map(c => [c.timestamp, c]))]));
  const pending = new Map<string, { side: Side; candleAt: number; volume: number; allowed: boolean }>();
  const marks = new Map<string, number>();
  const positions: Position[] = [];
  const trades: Trade[] = [];
  const frames: BacktestFrame[] = [];
  let balance = 10000;
  let id = 0;
  const equity = () => balance + positions.reduce((sum, p) => sum + markPnl(p, marks.get(p.symbol) ?? p.entryPrice), 0);
  const close = (position: Position, market: number, timestamp: number, reason: string) => {
    const trade = exitTerms(position, market, timestamp, reason);
    balance += trade.grossPnl - trade.exitFee;
    trades.push(trade);
    positions.splice(positions.indexOf(position), 1);
  };

  for (const timestamp of timeline) {
    const current = new Map(symbols.flatMap(symbol => {
      const candle = barsByTime.get(symbol)!.get(timestamp);
      return candle ? [[symbol, candle] as const] : [];
    }));
    for (const [symbol, candle] of current) marks.set(symbol, candle.open);
    const exited = new Set<string>();
    // Existing positions exit at the bar open before any new entries are sized.
    for (const position of [...positions]) {
      const candle = current.get(position.symbol);
      if (!candle) continue;
      const gap = candleExit(position, { ...candle, high: candle.open, low: candle.open, close: candle.open });
      if (gap) { close(position, gap.price, timestamp, gap.reason); exited.add(position.symbol); }
    }
    const orders = [...pending].filter(([symbol, order]) => current.has(symbol) && order.candleAt + BAR_MS === timestamp)
      .sort(([a, x], [b, y]) => y.volume - x.volume || a.localeCompare(b));
    for (const [symbol, order] of orders) {
      if (!order.allowed) continue;
      const candle = current.get(symbol)!;
      const existing = positions.find(p => p.symbol === symbol);
      if (existing) {
        if (existing.side !== order.side) { close(existing, candle.open, timestamp, 'reverse_signal'); exited.add(symbol); }
        continue;
      }
      if (exited.has(symbol) || positions.length >= RISK.maxPositions) continue;
      const terms = entryTerms(candle.open, order.side, options);
      const quantity = sizeForRisk(candle.open, equity(), positions, terms);
      if (quantity === null) continue;
      const entryFee = quantity * terms.entryPrice * options.feeRate;
      positions.push({ ...terms, id: ++id, symbol, quantity, entryFee, openedAt: timestamp, signalCandleAt: order.candleAt });
      balance -= entryFee;
    }
    for (const position of [...positions]) {
      const candle = current.get(position.symbol);
      if (!candle) continue;
      const exit = candleExit(position, candle);
      if (exit) close(position, exit.price, timestamp + BAR_MS - 1, exit.reason);
    }
    // Only now expose this closed candle to the strategy for the next bar.
    for (const [symbol, candle] of current) {
      marks.set(symbol, candle.close);
      const history = histories.get(symbol)!;
      history.push(candle);
      const analysis = analyzeCandles(history, timestamp + BAR_MS);
      if (analysis.signal === 'WAIT') { pending.delete(symbol); continue; }
      const pause = history.slice(-6).some(c => Math.abs((c.close / c.open - 1) * 100) > (options.maxMovePct ?? 5));
      pending.set(symbol, { side: analysis.signal, candleAt: timestamp,
        volume: history.slice(-288).reduce((sum, c) => sum + c.volume * c.close, 0), allowed: !pause });
    }
    frames.push({ timestamp: timestamp + BAR_MS, equity: equity(), balance, positions: positions.map(p => ({ ...p })), tradeCount: trades.length });
  }
  const endAt = timeline.at(-1)! + BAR_MS;
  if (options.liquidateAtEnd !== false) {
    for (const position of [...positions]) close(position, marks.get(position.symbol)!, endAt, 'window_end');
    frames[frames.length - 1] = { timestamp: endAt, equity: balance, balance, positions: [], tradeCount: trades.length };
  }
  const source = options.source ?? 'historical';
  return { source, label: source === 'replay' ? '离线合成样本回放 · 独立虚拟账户' : 'OKX 历史 K 线 · 当前候选池回测', symbols,
    startAt: timeline[0], endAt, bars: timeline.length, finalEquity: equity(), trades, frames,
    metrics: calculateMetrics(trades, 10000, equity(), frames.map(f => f.equity)),
    warnings: [...(options.warnings ?? []), ...(truncated ? [`各币种历史起止时间不一致；已截取共同覆盖窗口 ${new Date(sharedStart).toISOString()} 至 ${new Date(endAt).toISOString()}，窗口外 K 线未参与交易或估值。`] : []),
      '下一根 K 线开盘成交；同根双触及止损优先；跳空按开盘，不模拟蜡烛内部路径。',
      '仅复现 K 线数据连续性与短时波动筛选。未还原历史盘口、价差、上市名单和当时全市场候选池；存在选择偏差。',
      '信号顺序按当时已收盘 K 线量价估算成交额（最多过去 24 小时）；窗口末尾按收盘价统一平仓。',
      '做空为合成模拟，未计入借币与资金费；回测未写入实时账户。'] };
}

export function replaySamples(): Record<string, Candle[]> {
  const start = Date.UTC(2026, 0, 1);
  return Object.fromEntries(['BTC-USDT', 'ETH-USDT', 'SOL-USDT'].map((symbol, index) => {
    let previous = [80000, 2500, 110][index];
    const candles = Array.from({ length: 180 }, (_, i) => {
      const phase = Math.floor(i / 35) % 2 === 0 ? 1 : -1;
      const open = previous;
      const close = open * (1 + phase * (0.0012 + index * 0.0002) + Math.sin(i * 1.7 + index) * 0.0007);
      previous = close;
      return { timestamp: start + i * BAR_MS, open, close, high: Math.max(open, close) * 1.0015,
        low: Math.min(open, close) * 0.9985, volume: 10000 / (index + 1), confirmed: true };
    });
    return [symbol, candles];
  }));
}
