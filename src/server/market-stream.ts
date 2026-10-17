import type { Ticker } from './okx.js';

export type StreamState = 'idle' | 'connecting' | 'connected' | 'reconnecting';
export type StreamTiming = { connectMs: number; idleMs: number; pongMs: number; heartbeatMs: number; retryMs: number; maxRetryMs: number };
const defaults: StreamTiming = { connectMs: 8000, idleMs: 10000, pongMs: 5000, heartbeatMs: 1000, retryMs: 1000, maxRetryMs: 30000 };

export class OkxTickerStream {
  state: StreamState = 'idle';
  lastMessageAt = 0;
  reconnects = 0;
  private wanted = new Set<string>();
  private subscribed = new Set<string>();
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private connectTimer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private stopped = true;
  private delay: number;
  private timing: StreamTiming;

  constructor(private readonly url: string, private readonly onTickers: (tickers: Ticker[]) => void,
    private readonly onState: () => void = () => {}, private readonly factory: (url: string) => WebSocket = url => new WebSocket(url), timing: Partial<StreamTiming> = {}) {
    this.timing = { ...defaults, ...timing };
    this.delay = this.timing.retryMs;
  }
  private change(state: StreamState) { this.state = state; this.onState(); }
  start(symbols: string[]) { if (!this.stopped) { this.setSymbols(symbols); return; } this.stopped = false; this.setSymbols(symbols); }
  setSymbols(symbols: string[]) {
    this.wanted = new Set(symbols.filter(symbol => /^[A-Z0-9]+-USDT(?:-SWAP)?$/.test(symbol)));
    if (this.stopped) return;
    if (!this.wanted.size) { this.clear(); this.change('idle'); return; }
    if (this.socket?.readyState === 1) this.subscribe();
    else if (!this.socket && !this.reconnectTimer) this.connect();
  }
  private subscribe() {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    for (const [op, symbols] of [['unsubscribe', [...this.subscribed].filter(s => !this.wanted.has(s))],
      ['subscribe', [...this.wanted].filter(s => !this.subscribed.has(s))]] as const) {
      if (symbols.length) socket.send(JSON.stringify({ op, args: symbols.map(instId => ({ channel: 'tickers', instId })) }));
    }
    this.subscribed = new Set(this.wanted);
  }
  private clear() {
    clearTimeout(this.reconnectTimer); clearTimeout(this.connectTimer); clearInterval(this.heartbeat);
    this.reconnectTimer = undefined; this.connectTimer = undefined; this.heartbeat = undefined;
    const socket = this.socket; this.socket = undefined; this.subscribed.clear();
    try { socket?.close(); } catch { /* Already closed. */ }
  }
  private failed(socket?: WebSocket) {
    if (socket && socket !== this.socket) return;
    this.clear();
    if (this.stopped || !this.wanted.size) return;
    this.reconnects++;
    this.change('reconnecting');
    const delay = this.delay + Math.floor(Math.random() * Math.min(this.delay / 4, 1000));
    this.delay = Math.min(this.delay * 2, this.timing.maxRetryMs);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect(); }, delay);
  }
  private connect() {
    if (this.stopped || this.socket || !this.wanted.size) return;
    this.change('connecting');
    let socket: WebSocket;
    try { socket = this.factory(this.url); } catch { this.failed(); return; }
    this.socket = socket;
    this.connectTimer = setTimeout(() => this.failed(socket), this.timing.connectMs);
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      clearTimeout(this.connectTimer); this.connectTimer = undefined;
      this.lastMessageAt = Date.now();
      this.change('connected'); this.subscribe();
      let pingAt = 0;
      this.heartbeat = setInterval(() => {
        const now = Date.now();
        if (pingAt && this.lastMessageAt > pingAt) pingAt = 0;
        if (pingAt && now - pingAt >= this.timing.pongMs) { this.failed(socket); return; }
        if (!pingAt && now - this.lastMessageAt >= this.timing.idleMs) {
          try { socket.send('ping'); pingAt = now; } catch { this.failed(socket); }
        }
      }, this.timing.heartbeatMs);
    };
    socket.onmessage = event => {
      if (this.socket !== socket || this.stopped || typeof event.data !== 'string') return;
      if (event.data === 'pong') { this.lastMessageAt = Date.now(); return; }
      try {
        const message = JSON.parse(event.data) as { event?: string; arg?: { channel?: string }; data?: Ticker[] };
        if (message.event === 'error') { this.failed(socket); return; }
        if (message.event || message.arg?.channel === 'tickers') this.lastMessageAt = Date.now();
        if (message.arg?.channel !== 'tickers' || !Array.isArray(message.data)) return;
        const tickers = message.data.filter(t => this.wanted.has(t.instId));
        if (tickers.length) { this.delay = this.timing.retryMs; this.onTickers(tickers); }
      } catch { /* Bad frames neither update quotes nor stop the application. */ }
    };
    socket.onerror = () => this.failed(socket);
    socket.onclose = () => this.failed(socket);
  }
  stop() { this.stopped = true; this.clear(); this.state = 'idle'; }
}
