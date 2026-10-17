export type Market = 'spot' | 'swap';
export type Signal = 'LONG' | 'SHORT' | 'WAIT';
export type Side = 'LONG' | 'SHORT';
export type Candle = { timestamp: number; open: number; high: number; low: number; close: number; volume: number; confirmed: boolean };
export type PairView = { quoteVolumeEstimated?: boolean; quoteSource?: 'websocket' | 'rest'; receivedAt?: number; symbol: string; price: number | null; change24h: number | null; quoteVolume24h: number | null; spreadPct: number | null; bidDepth: number | null; askDepth: number | null; ageDays: number | null; eligible: boolean; reasons: string[]; signal: Signal; ema9: number | null; ema21: number | null; rsi14: number | null; lastCandleAt: number | null; updatedAt: number | null };
export type Position = { id: number; symbol: string; side: Side; quantity: number; entryPrice: number; stopLoss: number; takeProfit: number; entryFee: number; openedAt: number; signalCandleAt: number; feeRate: number; slippageRate: number };
export type Trade = Position & { exitPrice: number; exitFee: number; closedAt: number; exitReason: string; grossPnl: number; netPnl: number };
export type Metrics = { returnPct: number | null; maxDrawdownPct: number; winRatePct: number | null; avgWin: number | null; avgLoss: number | null; profitFactor: number | null; tradeCount: number };
export type Account = { balance: number; initialBalance: number; equity: number; unrealizedPnl: number; realizedPnl: number; autoTrading: boolean; positions: Position[]; trades: Trade[]; metrics?: Metrics; valuationStale?: boolean };
export type Snapshot = { market?: Market; priceType?: 'last'; feed?: { mode: 'websocket' | 'polling'; state: string; lastMessageAt: number | null; reconnects: number; pollMs: number }; status: 'loading' | 'live' | 'stale' | 'error' | 'replay'; statusMessage: string; updatedAt: number | null; pairs: PairView[]; account: Account; candles: Record<string, Candle[]>; error?: string };
export type BacktestFrame = { timestamp: number; equity: number; balance: number; positions: Position[]; tradeCount: number };
export type BacktestResult = { source: 'historical' | 'replay'; label: string; symbols: string[]; startAt: number; endAt: number; bars: number; warnings: string[]; trades: Trade[]; metrics: Metrics; finalEquity: number; frames: BacktestFrame[]; candles?: Record<string, Candle[]> };

