import type { Config } from './config.js';
import type { Snapshot } from '../shared/types.js';

export class AiError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export class AiExplainer {
  private busy = false;
  private lastRequestAt = 0;
  constructor(private readonly config: Config, private readonly request: typeof fetch = fetch, private readonly timeoutMs = 20_000) {}

  status() { return { configured: Boolean(this.config.OPENAI_API_KEY && this.config.OPENAI_MODEL), model: this.config.OPENAI_MODEL || null }; }

  async explain(snapshot: Snapshot) {
    if (!this.status().configured) throw new AiError('AI 未配置。请在服务端配置中设置 OPENAI_API_KEY 和 OPENAI_MODEL，保存后重启；扫描与虚拟交易可继续使用。', 503);
    if (this.busy || Date.now() - this.lastRequestAt < 3000) throw new AiError('AI 请求正在处理或过于频繁，请稍后重试。', 429);
    if (snapshot.status !== 'live' || !snapshot.pairs.some(p => p.eligible)) throw new AiError('请等待实时合格行情后再请求解读。', 409);
    this.busy = true;
    this.lastRequestAt = Date.now();
    try {
      const base = (this.config.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
      const response = await this.request(`${base}/responses`, {
        method: 'POST', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: this.config.OPENAI_MODEL, store: false, max_output_tokens: 700,
          instructions: '你是中文技术指标解释器。只解释给定的公开行情、EMA9/EMA21/RSI14与筛选状态，用事实区分信号与不确定性，不作买卖推荐或收益保证，不调用工具，不决定交易，不改变风控。输出不超过400字。',
          input: JSON.stringify({ market: snapshot.market ?? 'spot', priceType: 'last', updatedAt: snapshot.updatedAt, timeframe: '5分钟已收盘K线',
            pairs: snapshot.pairs.filter(p => p.eligible).slice(0, 20).map(p => ({ symbol: p.symbol, price: p.price,
              change24h: p.change24h, signal: p.signal, ema9: p.ema9, ema21: p.ema21, rsi14: p.rsi14, candleAt: p.lastCandleAt })) }) })
      });
      if (!response.ok) throw new AiError(`AI 服务返回 HTTP ${response.status}，虚拟交易未受影响。`, 502);
      const data = await response.json() as { output?: { type?: string; content?: { type?: string; text?: string }[] }[] };
      const explanation = data.output?.flatMap(item => item.type === 'message' ? item.content ?? [] : [])
        .filter(item => item.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('\n').trim();
      if (!explanation) throw new AiError('AI 没有返回文本，虚拟交易未受影响。', 502);
      return { explanation: explanation.slice(0, 6000), model: this.config.OPENAI_MODEL, generatedAt: Date.now(), marketAt: snapshot.updatedAt };
    } catch (error) {
      if (error instanceof AiError) throw error;
      throw new AiError(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'AI 请求超时，虚拟交易未受影响。' : 'AI 连接失败，虚拟交易未受影响。', 502);
    } finally { this.busy = false; }
  }
}
