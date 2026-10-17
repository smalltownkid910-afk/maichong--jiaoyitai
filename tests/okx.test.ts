import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/server/config.js';
import { OkxClient } from '../src/server/okx.js';

test('OKX 临时故障后限速重试并恢复', async () => {
  let calls = 0;
  const server = createServer((_request, response) => {
    calls++;
    response.setHeader('Content-Type', 'application/json');
    if (calls < 3) { response.statusCode = 503; response.end('{}'); return; }
    response.end(JSON.stringify({ code: '0', data: [{ instId: 'BTC-USDT' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new OkxClient(loadConfig({ OKX_REST_URL: `http://127.0.0.1:${address.port}` }));
    const result = await client.tickers();
    assert.equal(calls, 3);
    assert.equal(result[0].instId, 'BTC-USDT');
  } finally { server.close(); }
});

test('历史 K 线按 after 向过去分页，去重并排除未收盘数据', async () => {
  const base = Date.UTC(2026, 0, 1);
  const candles = Array.from({ length: 205 }, (_, i) => [String(base + i * 300000), '100', '101', '99', '100', '1', '1', '100', i === 204 ? '0' : '1']).reverse();
  const cursors: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    assert.equal(url.pathname, '/api/v5/market/history-candles');
    assert.equal(url.searchParams.get('limit'), '100');
    const after = url.searchParams.get('after');
    cursors.push(after ?? '');
    const page = candles.filter(c => !after || Number(c[0]) < Number(after)).slice(0, 100);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ code: '0', data: page }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const client = new OkxClient(loadConfig({ OKX_REST_URL: `http://127.0.0.1:${address.port}` }));
    const result = await client.historyCandles('BTC-USDT', 200, base + 205 * 300000);
    assert.equal(result.length, 200); assert.equal(new Set(result.map(c => c.timestamp)).size, 200);
    assert.ok(result.every(c => c.confirmed)); assert.equal(result.at(-1)!.timestamp, base + 203 * 300000);
    assert.equal(cursors.length, 3); assert.ok(Number(cursors[2]) < Number(cursors[1]));
  } finally { server.close(); }
});
