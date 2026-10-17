import Fastify, { type FastifyRequest } from 'fastify';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, type Config } from './config.js';
import { openDatabase } from './db.js';
import { OkxClient } from './okx.js';
import { Scanner } from './scanner.js';
import { Broker } from './broker.js';
import { z } from 'zod';
import { replaySamples, runBacktest } from './backtest.js';
import { AiError, AiExplainer } from './ai.js';
import type { Candle } from '../shared/types.js';
import { RISK } from '../shared/trading.js';
import type { Market } from '../shared/types.js';
import { marketLabel, marketSymbol } from '../shared/markets.js';
import { marketDatabasePath } from './markets.js';
export { loadConfig } from './config.js';

export async function startServer({ config = loadConfig(), clientDir = resolve('dist/client'), logger = true }: { config?: Config; clientDir?: string; logger?: boolean } = {}) {
const app = Fastify({ logger, forceCloseConnections: true });
const createMarket = (market: Market) => {
  const db = openDatabase(marketDatabasePath(config.DATABASE_PATH, market));
  const okx = new OkxClient(config, market);
  const scanner = new Scanner(okx, db, app.log, config, 30000, true, market);
  const broker = new Broker(db, scanner, config);
  return { market, db, okx, scanner, broker, backtestBusy: false };
};
const markets = { spot: createMarket('spot'), swap: createMarket('swap') };
const { db, scanner } = markets.spot;
const engine = (request: FastifyRequest) => markets[(request.query as { market?: Market }).market ?? 'spot'];
const snapshot = (runtime: typeof markets.spot) => ({ ...runtime.scanner.snapshot(), market: runtime.market, priceType: 'last' as const });
const ai = new AiExplainer(config);
app.addHook('preValidation', async (request, reply) => {
  if (!request.url.startsWith('/api/') && !request.url.startsWith('/ws')) return;
  if (!z.object({ market: z.enum(['spot', 'swap']).optional() }).safeParse(request.query).success) {
    return reply.code(400).send({ error: 'market 须为 spot（现货）或 swap（USDT 永续）' });
  }
});
await app.register(websocket);
app.get('/api/health', async () => ({ ok: true, database: db.prepare('SELECT 1 AS ok').get(), markets: ['spot', 'swap'] }));
app.get('/api/rules', async () => ({ ...RISK, feeRate: config.SIM_FEE_RATE, slippageRate: config.SIM_SLIPPAGE_RATE }));
app.get('/api/snapshot', async request => snapshot(engine(request)));
app.get('/api/account', async request => engine(request).broker.account());
app.get('/api/ai/status', async () => ai.status());
app.post('/api/ai/explain', async (request, reply) => {
  const runtime = engine(request);
  try { return { ...await ai.explain(snapshot(runtime)), market: runtime.market }; }
  catch (error) { return reply.code(error instanceof AiError ? error.statusCode : 500).send({ error: error instanceof AiError ? error.message : 'AI 解读暂时不可用' }); }
});
app.post('/api/backtest', async (request, reply) => {
  const { okx, scanner } = engine(request);
  const runtime = engine(request);
  const parsed = z.object({ source: z.enum(['historical', 'replay']), bars: z.union([z.literal(300), z.literal(600)]).default(300) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'source 须为 historical 或 replay；bars 须为 300 或 600' });
  const rates = { feeRate: config.SIM_FEE_RATE, slippageRate: config.SIM_SLIPPAGE_RATE, maxMovePct: config.SCREEN_MAX_5M_MOVE_PCT };
  if (parsed.data.source === 'replay') {
    const candles = replaySamples();
    return { ...runBacktest(candles, { ...rates, source: 'replay' }), candles, market: 'sample' };
  }
  if (runtime.backtestBusy) return reply.code(429).send({ error: '当前市场已有历史回测在运行，请稍后重试' });
  const symbols = scanner.getSelected().filter(p => p.eligible).map(p => p.symbol);
  if (!symbols.length) return reply.code(409).send({ error: '暂无当前合格候选；可先运行独立离线回放' });
  runtime.backtestBusy = true;
  try {
    const data: Record<string, Candle[]> = {};
    const warnings: string[] = runtime.market === 'swap' ? ['永续使用最新成交价 K 线与基础币等值数量进行无杠杆模拟，未模拟资金费、保证金和强平。'] : [];
    const cutoff = Date.now();
    for (let i = 0; i < symbols.length; i += 4) {
      await Promise.all(symbols.slice(i, i + 4).map(async symbol => {
        try { data[symbol] = await okx.historyCandles(symbol, parsed.data.bars, cutoff); }
        catch { warnings.push(`${symbol} 历史抓取失败，未纳入本次回测。`); }
      }));
    }
    const result = runBacktest(data, { ...rates, source: 'historical', warnings });
    return { ...result, market: runtime.market, label: `${marketLabel(runtime.market)} · ${result.label}` };
  } catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : '历史回测失败' }); }
  finally { runtime.backtestBusy = false; }
});
app.get('/api/pairs', async request => engine(request).scanner.snapshot().pairs);
app.get<{ Params: { symbol: string } }>('/api/candles/:symbol', async (request, reply) => {
  const { scanner } = engine(request);
  const symbol = request.params.symbol;
  if (!scanner.getSelected().some(pair => pair.symbol === symbol)) return reply.code(404).send({ error: '交易对不在候选池' });
  return scanner.getCandles(symbol);
});
app.post('/api/auto', async (request, reply) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'enabled 必须为布尔值' });
  return engine(request).broker.setAutoTrading(parsed.data.enabled);
});
app.post('/api/trades/open', async (request, reply) => {
  const runtime = engine(request);
  const parsed = z.object({ symbol: z.string(), side: z.enum(['LONG', 'SHORT']) }).safeParse(request.body);
  if (!parsed.success || !marketSymbol(runtime.market, parsed.data.symbol)) return reply.code(400).send({ error: 'symbol 与当前市场不符或 side 无效' });
  const result = runtime.broker.open(parsed.data.symbol, parsed.data.side);
  return result.ok ? result : reply.code(409).send(result);
});
app.post<{ Params: { id: string } }>('/api/trades/:id/close', async (request, reply) => {
  const parsed = z.coerce.number().int().positive().safeParse(request.params.id);
  if (!parsed.success) return reply.code(400).send({ error: '持仓 ID 无效' });
  const result = engine(request).broker.close(parsed.data);
  return result.ok ? result : reply.code(409).send(result);
});
app.post('/api/account/reset', async (request, reply) => {
  const parsed = z.object({ confirm: z.literal(true) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: '重置需要明确确认' });
  return engine(request).broker.reset();
});
app.get('/api/trades.csv', async (request, reply) => {
  const runtime = engine(request);
  const rows = runtime.broker.account().trades;
  const header = 'symbol,side,quantity,entryPrice,exitPrice,entryFee,exitFee,grossPnl,netPnl,openedAt,closedAt,exitReason';
  const csv = [header, ...rows.map(trade => [trade.symbol, trade.side, trade.quantity, trade.entryPrice, trade.exitPrice,
    trade.entryFee, trade.exitFee, trade.grossPnl, trade.netPnl, new Date(trade.openedAt).toISOString(),
    new Date(trade.closedAt).toISOString(), trade.exitReason].join(','))].join('\r\n');
  return reply.header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="virtual-trades-${runtime.market}.csv"`).send(`\uFEFF${csv}`);
});
app.get('/ws', { websocket: true }, (socket, request) => {
  const runtime = engine(request);
  const unsubscribe = runtime.scanner.subscribe((value, full) => {
    const snapshot = { ...value, market: runtime.market, priceType: 'last' };
    if (socket.readyState !== 1) return;
    if (full) socket.send(JSON.stringify(snapshot));
    else { const { candles: _candles, ...market } = snapshot; socket.send(JSON.stringify({ ...market, type: 'market' })); }
  });
  socket.on('close', unsubscribe);
});
if (existsSync(clientDir)) {
  await app.register(staticPlugin, { root: clientDir, prefix: '/' });
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'));
}
try { await app.listen({ host: config.HOST, port: config.PORT }); }
catch (error) { await app.close(); for (const runtime of Object.values(markets)) runtime.db.close(); throw error; }
for (const runtime of Object.values(markets)) runtime.scanner.start();
const address = app.server.address();
if (!address || typeof address === 'string') throw new Error('本地服务地址不可用');
let closing = false;
return { app, scanner, db, markets, url: `http://127.0.0.1:${address.port}`, async close() {
  if (closing) return;
  closing = true;
  for (const runtime of Object.values(markets)) runtime.scanner.stop();
  for (const socket of app.websocketServer.clients) socket.terminate();
  for (const runtime of Object.values(markets)) runtime.broker.flushMetrics();
  await app.close();
  for (const runtime of Object.values(markets)) runtime.db.close();
} };
}
