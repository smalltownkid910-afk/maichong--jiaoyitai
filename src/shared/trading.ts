import type { Metrics, Position, Side, Trade } from './types.js';

export const RISK = { maxPositions: 3, perTrade: 0.01, total: 0.03, stopPct: 0.01, takePct: 0.02 } as const;
export type Rates = { feeRate: number; slippageRate: number };

export function fillPrice(price: number, side: Side, slippageRate: number, entry: boolean) {
  const buy = entry ? side === 'LONG' : side === 'SHORT';
  return price * (buy ? 1 + slippageRate : 1 - slippageRate);
}

export function grossPnl(position: Pick<Position, 'side' | 'entryPrice' | 'quantity'>, exitPrice: number) {
  return (position.side === 'LONG' ? exitPrice - position.entryPrice : position.entryPrice - exitPrice) * position.quantity;
}

export function stopRiskPerUnit(position: Pick<Position, 'side' | 'entryPrice' | 'stopLoss' | 'feeRate' | 'slippageRate'>) {
  const exit = fillPrice(position.stopLoss, position.side, position.slippageRate, false);
  const loss = position.side === 'LONG' ? position.entryPrice - exit : exit - position.entryPrice;
  return loss + position.entryPrice * position.feeRate + exit * position.feeRate;
}

export function markPnl(position: Position, price: number) {
  const exit = fillPrice(price, position.side, position.slippageRate, false);
  return grossPnl(position, exit) - exit * position.quantity * position.feeRate;
}

export function entryTerms(price: number, side: Side, rates: Rates) {
  const entryPrice = fillPrice(price, side, rates.slippageRate, true);
  return { side, entryPrice, stopLoss: entryPrice * (side === 'LONG' ? 1 - RISK.stopPct : 1 + RISK.stopPct),
    takeProfit: entryPrice * (side === 'LONG' ? 1 + RISK.takePct : 1 - RISK.takePct), ...rates };
}

export function sizeForRisk(price: number, equity: number, positions: Position[], terms: ReturnType<typeof entryTerms>) {
  const riskPerUnit = stopRiskPerUnit(terms);
  const valuationExit = fillPrice(price, terms.side, terms.slippageRate, false);
  const markCost = Math.abs(terms.entryPrice - valuationExit) + terms.entryPrice * terms.feeRate + valuationExit * terms.feeRate;
  const usedRisk = positions.reduce((sum, p) => sum + stopRiskPerUnit(p) * p.quantity, 0);
  const usedNotional = positions.reduce((sum, p) => sum + p.entryPrice * p.quantity, 0);
  const availableNotional = equity - usedNotional;
  const availableRisk = equity * RISK.total - usedRisk;
  const quantity = Math.min(equity * RISK.perTrade / (riskPerUnit + RISK.perTrade * markCost),
    availableRisk / (riskPerUnit + RISK.total * markCost), availableNotional / (terms.entryPrice + markCost));
  return Number.isFinite(quantity) && quantity > 0 && equity > 0 && availableRisk > 0 && availableNotional > 0 ? quantity : null;
}

export function exitTerms(position: Position, price: number, closedAt: number, exitReason: string): Trade {
  const exitPrice = fillPrice(price, position.side, position.slippageRate, false);
  const exitFee = exitPrice * position.quantity * position.feeRate;
  const gross = grossPnl(position, exitPrice);
  return { ...position, exitPrice, exitFee, closedAt, exitReason, grossPnl: gross, netPnl: gross - position.entryFee - exitFee };
}

export function calculateMetrics(trades: Trade[], initial: number, equity: number, equitySamples: number[] = [], fresh = true): Metrics {
  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl < 0);
  const winSum = wins.reduce((sum, t) => sum + t.netPnl, 0);
  const lossSum = -losses.reduce((sum, t) => sum + t.netPnl, 0);
  let peak = initial;
  let drawdown = 0;
  for (const value of fresh ? [...equitySamples, equity] : equitySamples) {
    if (!Number.isFinite(value)) continue;
    peak = Math.max(peak, value);
    if (peak > 0) drawdown = Math.max(drawdown, (peak - value) / peak * 100);
  }
  return { returnPct: fresh && initial > 0 ? (equity / initial - 1) * 100 : null, maxDrawdownPct: drawdown,
    winRatePct: trades.length ? wins.length / trades.length * 100 : null,
    avgWin: wins.length ? winSum / wins.length : null, avgLoss: losses.length ? lossSum / losses.length : null,
    profitFactor: lossSum > 0 ? winSum / lossSum : null, tradeCount: trades.length };
}
