import type { Candle, Market } from '../shared/types.js';
import { marketSymbol } from '../shared/markets.js';
import type { Config } from './config.js';

export type Instrument = { instId: string; baseCcy: string; quoteCcy: string; state: string; listTime: string; instType?: string; instCategory?: string; ruleType?: string; ctType?: string; ctVal?: string; ctMult?: string; ctValCcy?: string; settleCcy?: string };
export type Ticker = { instId: string; last: string; open24h: string; volCcy24h: string; bidPx: string; askPx: string; ts: string };
export type Book = { bids: string[][]; asks: string[][] };

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class OkxClient {
  private nextRequestAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private nextTickerAt = 0;

  private readonly contracts = new Map<string, Instrument>();
  constructor(private readonly config: Config, readonly market: Market = 'spot') {}

  private async slot() {
    const prior = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await prior;
    const delay = Math.max(0, this.nextRequestAt - Date.now());
    if (delay) await pause(delay);
    this.nextRequestAt = Date.now() + 300;
    release();
  }

  private async get<T>(path: string): Promise<T> {
    const url = new URL(`/api/v5/${path}`, this.config.OKX_REST_URL);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (path.startsWith('market/tickers?')) {
        const delay = Math.max(0, this.nextTickerAt - Date.now());
        if (delay) await pause(delay);
        this.nextTickerAt = Date.now() + 300;
      } else await this.slot();
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(path.startsWith('market/tickers?') ? 3500 : 12000) });
        if (!response.ok) throw new Error(`OKX HTTP ${response.status}`);
        const body = await response.json() as { code: string; msg?: string; data?: T };
        if (body.code !== '0' || !body.data) throw new Error(`OKX API ${body.code}: ${body.msg ?? '无数据'}`);
        return body.data;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await pause(1000 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async instruments() {
    const data = await this.get<Instrument[]>(`public/instruments?instType=${this.market === 'swap' ? 'SWAP' : 'SPOT'}`);
    if (this.market === 'spot') return data;
    const contracts = data.filter(i => marketSymbol('swap', i.instId) && i.instType === 'SWAP' && i.instCategory === '1' && i.ruleType === 'normal' && i.ctType === 'linear' &&
      i.settleCcy === 'USDT' && i.ctValCcy === i.instId.split('-')[0] && Number(i.ctMult) === 1 && Number.isFinite(Number(i.ctVal)) && Number(i.ctVal) > 0)
      .map(i => ({ ...i, baseCcy: i.instId.split('-')[0], quoteCcy: 'USDT' }));
    for (const instrument of contracts) this.contracts.set(instrument.instId, instrument);
    return contracts;
  }
  tickers() { return this.get<Ticker[]>(`market/tickers?instType=${this.market === 'swap' ? 'SWAP' : 'SPOT'}`); }
  async book(instId: string) {
    const data = await this.get<Book[]>(`market/books?instId=${encodeURIComponent(instId)}&sz=400`);
    if (!data[0]) throw new Error('OKX 盘口为空');
    if (this.market === 'spot') return data[0];
    const contract = this.contracts.get(instId);
    if (!contract) throw new Error('缺少永续合约面值，不能计算盘口深度');
    const convert = (rows: string[][]) => rows.map(row => [row[0], String(Number(row[1]) * Number(contract.ctVal)), ...row.slice(2)]);
    return { bids: convert(data[0].bids), asks: convert(data[0].asks) };
  }
  async candles(instId: string, limit = 100): Promise<Candle[]> {
    const data = await this.get<string[][]>(`market/candles?instId=${encodeURIComponent(instId)}&bar=5m&limit=${limit}`);
    return data.map(row => ({
      timestamp: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
      low: Number(row[3]), close: Number(row[4]), volume: Number(row[this.market === 'swap' ? 6 : 5]), confirmed: row[8] === '1'
    })).sort((a, b) => a.timestamp - b.timestamp);
  }

  async historyCandles(instId: string, count = 300, cutoff = Date.now()): Promise<Candle[]> {
    const rows = new Map<number, Candle>();
    let after = '';
    for (let page = 0; page < Math.ceil(count / 100) + 2 && rows.size < count; page++) {
      const data = await this.get<string[][]>(`market/history-candles?instId=${encodeURIComponent(instId)}&bar=5m&limit=100${after ? `&after=${after}` : ''}`);
      if (!data.length) break;
      const oldest = Math.min(...data.map(row => Number(row[0])));
      if (!Number.isFinite(oldest) || (after && oldest >= Number(after))) break;
      for (const row of data) {
        const candle = { timestamp: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[this.market === 'swap' ? 6 : 5]), confirmed: row[8] === '1' };
        if (candle.confirmed && candle.timestamp + 300_000 <= cutoff) rows.set(candle.timestamp, candle);
      }
      after = String(oldest);
    }
    return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-count);
  }
}
