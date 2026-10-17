import type { Account, PairView, Position, Side, Trade } from '../shared/types.js';
import type { AppDatabase } from './db.js';
import type { Scanner } from './scanner.js';
import type { Ticker } from './okx.js';
import type { Config } from './config.js';
import { calculateMetrics, entryTerms, exitTerms, markPnl, RISK, sizeForRisk } from '../shared/trading.js';

const MAX_QUOTE_AGE_MS = 15_000;
const CANDLE_MS = 5 * 60_000;

export type ActionResult = { ok: true; message: string; position?: Position; trade?: Trade } | { ok: false; message: string };

function transact<T>(db: AppDatabase, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

const positionColumns = `id,symbol,side,quantity,entry_price AS entryPrice,stop_loss AS stopLoss,
  take_profit AS takeProfit,entry_fee AS entryFee,opened_at AS openedAt,signal_candle_at AS signalCandleAt,
  fee_rate AS feeRate,slippage_rate AS slippageRate`;
const tradeColumns = `${positionColumns},exit_price AS exitPrice,exit_fee AS exitFee,
  closed_at AS closedAt,exit_reason AS exitReason,gross_pnl AS grossPnl,net_pnl AS netPnl`;

export class Broker {
  private quotes = new Map<string, Ticker>();
  private lastEquitySampleAt = 0;
  private observedDrawdown: number;

  constructor(private readonly db: AppDatabase, private readonly scanner: Scanner, private readonly config: Config) {
    this.observedDrawdown = Number(this.setting('max_observed_drawdown') || 0);
    scanner.setAccountProvider(() => this.account());
    scanner.onPrices((tickers, now) => this.onPrices(tickers, now));
  }

  private setting(key: string) { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value ?? ''; }
  private setSetting(key: string, value: string) { this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  private positions(): Position[] { return this.db.prepare(`SELECT ${positionColumns} FROM positions ORDER BY opened_at,id`).all() as unknown as Position[]; }
  private trades(): Trade[] { return this.db.prepare(`SELECT ${tradeColumns} FROM trades ORDER BY closed_at DESC,id DESC`).all() as unknown as Trade[]; }

  private quote(symbol: string, now = Date.now()) {
    const ticker = this.quotes.get(symbol);
    const price = ticker ? Number(ticker.last) : NaN;
    const ts = ticker ? Number(ticker.ts) : NaN;
    return Number.isFinite(price) && price > 0 && Number.isFinite(ts) && ts <= now + 5000 && now - ts <= MAX_QUOTE_AGE_MS ? price : null;
  }

  account(): Account {
    const positions = this.positions();
    const trades = this.trades();
    const balance = Number(this.setting('balance'));
    const initialBalance = Number(this.setting('initial_balance'));
    const realizedPnl = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
    const marketValue = positions.reduce((sum, position) => {
      const price = this.quote(position.symbol) ?? position.entryPrice;
      return sum + markPnl(position, price);
    }, 0);
    const equity = balance + marketValue;
    const valuationStale = positions.some(position => this.quote(position.symbol) === null);
    const metrics = calculateMetrics(trades, initialBalance, equity, (this.db.prepare('SELECT equity FROM equity_samples ORDER BY timestamp').all() as { equity: number }[]).map(row => row.equity), !valuationStale);
    this.observedDrawdown = Math.max(this.observedDrawdown, metrics.maxDrawdownPct);
    metrics.maxDrawdownPct = this.observedDrawdown;
    return { balance, initialBalance, equity, unrealizedPnl: equity - initialBalance - realizedPnl,
      realizedPnl, autoTrading: this.setting('auto_trading') === 'true', positions, trades,
      valuationStale,
      metrics };
  }

  private recordEquity(now: number, force = false) {
    if (!force && now - this.lastEquitySampleAt < 1000) return;
    if (this.positions().some(p => this.quote(p.symbol, now) === null)) return;
    this.lastEquitySampleAt = now;
    this.db.prepare('INSERT INTO equity_samples(timestamp,equity) VALUES(?,?) ON CONFLICT(timestamp) DO UPDATE SET equity=excluded.equity').run(now, this.account().equity);
    this.flushMetrics();
  }
  flushMetrics() { this.setSetting('max_observed_drawdown', String(this.observedDrawdown)); }

  setAutoTrading(enabled: boolean) {
    transact(this.db, () => {
      this.setSetting('auto_trading', String(enabled));
      if (enabled) this.setSetting('auto_started_at', String(Date.now()));
    });
    this.scanner.publish();
    return this.account();
  }

  private markHandled(symbol: string, candleAt: number) {
    this.db.prepare('INSERT INTO handled_signals(symbol,candle_at) VALUES(?,?) ON CONFLICT(symbol) DO UPDATE SET candle_at=excluded.candle_at WHERE excluded.candle_at>handled_signals.candle_at').run(symbol, candleAt);
  }

  private handled(symbol: string) { return (this.db.prepare('SELECT candle_at FROM handled_signals WHERE symbol=?').get(symbol) as { candle_at: number } | undefined)?.candle_at ?? 0; }

  open(symbol: string, side: Side, signalCandleAt = 0, handledCandleAt?: number): ActionResult {
    const now = Date.now();
    const pair = this.scanner.getSelected().find(item => item.symbol === symbol);
    const price = this.quote(symbol, now);
    if (this.scanner.snapshot().status !== 'live' || !pair?.eligible || price === null) return { ok: false, message: '行情过期或币种未通过筛选' };
    const result = transact(this.db, (): ActionResult => {
      if (handledCandleAt !== undefined) this.markHandled(symbol, handledCandleAt);
      const positions = this.positions();
      if (positions.some(position => position.symbol === symbol)) return { ok: false, message: '该币种已有持仓' };
      if (positions.length >= RISK.maxPositions) return { ok: false, message: '已达到最多3个持仓' };
      const account = this.account();
      if (!Number.isFinite(account.equity) || account.equity <= 0) return { ok: false, message: '虚拟账户权益不足' };
      const feeRate = this.config.SIM_FEE_RATE;
      const slippageRate = this.config.SIM_SLIPPAGE_RATE;
      const { entryPrice, stopLoss, takeProfit } = entryTerms(price, side, { feeRate, slippageRate });
      const quantity = sizeForRisk(price, account.equity, positions, entryTerms(price, side, { feeRate, slippageRate }));
      if (quantity === null) return { ok: false, message: '全账户风险或名义仓位上限已用尽' };
      const entryFee = quantity * entryPrice * feeRate;
      const inserted = this.db.prepare(`INSERT INTO positions(symbol,side,quantity,entry_price,stop_loss,take_profit,entry_fee,opened_at,signal_candle_at,fee_rate,slippage_rate)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(symbol, side, quantity, entryPrice, stopLoss, takeProfit, entryFee, now, signalCandleAt, feeRate, slippageRate);
      this.setSetting('balance', String(account.balance - entryFee));
      const position = this.db.prepare(`SELECT ${positionColumns} FROM positions WHERE id=?`).get(inserted.lastInsertRowid) as unknown as Position;
      return { ok: true, message: '虚拟入场已记录', position };
    });
    this.recordEquity(now, true);
    this.scanner.publish();
    return result;
  }

  close(id: number, reason = 'manual', handledCandleAt?: number): ActionResult {
    const position = this.db.prepare(`SELECT ${positionColumns} FROM positions WHERE id=?`).get(id) as unknown as Position | undefined;
    if (!position) return { ok: false, message: '持仓不存在' };
    const price = this.quote(position.symbol);
    if (price === null) return { ok: false, message: '当前行情过期，不能模拟成交' };
    const result = transact(this.db, (): ActionResult => {
      if (handledCandleAt !== undefined) this.markHandled(position.symbol, handledCandleAt);
      const current = this.db.prepare(`SELECT ${positionColumns} FROM positions WHERE id=?`).get(id) as unknown as Position | undefined;
      if (!current) return { ok: false, message: '持仓已平仓' };
      const closedAt = Date.now();
      const trade = exitTerms(current, price, closedAt, reason);
      const { exitPrice, exitFee, grossPnl } = trade;
      this.db.prepare(`INSERT INTO trades(id,symbol,side,quantity,entry_price,stop_loss,take_profit,entry_fee,opened_at,signal_candle_at,fee_rate,slippage_rate,exit_price,exit_fee,closed_at,exit_reason,gross_pnl,net_pnl)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(current.id, current.symbol, current.side, current.quantity, current.entryPrice, current.stopLoss,
        current.takeProfit, current.entryFee, current.openedAt, current.signalCandleAt, current.feeRate, current.slippageRate,
        exitPrice, exitFee, closedAt, reason, grossPnl, trade.netPnl);
      this.db.prepare('DELETE FROM positions WHERE id=?').run(id);
      this.setSetting('balance', String(Number(this.setting('balance')) + grossPnl - exitFee));
      return { ok: true, message: '虚拟平仓已记录', trade };
    });
    this.recordEquity(Date.now(), true);
    this.scanner.publish();
    return result;
  }

  reset() {
    this.lastEquitySampleAt = 0;
    this.observedDrawdown = 0;
    transact(this.db, () => {
      this.db.exec('DELETE FROM positions; DELETE FROM trades; DELETE FROM handled_signals; DELETE FROM equity_samples;');
      this.setSetting('balance', '10000');
      this.setSetting('initial_balance', '10000');
      this.setSetting('auto_trading', 'false');
      this.setSetting('auto_started_at', '0');
      this.setSetting('max_observed_drawdown', '0');
    });
    this.scanner.publish();
    return this.account();
  }

  private onPrices(tickers: Map<string, Ticker>, now: number) {
    this.quotes = tickers;
    for (const position of this.positions()) {
      const price = this.quote(position.symbol, now);
      if (price === null) continue;
      const stop = position.side === 'LONG' ? price <= position.stopLoss : price >= position.stopLoss;
      const take = position.side === 'LONG' ? price >= position.takeProfit : price <= position.takeProfit;
      if (stop || take) this.close(position.id, stop ? 'stop_loss' : 'take_profit');
    }
    if (this.setting('auto_trading') === 'true' && this.scanner.snapshot().status === 'live') {
      const startedAt = Number(this.setting('auto_started_at'));
      for (const pair of this.scanner.getSelected()) this.handleSignal(pair, startedAt, now);
    }
    this.recordEquity(now);
  }

  private handleSignal(pair: PairView, startedAt: number, now: number) {
    const candleAt = pair.lastCandleAt;
    if (!pair.eligible || pair.signal === 'WAIT' || candleAt === null || candleAt <= this.handled(pair.symbol)) return;
    const closedAt = candleAt + CANDLE_MS;
    if (closedAt < startedAt || now - closedAt > CANDLE_MS || this.quote(pair.symbol, now) === null) return;
    const existing = this.positions().find(position => position.symbol === pair.symbol);
    if (existing) {
      if (existing.side !== pair.signal) this.close(existing.id, 'reverse_signal', candleAt);
      else transact(this.db, () => this.markHandled(pair.symbol, candleAt));
      return;
    }
    this.open(pair.symbol, pair.signal, candleAt, candleAt);
  }
}
