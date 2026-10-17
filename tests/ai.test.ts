import assert from 'node:assert/strict';
import test from 'node:test';
import { AiError, AiExplainer } from '../src/server/ai.js';
import { loadConfig } from '../src/server/config.js';
import type { Snapshot } from '../src/shared/types.js';

const snapshot = { status: 'live', updatedAt: Date.now(), pairs: [{ symbol: 'BTC-USDT', eligible: true, signal: 'LONG', price: 100, ema9: 101, ema21: 100, rsi14: 60 }], account: { balance: 10000 } } as Snapshot;
const config = () => loadConfig({ OPENAI_API_KEY: 'test-secret', OPENAI_MODEL: 'configured-test-model' });

test('AI 未配置不调用外部服务，错误不泄露密钥或原始服务内容', async () => {
  let calls = 0;
  const unavailable = new AiExplainer(loadConfig({}), (async () => { calls++; return new Response('{}'); }) as typeof fetch);
  await assert.rejects(unavailable.explain(snapshot), (e: unknown) => e instanceof AiError && e.statusCode === 503);
  assert.equal(calls, 0);
  const failing = new AiExplainer(config(), (async () => { throw new Error('test-secret'); }) as typeof fetch);
  await assert.rejects(failing.explain(snapshot), (e: unknown) => e instanceof AiError && !e.message.includes('test-secret'));
});

test('Responses 文本正确提取，仅发送公开行情，不发送账户或密钥到正文', async () => {
  let requestBody = '';
  const ai = new AiExplainer(config(), (async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    requestBody = String(init?.body);
    return new Response(JSON.stringify({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '指标偏多。' }] }] }), { status: 200 });
  }) as typeof fetch);
  const result = await ai.explain(snapshot);
  assert.equal(result.explanation, '指标偏多。');
  assert.ok(!requestBody.includes('balance') && !requestBody.includes('test-secret'));
  assert.equal(JSON.parse(requestBody).store, false);
  assert.deepEqual(ai.status(), { configured: true, model: 'configured-test-model' });
});

test('AI 限制并发并按超时退出；失败不会修改行情对象', async () => {
  const before = structuredClone(snapshot);
  const ai = new AiExplainer(config(), ((_, init) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response('{}')), 1000);
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason); });
  })) as typeof fetch, 30);
  const first = ai.explain(snapshot);
  await assert.rejects(ai.explain(snapshot), (e: unknown) => e instanceof AiError && e.statusCode === 429);
  await assert.rejects(first, /超时/);
  assert.deepEqual(snapshot, before);
});
