import type { AppDatabase } from './db.js';
import type { Candle, Market, PairView, Snapshot } from '../shared/types.js';
import { marketSymbol } from '../shared/markets.js';
import { OkxClient, type Book, type Instrument, type Ticker } from './okx.js';
import { SCREEN, addBook, addCandles, basePair, sortPairs, volatilityPauseUntil, type ScreenRules } from './screen.js';
import type { Config } from './config.js';
import { addAnalysis } from './strategy.js';
import { OkxTickerStream } from './market-stream.js';

const MAX_PAIRS = 20;
const MAX_REJECTED = 30;

export class Scanner {
  private readonly okx: OkxClient;
  private readonly instruments = new Map<string, Instrument>();
  private readonly tickers = new Map<string, Ticker>();
  private readonly books = new Map<string, Book>();
  private readonly candles = new Map<string, Candle[]>();
  private readonly selected = new Map<string, PairView>();
  private rejected: PairView[] = [];
  private readonly volatilityUntil = new Map<string, number>();
  private listeners = new Set<(snapshot: Snapshot, full: boolean) => void>();
  private signalListeners = new Set<(pair: PairView) => void>();
  private priceListeners = new Set<(tickers: Map<string, Ticker>, now: number) => void>();
  private accountProvider?: () => Snapshot['account'];
  private lastEmittedCandleAt = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private retryTimer?: NodeJS.Timeout;
  private retryDelayMs: number;
  private discovering = false;
  private refreshingTickers = false;
  private refreshingCandles = false;
  private lastSuccess = 0;
  private error = '';
  private discoveryError = '';
  private hasDiscovered = false;
  private started = false;
  private readonly rules: ScreenRules;
  private stream?: OkxTickerStream;
  private quoteMeta = new Map<string, { quoteSource: 'websocket' | 'rest'; receivedAt: number }>();
  private quoteTimer?: NodeJS.Timeout;
  private lastQuoteEmit = 0;
  private lastRestAt = 0;
  private readonly pollMs: number;
  private lifecycle = 0;

  constructor(okx: OkxClient, private readonly db: AppDatabase, private readonly log: { info: (message: string) => void; error: (message: string) => void }, config: Config, private readonly retryBaseMs = 30_000, useStreaming = false, readonly market: Market = 'spot') {
    this.okx = okx;
    this.retryDelayMs = retryBaseMs;
    this.pollMs = config.MARKET_POLL_MS;
    if (useStreaming && config.OKX_WS_URL) this.stream = new OkxTickerStream(config.OKX_WS_URL,
      tickers => this.acceptTickers(tickers, 'websocket'), () => { if (this.started) this.emitQuotes(); });
    this.rules = { ...SCREEN, minAgeDays: config.SCREEN_MIN_AGE_DAYS, minQuoteVolume: config.SCREEN_MIN_QUOTE_VOLUME,
      maxSpreadPct: config.SCREEN_MAX_SPREAD_PCT, minDepth: config.SCREEN_MIN_DEPTH, maxFiveMinuteMovePct: config.SCREEN_MAX_5M_MOVE_PCT,
      excludedStableBases: config.SCREEN_EXCLUDED_STABLE_BASES };
  }

  subscribe(listener: (snapshot: Snapshot, full: boolean) => void) {
    this.listeners.add(listener);
    listener(this.snapshot(), true);
    return () => this.listeners.delete(listener);
  }

  onSignal(listener: (pair: PairView) => void) {
    this.signalListeners.add(listener);
    return () => this.signalListeners.delete(listener);
  }

  onPrices(listener: (tickers: Map<string, Ticker>, now: number) => void) {
    this.priceListeners.add(listener);
    return () => this.priceListeners.delete(listener);
  }

  setAccountProvider(provider: () => Snapshot['account']) { this.accountProvider = provider; }

  private emitSignalOnce(pair: PairView) {
    const candleAt = pair.lastCandleAt;
    if (!pair.eligible || candleAt === null || this.lastEmittedCandleAt.get(pair.symbol) === candleAt) return;
    const previous = this.db.prepare('SELECT candle_at FROM processed_signals WHERE symbol=?').get(pair.symbol) as { candle_at: number } | undefined;
    if (previous && candleAt <= previous.candle_at) { this.lastEmittedCandleAt.set(pair.symbol, previous.candle_at); return; }
    this.db.prepare('INSERT INTO processed_signals(symbol,candle_at) VALUES(?,?) ON CONFLICT(symbol) DO UPDATE SET candle_at=excluded.candle_at WHERE excluded.candle_at>processed_signals.candle_at').run(pair.symbol, candleAt);
    this.lastEmittedCandleAt.set(pair.symbol, candleAt);
    for (const listener of this.signalListeners) listener(pair);
  }

  private emit(full = true) { const value = this.snapshot(); for (const listener of this.listeners) listener(value, full); }
  publish() { this.syncSymbols(); this.emit(); }
  private trackedSymbols() {
    return [...new Set([...this.selected.keys(), ...(this.db.prepare('SELECT symbol FROM positions').all() as { symbol: string }[]).map(row => row.symbol)])];
  }
  private syncSymbols() { if (this.started) this.stream?.setSymbols(this.trackedSymbols()); }
  private streamFresh() {
    const symbols = this.trackedSymbols();
    return this.stream?.state === 'connected' && symbols.length > 0 && symbols.every(symbol => {
      const ticker = this.tickers.get(symbol);
      return ticker && this.quoteMeta.get(symbol)?.quoteSource === 'websocket' && Date.now() - Number(ticker.ts) <= 3000;
    });
  }
  private emitQuotes() {
    if (!this.started) { this.emit(false); return; }
    if (this.quoteTimer) return;
    const wait = Math.max(0, 1000 - (Date.now() - this.lastQuoteEmit));
    if (!wait) { this.lastQuoteEmit = Date.now(); this.emit(false); return; }
    this.quoteTimer = setTimeout(() => { this.quoteTimer = undefined; this.lastQuoteEmit = Date.now(); this.emit(false); }, wait);
  }
  private mergeTickers(tickers: Ticker[], source: 'websocket' | 'rest') {
    const changed = new Set<string>();
    const now = Date.now();
    for (const ticker of tickers) {
      if (!ticker || !marketSymbol(this.market, ticker.instId)) continue;
      const ts = Number(ticker.ts);
      if (!Number.isFinite(ts) || ts <= 0 || ts > now + 5000 ||
        !['last', 'bidPx', 'askPx', 'open24h'].every(key => Number.isFinite(Number(ticker[key as keyof Ticker])) && Number(ticker[key as keyof Ticker]) > 0) ||
        !Number.isFinite(Number(ticker.volCcy24h)) || Number(ticker.volCcy24h) < 0) continue;
      const old = this.tickers.get(ticker.instId);
      if (old && (ts < Number(old.ts) || (ts === Number(old.ts) && (source === 'rest' || this.quoteMeta.get(ticker.instId)?.quoteSource === 'websocket')))) continue;
      this.tickers.set(ticker.instId, { ...ticker });
      this.quoteMeta.set(ticker.instId, { quoteSource: source, receivedAt: now });
      changed.add(ticker.instId);
    }
    return changed;
  }
  private notifyPrices() {
    const now = Date.now();
    this.lastSuccess = this.selected.size > 0 ? Math.max(0, ...[...this.selected.values()].map(pair => pair.updatedAt ?? 0))
      : Math.max(0, ...[...this.tickers.values()].map(ticker => Number(ticker.ts)));
    this.error = this.discoveryError;
    for (const listener of this.priceListeners) {
      try { listener(this.tickers, now); } catch (error) { this.log.error(`模拟交易处理失败：${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  acceptTickers(tickers: Ticker[], source: 'websocket' | 'rest') {
    const changed = this.mergeTickers(tickers, source);
    const now = Date.now();
    for (const symbol of changed) {
      const old = this.selected.get(symbol), instrument = this.instruments.get(symbol);
      if (!old || !instrument) continue;
      let pair = basePair(instrument, this.tickers.get(symbol), now, this.rules);
      const book = this.books.get(symbol);
      if (book) pair = addBook(pair, book, this.rules);
      pair = addCandles(pair, this.candles.get(symbol) ?? [], now, this.volatilityUntil.get(symbol), this.rules);
      this.selected.set(symbol, { ...pair, signal: old.signal, ema9: old.ema9, ema21: old.ema21, rsi14: old.rsi14, ...this.quoteMeta.get(symbol) });
    }
    if (changed.size) this.notifyPrices();
    this.emitQuotes();
  }

  snapshot(): Snapshot {
    const now = Date.now();
    const pairs = this.getSelected().concat(this.rejected.slice(0, MAX_REJECTED));
    const balance = Number((this.db.prepare("SELECT value FROM settings WHERE key='balance'").get() as { value: string }).value);
    const initialBalance = Number((this.db.prepare("SELECT value FROM settings WHERE key='initial_balance'").get() as { value: string }).value);
    const status: Snapshot['status'] = this.error ? 'error' : !this.hasDiscovered || !this.lastSuccess ? 'loading' :
      now - this.lastSuccess <= 15_000 ? 'live' : 'stale';
    const latestCandles: Record<string, Candle[]> = {};
    for (const symbol of this.selected.keys()) latestCandles[symbol] = this.candles.get(symbol) ?? [];
    return {
      status, statusMessage: status === 'live' ? `已自动扫描 ${this.selected.size} 个币种` :
        status === 'loading' ? '正在连接 OKX 并筛选币种' : status === 'stale' ? '行情更新延迟，交易暂停' : 'OKX 连接异常，交易暂停',
      updatedAt: this.lastSuccess || null, pairs,
      feed: { mode: this.streamFresh() ? 'websocket' : 'polling', state: this.stream?.state ?? 'disabled',
        lastMessageAt: this.stream?.lastMessageAt || null, reconnects: this.stream?.reconnects ?? 0, pollMs: this.pollMs },
      account: this.accountProvider?.() ?? { balance, initialBalance, equity: balance, unrealizedPnl: 0, realizedPnl: balance - initialBalance, autoTrading: false, positions: [], trades: [] },
      candles: latestCandles, ...(this.error ? { error: this.error } : {})
    };
  }

  start() {
    if (this.started) return;
    this.lifecycle++;
    this.started = true;
    this.stream?.start(this.trackedSymbols());
    void this.discover();
    this.timers.push(setInterval(() => { if (!this.streamFresh() || Date.now() - this.lastRestAt >= 30000) void this.refreshTickers(); }, this.pollMs));
    this.timers.push(setInterval(() => void this.refreshCandles(), 60_000));
    this.timers.push(setInterval(() => void this.discover(), 30 * 60_000));
  }

  stop() {
    this.lifecycle++;
    this.started = false;
    this.stream?.stop();
    clearTimeout(this.quoteTimer); this.quoteTimer = undefined;
    for (const timer of this.timers) clearInterval(timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.timers = [];
    this.started = false;
  }

  private async screenOne(base: PairView): Promise<PairView> {
    let pair = base;
    try {
      const book = await this.okx.book(base.symbol);
      this.books.set(base.symbol, book);
      pair = addBook(pair, book, this.rules);
      if (!pair.eligible) return pair;
      const candles = await this.okx.candles(base.symbol);
      this.candles.set(base.symbol, candles);
      const now = Date.now();
      const until = volatilityPauseUntil(candles, now, this.volatilityUntil.get(base.symbol), this.rules);
      this.volatilityUntil.set(base.symbol, until);
      pair = addAnalysis(addCandles(pair, candles, now, until, this.rules), candles, now);
    } catch (error) {
      pair = { ...pair, eligible: false, reasons: [...pair.reasons, `盘口或K线获取失败：${error instanceof Error ? error.message : String(error)}`] };
    }
    return pair;
  }

  async discover() {
    if (this.discovering) return;
    const lifecycle = this.lifecycle;
    this.discovering = true;
    try {
      const [instruments, tickers] = await Promise.all([this.okx.instruments(), this.okx.tickers()]);
      if (lifecycle !== this.lifecycle) return;
      const now = Date.now();
      this.mergeTickers(tickers, 'rest');
      const tickerMap = this.tickers;
      const all = instruments.filter(i => i.quoteCcy === 'USDT' && marketSymbol(this.market, i.instId)).map(i => {
        this.instruments.set(i.instId, i);
        return basePair(i, tickerMap.get(i.instId), now, this.rules);
      }).sort(sortPairs);
      const rejected = all.filter(pair => !pair.eligible);
      const candidates = all.filter(pair => pair.eligible);
      const passed: PairView[] = [];
      for (let i = 0; i < candidates.length && passed.length < MAX_PAIRS; i += 4) {
        const results = await Promise.all(candidates.slice(i, i + 4).map(pair => this.screenOne(pair)));
        if (lifecycle !== this.lifecycle) return;
        for (const pair of results) (pair.eligible ? passed : rejected).push(pair);
      }
      passed.sort(sortPairs);
      this.selected.clear();
      for (const pair of passed.slice(0, MAX_PAIRS)) this.selected.set(pair.symbol, pair);
      for (const [symbol, pair] of this.selected) this.selected.set(symbol, { ...pair, ...this.quoteMeta.get(symbol) });
      this.syncSymbols();
      this.rejected = rejected.sort(sortPairs).slice(0, MAX_REJECTED);
      this.hasDiscovered = true;
      this.discoveryError = '';
      this.error = '';
      this.retryDelayMs = this.retryBaseMs;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.log.info(`OKX 候选池更新：${this.selected.size} 个通过筛选`);
      for (const pair of this.selected.values()) this.emitSignalOnce(pair);
      this.notifyPrices();
      this.emit();
      await this.refreshTickers();
    } catch (error) {
      if (lifecycle !== this.lifecycle) return;
      this.discoveryError = error instanceof Error ? error.message : String(error);
      this.error = this.discoveryError;
      this.log.error(`OKX 候选池更新失败：${this.discoveryError}`);
      this.emit();
      if (this.started && !this.retryTimer) {
        const delay = this.retryDelayMs;
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, 300_000);
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.discover(); }, delay);
      }
    } finally { this.discovering = false; }
  }

  async refreshTickers() {
    if (this.refreshingTickers) return;
    const lifecycle = this.lifecycle;
    this.refreshingTickers = true;
    try {
      const tickers = await this.okx.tickers();
      if (lifecycle !== this.lifecycle) return;
      this.lastRestAt = Date.now();
      this.error = this.discoveryError;
      this.acceptTickers(tickers, 'rest');
      if (this.hasDiscovered) this.error = this.discoveryError;
    } catch (error) {
      if (lifecycle !== this.lifecycle) return;
      const message = error instanceof Error ? error.message : String(error);
      this.error = this.discoveryError || (this.streamFresh() && this.hasDiscovered ? '' : message);
      this.log.error(`OKX 行情更新失败：${message}`);
      this.emitQuotes();
    } finally { this.refreshingTickers = false; }
  }
  async refreshCandles() {
    if (this.refreshingCandles || this.selected.size === 0) return;
    const lifecycle = this.lifecycle;
    this.refreshingCandles = true;
    try {
      for (const symbol of this.selected.keys()) {
        try {
          const candles = await this.okx.candles(symbol);
          if (lifecycle !== this.lifecycle) return;
          this.candles.set(symbol, candles);
          const until = volatilityPauseUntil(candles, Date.now(), this.volatilityUntil.get(symbol), this.rules);
          this.volatilityUntil.set(symbol, until);
          const instrument = this.instruments.get(symbol);
          if (!instrument) continue;
          let pair = basePair(instrument, this.tickers.get(symbol), Date.now(), this.rules);
          const book = this.books.get(symbol);
          if (book) pair = addBook(pair, book, this.rules);
          pair = addAnalysis(addCandles(pair, candles, Date.now(), until, this.rules), candles, Date.now());
          this.selected.set(symbol, { ...pair, ...this.quoteMeta.get(symbol) });
          this.emitSignalOnce(pair);
        } catch (error) {
          this.log.error(`OKX ${symbol} K线更新失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.emit();
    } finally { this.refreshingCandles = false; }
  }

  getCandles(symbol: string) { return this.candles.get(symbol) ?? []; }
  getSelected() {
    const now = Date.now();
    return [...this.selected.values()].map(pair => pair.updatedAt === null || now - pair.updatedAt > 15000
      ? { ...pair, eligible: false, reasons: [...new Set([...pair.reasons, '行情数据过期'])] } : pair).sort(sortPairs);
  }
}

