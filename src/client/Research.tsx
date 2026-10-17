import React from 'react';
import { ArrowRight, Bot, FlaskConical, Pause, Play, SkipForward } from 'lucide-react';
import type { BacktestResult, Market, Metrics } from '../shared/types';
import { marketLabel, marketPath } from '../shared/markets';
import { calculateMetrics } from '../shared/trading';
import { PriceChart } from './Chart';

const num = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const date = (timestamp: number) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp));
const optional = (v: number | null | undefined, suffix = '') => v == null ? '不适用' : `${num.format(v)}${suffix}`;

export function MetricsStrip({ metrics, caption = '账户统计' }: { metrics?: Metrics; caption?: string }) {
  return <div className="metrics-strip" aria-label={caption}>
    <div><small>收益率</small><b>{optional(metrics?.returnPct, '%')}</b></div>
    <div><small>最大回撤</small><b>{optional(metrics?.maxDrawdownPct, '%')}</b></div>
    <div><small>胜率</small><b>{optional(metrics?.winRatePct, '%')}</b></div>
    <div><small>平均盈利 · 虚拟积分</small><b>{optional(metrics?.avgWin)}</b></div>
    <div><small>平均亏损 · 虚拟积分</small><b>{optional(metrics?.avgLoss)}</b></div>
    <div><small>Profit Factor</small><b>{optional(metrics?.profitFactor)}</b></div>
  </div>;
}

function EquityCurve({ values }: { values: number[] }) {
  const low = Math.min(10000, ...values), high = Math.max(10000, ...values), range = Math.max(high - low, 1);
  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${24 + i / Math.max(values.length - 1, 1) * 952} ${120 - (v - low) / range * 95}`).join(' ');
  return <div className="equity-chart"><div><small>独立账户权益曲线 · 虚拟积分</small><span>{num.format(low)} — {num.format(high)}</span></div><svg viewBox="0 0 1000 145" role="img" aria-label="回测权益曲线"><path d="M24 120H976 M24 72H976 M24 25H976" stroke="#26394d" fill="none" /><path d={path || 'M24 120'} stroke="#51d3a4" strokeWidth="3" fill="none" /></svg></div>;
}

export function ResearchPanel({ candidateCount, market }: { candidateCount: number; market: Market }) {
  const [result, setResult] = React.useState<BacktestResult | null>(null);
  const [bars, setBars] = React.useState(300);
  const [loading, setLoading] = React.useState('');
  const [error, setError] = React.useState('');
  const [step, setStep] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  React.useEffect(() => {
    if (!playing || !result) return;
    if (step >= result.frames.length - 1) { setPlaying(false); return; }
    const timer = setTimeout(() => setStep(step + 1), 250);
    return () => clearTimeout(timer);
  }, [playing, result, step]);
  const run = async (source: 'historical' | 'replay') => {
    setLoading(source); setError(''); setPlaying(false);
    try {
      const response = await fetch(marketPath('/api/backtest', market), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, bars }) });
      const data = await response.json() as BacktestResult & { error?: string };
      if (!response.ok) throw new Error(data.error ?? '回测失败');
      setResult(data); setStep(source === 'replay' ? 0 : data.frames.length - 1);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(''); }
  };
  const frame = result?.frames[step], replay = result?.source === 'replay';
  const visibleTrades = result?.trades.filter(t => !replay || t.closedAt <= (frame?.timestamp ?? 0)) ?? [];
  const visibleFrames = result?.frames.slice(0, replay ? step + 1 : undefined) ?? [];
  const metrics = result ? replay ? calculateMetrics(visibleTrades, 10000, frame?.equity ?? 10000, visibleFrames.map(f => f.equity)) : result.metrics : undefined;
  return <section className="panel research-panel">
    <div className="panel-heading"><div><span className="section-kicker">STRATEGY LAB</span><h2>{marketLabel(market)} · 历史回测与离线回放</h2><p>历史回测自动使用当前市场候选池；离线回放始终为独立合成样本。每次从 10,000 虚拟积分开始，实时账户不参与。</p></div><div className="heading-icon"><FlaskConical size={20} /></div></div>
    <div className="research-actions"><label>历史长度 <select aria-label="历史回测 K 线数量" value={bars} onChange={e => setBars(Number(e.target.value))}><option value={300}>300 根 / 约 25 小时</option><option value={600}>600 根 / 约 50 小时</option></select></label><button className="button button-primary" onClick={() => void run('historical')} disabled={!!loading || candidateCount === 0}>{loading === 'historical' ? '正在自动抓取历史…' : `回测当前 ${candidateCount} 个候选`}<ArrowRight size={15} /></button><button className="button button-ghost" onClick={() => void run('replay')} disabled={!!loading}>{loading === 'replay' ? '准备样本…' : '打开离线样本回放'}</button></div>
    {loading === 'historical' && <p className="research-note">正在分页抓取已收盘历史 K 线；多币种回测可能需要约一分钟。</p>}
    {error && <p className="research-error" role="alert">{error}</p>}
    {!result && <div className="research-empty"><FlaskConical size={28} /><p>先运行历史回测，或在无网络时打开固定合成样本，逐根查看独立账户的变化。</p></div>}
    {result && <div className="research-result">
      <div className="result-summary"><div><strong>{result.label}</strong><small>{result.symbols.join(' / ')} · {date(result.startAt)} — {date(replay ? frame?.timestamp ?? result.startAt : result.endAt)}（北京）</small></div><b>{num.format(replay ? frame?.equity ?? 10000 : result.finalEquity)}<small>虚拟积分</small></b></div>
      {replay && <div className="replay-controls"><button className="button button-small" onClick={() => { if (step === result.frames.length - 1) setStep(0); setPlaying(v => !v); }}>{playing ? <Pause size={13} /> : <Play size={13} />}{playing ? '暂停回放' : '播放样本'}</button><button className="button button-small" onClick={() => { setPlaying(false); setStep(v => Math.min(v + 1, result.frames.length - 1)); }} disabled={step === result.frames.length - 1}><SkipForward size={13} />下一根</button><input aria-label="离线回放进度" type="range" min={0} max={result.frames.length - 1} value={step} onChange={e => { setPlaying(false); setStep(Number(e.target.value)); }} /><span>{step + 1} / {result.frames.length} 根</span></div>}
      <MetricsStrip metrics={metrics} caption="独立回测账户统计" /><EquityCurve values={visibleFrames.map(f => f.equity)} />
      {replay && <div className="replay-detail"><div><h3>样本 BTC-USDT · 已回放 K 线</h3><PriceChart symbol="REPLAY-BTC" candles={result.candles?.['BTC-USDT'].filter(c => c.timestamp + 300000 <= (frame?.timestamp ?? 0)) ?? []} /></div><div><h3>样本持仓 {frame?.positions.length ?? 0} / 3</h3>{frame?.positions.map(p => <div className="sample-position" key={p.id}><strong>{p.symbol} · {p.side === 'LONG' ? '做多' : '做空'}</strong><span>入场 {num.format(p.entryPrice)} USDT · 数量 {p.quantity.toPrecision(4)}</span></div>)}{!frame?.positions.length && <p className="research-note">预热阶段或当前无持仓。</p>}</div></div>}
      <div className="backtest-trades"><h3>已完成 {visibleTrades.length} 笔独立{replay ? '回放' : '回测'}交易</h3><div className="table-scroll"><table><thead><tr><th>币种 / 方向</th><th>退出原因</th><th>净盈亏 · 虚拟积分</th><th>平仓时间（北京）</th></tr></thead><tbody>{visibleTrades.slice(-8).reverse().map(t => <tr key={t.id}><td>{t.symbol} / {t.side === 'LONG' ? '多' : '空'}</td><td>{t.exitReason === 'stop_loss' ? '止损' : t.exitReason === 'take_profit' ? '止盈' : t.exitReason === 'reverse_signal' ? '反向信号' : '窗口结束'}</td><td className={t.netPnl < 0 ? 'negative' : 'positive'}>{num.format(t.netPnl)}</td><td>{date(t.closedAt)}</td></tr>)}</tbody></table></div></div>
      <div className="research-warnings">{result.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</div>
    </div>}
  </section>;
}

export function AiPanel({ market }: { market: Market }) {
  const [configured, setConfigured] = React.useState(false), [model, setModel] = React.useState('');
  const [text, setText] = React.useState(''), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false);
  React.useEffect(() => { void fetch('/api/ai/status').then(r => r.json()).then(data => { setConfigured(data.configured); setModel(data.model ?? ''); }).catch(() => setError('AI 状态暂时不可用')); }, []);
  const explain = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch(marketPath('/api/ai/explain', market), { method: 'POST' }), result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '解读失败');
      setText(`${result.explanation}\n\n行情时间（北京）：${date(result.marketAt)} · 模型：${result.model}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <section className="panel ai-panel"><div className="panel-heading"><div><span className="section-kicker">OPTIONAL AI</span><h2><Bot size={20} /> 行情解读</h2><p>只解释公开候选指标；不决定交易。点击后调用配置的模型，可能产生 API 费用。</p></div><button className="button button-ghost" onClick={() => void explain()} disabled={!configured || busy}>{busy ? '正在解读…' : '请求 AI 解读'}</button></div><div className="ai-content">{!configured && <p>AI 尚未配置。在网页版后端 .env 或桌面版“软件 → 编辑配置”中设置 OPENAI_API_KEY 与 OPENAI_MODEL，保存后重启；无需在网页输入密钥。</p>}{configured && !text && <p>已配置 {model}，等待你请求解读。</p>}{text && <div className="ai-explanation">{text}</div>}{error && <p className="research-error" role="alert">{error}</p>}</div></section>;
}

export function RulesPanel() {
  const [rules, setRules] = React.useState<{ feeRate: number; slippageRate: number } | null>(null);
  React.useEffect(() => { void fetch('/api/rules').then(r => r.json()).then(setRules).catch(() => {}); }, []);
  return <p className="rules-line">模拟假设：止损 1% · 止盈 2% · 计划价格盈亏比 2:1（未扣费用）{rules && ` · 单边手续费 ${num.format(rules.feeRate * 100)}% · 不利滑点 ${num.format(rules.slippageRate * 100)}%`}。实时最大回撤按新鲜行情采样，历史回撤按每根收盘权益估算；均可能漏过两次采样之间的低点。</p>;
}
