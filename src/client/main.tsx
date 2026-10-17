import React from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDownRight, ArrowRight, ArrowUpRight, BarChart3, Check, ChevronDown, Clock3, Download, Pause, Play, Radio, RotateCcw, ShieldCheck, SlidersHorizontal, WifiOff, X } from 'lucide-react';
import type { Market, PairView, Side, Snapshot } from '../shared/types';
import { marketLabel, marketPath } from '../shared/markets';
import { PriceChart } from './Chart';
import { AiPanel, MetricsStrip, ResearchPanel, RulesPanel } from './Research';
import './style.css';

type Connection = 'connecting' | 'streaming' | 'polling' | 'offline';
type Notice = { kind: 'success' | 'error'; message: string };
const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const signed = (v?: number | null) => v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${number.format(v)}`;
const fmtPrice = (v?: number | null) => v == null || !Number.isFinite(v) ? '—' : v >= 1 ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(v) : new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 6 }).format(v);
const fmtTime = (v?: number | null) => v ? clock.format(new Date(v)) : '—';
const quoteClock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false });
const quoteTime = (v?: number | null) => v ? quoteClock.format(new Date(v)) : '—';
const quoteAge = (v: number | null | undefined, now: number) => v ? `${Math.max(0, now - v) / 1000 < 15 ? (Math.max(0, now - v) / 1000).toFixed(1) + '秒前' : '报价过期'}` : '暂无报价';
const fmtPercent = (v?: number | null) => v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const signalName = (s: PairView['signal']) => s === 'LONG' ? '看多' : s === 'SHORT' ? '看空' : '观望';

async function postJson(path: string, body: object) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json() as { ok?: boolean; message?: string; error?: string };
  if (!response.ok || result.ok === false) throw new Error(result.message ?? result.error ?? `请求失败（${response.status}）`);
  return result;
}

function App() {
  const [market, setMarket] = React.useState<Market>(() => {
    const fromUrl = new URLSearchParams(location.search).get('market');
    if (fromUrl === 'spot' || fromUrl === 'swap') return fromUrl;
    try { return localStorage.getItem('pulse.market') === 'swap' ? 'swap' : 'spot'; } catch { return 'spot'; }
  });
  const changeMarket = (next: Market) => {
    try { localStorage.setItem('pulse.market', next); } catch { /* Selection still works without storage. */ }
    const url = new URL(location.href); url.searchParams.set('market', next);
    history.replaceState(null, '', url);
    setMarket(next);
  };
  return <MarketDashboard key={market} market={market} onMarketChange={changeMarket} />;
}

function MarketDashboard({ market, onMarketChange }: { market: Market; onMarketChange: (market: Market) => void }) {
  const label = marketLabel(market);
  const api = React.useCallback((path: string) => marketPath(path, market), [market]);
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);
  const [connection, setConnection] = React.useState<Connection>('connecting');
  const [receivedAt, setReceivedAt] = React.useState(0);
  const [now, setNow] = React.useState(Date.now());
  const [selected, setSelected] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [signalFilter, setSignalFilter] = React.useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
  const [showAllExcluded, setShowAllExcluded] = React.useState(false);
  const [busy, setBusy] = React.useState('');
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [resetOpen, setResetOpen] = React.useState(false);

  const refresh = React.useCallback(async () => {
    const response = await fetch(api('/api/snapshot'), { cache: 'no-store' });
    if (!response.ok) throw new Error(`服务返回 ${response.status}`);
    const value = await response.json() as Snapshot;
    if (value.market !== market) throw new Error('服务返回了不同市场，请重启至最新软件');
    setSnapshot(value);
    setReceivedAt(Date.now());
    setNow(Date.now());
    return value;
  }, [api, market]);

  React.useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try { await refresh(); if (active && socket?.readyState !== WebSocket.OPEN) setConnection('polling'); }
      catch { if (active && socket?.readyState !== WebSocket.OPEN) setConnection('offline'); }
    };
    const connect = () => {
      if (!active) return;
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${api('/ws')}`);
      socket.onopen = () => { if (active) setConnection('streaming'); };
      socket.onmessage = event => {
        if (!active) return;
        try {
          const update = JSON.parse(event.data) as Snapshot & { type?: string };
          if (update.market !== market) return;
          setSnapshot(previous => update.type === 'market' && previous ? { ...update, candles: previous.candles } : update);
          setReceivedAt(Date.now());
          setNow(Date.now());
        }
        catch { /* Polling recovers from a malformed frame. */ }
      };
      socket.onclose = () => { if (active) { setConnection('polling'); reconnect = setTimeout(connect, 3000); } };
      socket.onerror = () => socket?.close();
    };
    void load(); connect();
    const poll = setInterval(() => void load(), 10_000);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { active = false; clearInterval(poll); clearInterval(timer); if (reconnect) clearTimeout(reconnect); socket?.close(); };
  }, [refresh, api, market]);

  React.useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const accepted = snapshot?.pairs.filter(p => p.eligible) ?? [];
  const rejected = snapshot?.pairs.filter(p => !p.eligible) ?? [];
  React.useEffect(() => {
    if (accepted.length && !accepted.some(p => p.symbol === selected)) setSelected(accepted.find(p => p.symbol === (market === 'swap' ? 'BTC-USDT-SWAP' : 'BTC-USDT'))?.symbol ?? accepted[0].symbol);
  }, [snapshot, selected]);
  const current = accepted.find(p => p.symbol === selected) ?? accepted[0];
  const visible = accepted.filter(p => p.symbol.toLowerCase().includes(query.trim().toLowerCase()) && (signalFilter === 'ALL' || p.signal === signalFilter));
  const account = snapshot?.account;
  const transportStale = receivedAt > 0 && now - receivedAt > 20_000;
  const quoteStale = snapshot?.status === 'live' && snapshot.updatedAt != null && now - snapshot.updatedAt > 15_000;
  const canTrade = snapshot?.status === 'live' && connection !== 'offline' && !transportStale && !quoteStale;
  const status = transportStale || connection === 'offline' ? 'offline' : quoteStale ? 'stale' : snapshot?.status ?? 'loading';
  const statusLabel = status === 'live' ? '实时扫描中' : status === 'stale' ? '行情延迟' : status === 'error' ? '连接异常' : status === 'offline' ? '本地连接中断' : '正在连接';

  const act = async (key: string, path: string, body: object, fallback: string) => {
    if (busy) return;
    setBusy(key);
    try { const result = await postJson(api(path), body); await refresh(); setNotice({ kind: 'success', message: result.message ?? fallback }); }
    catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(''); }
  };
  const open = (symbol: string, side: Side) => void act(`open-${symbol}-${side}`, '/api/trades/open', { symbol, side }, `${symbol} 虚拟入场已记录`);
  const close = (id: number) => void act(`close-${id}`, `/api/trades/${id}/close`, {}, '虚拟平仓已记录');
  const toggleAuto = () => void act('auto', '/api/auto', { enabled: !account?.autoTrading }, account?.autoTrading ? '已停止自动入场' : '已开启自动入场');
  const reset = async () => { await act('reset', '/api/account/reset', { confirm: true }, '虚拟账户已重置'); setResetOpen(false); };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-icon"><Activity size={21} strokeWidth={2.4} /></div><div><strong>脉冲 <span>Pulse</span></strong><small>OKX 虚拟交易观察台</small></div></div>
      <div className="top-right"><span className="top-clock">北京时间 {clock.format(new Date(now))}</span><span className={`status-pill ${status}`}><span className="status-dot" />{statusLabel}</span></div>
    </header>
    <main className="dashboard"><section className="market-mode-bar" aria-label="交易市场"><div className="market-mode-copy"><strong>{label}观察台</strong><span>两个市场独立账户，切换后各自后台仍持续扫描和管理持仓。</span></div><div className="market-mode-buttons" role="group" aria-label="切换交易市场"><button aria-pressed={market === 'spot'} onClick={() => onMarketChange('spot')} disabled={!!busy}>现货</button><button aria-pressed={market === 'swap'} onClick={() => onMarketChange('swap')} disabled={!!busy}>USDT 永续</button></div></section>{market === 'swap' && <p className="market-model-note">USDT 线性永续 · 最新成交价（last）。无杠杆虚拟积分模拟，数量为基础币等值；未模拟资金费、保证金与强平。与欧意比较时请使用同一 USDT 永续合约的最新价。</p>}
      <section className="hero">
        <div className="hero-copy"><div className="eyebrow"><Radio size={14} /> 真实行情 · 虚拟交易</div><h1>一个页面，掌握所有候选币种。</h1><p>自动发现并筛选 OKX {label}，追踪已收盘 K 线信号与虚拟账户。币种详情选择不会改变后台扫描。</p><div className="hero-meta"><span><span className="meta-dot" />{snapshot?.statusMessage ?? '正在连接 OKX'}</span><span>最近行情 {quoteTime(snapshot?.updatedAt)}</span><span>{snapshot?.feed?.mode === 'websocket' ? 'OKX 实时推送' : `轮询兜底 ${Math.round((snapshot?.feed?.pollMs ?? 1000) / 1000)}秒 · 推送${snapshot?.feed?.state === 'disabled' ? '未启用' : snapshot?.feed?.state === 'connected' ? '已连接' : '连接恢复中'}`}</span><span>候选 {accepted.length} / 上限 20</span></div></div>
        <div className="hero-orbit" aria-hidden="true"><div className="orbit-ring outer" /><div className="orbit-ring inner" /><span className="orbit-core"><Activity size={32} /></span><i className="orbit-node node-a" /><i className="orbit-node node-b" /><i className="orbit-node node-c" /></div>
      </section>
      {(status === 'error' || status === 'stale' || status === 'offline') && <div className="alert error-alert"><WifiOff size={18} /><div><strong>{statusLabel}，暂停新的虚拟入场</strong><span>{snapshot?.error ?? (status === 'offline' ? '本地服务暂时无法连接；页面会自动重试。' : '等待新鲜报价，旧持仓将在行情恢复后继续管理。')}</span></div></div>}
      {notice && <div className={`toast ${notice.kind}`} role="status">{notice.kind === 'success' ? <Check size={18} /> : <X size={18} />}{notice.message}<button onClick={() => setNotice(null)} aria-label="关闭通知"><X size={15} /></button></div>}

      <section className="stat-grid" aria-label="虚拟账户概况">
        <div className="stat-card primary"><span className="stat-label">{label}账户权益 <small>虚拟积分</small></span><strong>{account ? number.format(account.equity) : '—'}</strong><div className="stat-foot">初始 10,000 虚拟积分 <ArrowRight size={14} /></div></div>
        <div className="stat-card"><span className="stat-label">已实现盈亏 <small>虚拟积分</small></span><strong className={account && account.realizedPnl < 0 ? 'negative' : 'positive'}>{signed(account?.realizedPnl)}</strong><div className="stat-foot">已平仓交易累计</div></div>
        <div className="stat-card"><span className="stat-label">浮动盈亏 <small>虚拟积分</small></span><strong className={account && account.unrealizedPnl < 0 ? 'negative' : 'positive'}>{signed(account?.unrealizedPnl)}</strong><div className="stat-foot">按新鲜参考价估算</div></div>
        <div className="stat-card"><span className="stat-label">当前持仓 <small>最多 3 个</small></span><strong>{account?.positions.length ?? '—'}<em> / 3</em></strong><div className="stat-foot">自动入场 {account?.autoTrading ? '已开启' : '已关闭'}</div></div>
      </section>

      <section className="control-panel"><div className="control-copy"><span className="section-kicker">交易控制</span><h2>{label}虚拟账户</h2><p>自动扫描持续运行。自动入场默认关闭；关闭后已有持仓仍会管理止盈止损。</p></div><div className="control-actions"><button className={`button ${account?.autoTrading ? 'button-stop' : 'button-primary'}`} onClick={toggleAuto} disabled={!account || !!busy || (!account.autoTrading && !canTrade)}>{account?.autoTrading ? <Pause size={16} /> : <Play size={16} />}{busy === 'auto' ? '处理中…' : account?.autoTrading ? '停止自动入场' : '开启自动入场'}</button><a className="button button-ghost" href={api('/api/trades.csv')} download><Download size={16} />导出交易 CSV</a><button className="button button-ghost reset-button" onClick={() => setResetOpen(true)} disabled={!account || !!busy}><RotateCcw size={16} />重置账户</button></div></section>

      <MetricsStrip metrics={account?.metrics} />
      {account?.valuationStale && <p className="research-error">部分持仓缺少新鲜报价：当前权益与浮动盈亏暂用入场价估算；收益率待更新，回撤只采用此前新鲜行情样本。</p>}
      <RulesPanel />
      <div className="workspace-grid">
        <section className="panel market-panel"><div className="panel-heading"><div><span className="section-kicker">MARKET SCANNER</span><h2>自动筛选结果 <span className="count-badge">{accepted.length}</span></h2><p>{market === 'swap' ? '按基础币成交量 × 最新价估算 USDT 成交额排序；合约张数已换算为基础币深度。' : '按 24 小时 USDT 成交额排序；符合条件的热门币种自动加入。'}</p></div><div className="heading-icon"><SlidersHorizontal size={20} /></div></div><div className="table-tools"><div className="search-field"><span>⌕</span><input aria-label="搜索候选币种" placeholder="搜索币种，例如 BTC、ETH" value={query} onChange={e => setQuery(e.target.value)} /></div><div className="segmented" aria-label="信号筛选"><button className={signalFilter === 'ALL' ? 'active' : ''} onClick={() => setSignalFilter('ALL')}>全部</button><button className={signalFilter === 'LONG' ? 'active' : ''} onClick={() => setSignalFilter('LONG')}>看多</button><button className={signalFilter === 'SHORT' ? 'active' : ''} onClick={() => setSignalFilter('SHORT')}>看空</button></div></div><div className="table-scroll"><table className="market-table"><thead><tr><th>交易对</th><th>{label}最新价 · USDT</th><th>24h 涨跌</th><th>24h 成交额{market === 'swap' ? '（估算）' : ''}</th><th>信号</th><th>操作</th></tr></thead><tbody>{visible.map(pair => <tr key={pair.symbol} className={current?.symbol === pair.symbol ? 'selected-row' : ''} onClick={() => setSelected(pair.symbol)}><td><span className="coin-icon">{pair.symbol[0]}</span><span className="coin-name"><strong>{pair.symbol.split('-')[0]}</strong><small>/ USDT {market === 'swap' ? '永续' : '现货'}</small></span></td><td className="number-cell">{fmtPrice(pair.price)}<small className={now - (pair.updatedAt ?? 0) > 15000 ? 'quote-stamp negative' : 'quote-stamp'}>{quoteTime(pair.updatedAt)} · {quoteAge(pair.updatedAt, now)} · {pair.quoteSource === 'websocket' ? '推送' : '轮询'}</small></td><td className={pair.change24h != null && pair.change24h < 0 ? 'negative' : 'positive'}>{fmtPercent(pair.change24h)}</td><td className="muted-cell">{pair.quoteVolume24h == null ? '—' : compact.format(pair.quoteVolume24h)}</td><td><span className={`signal-pill ${pair.signal.toLowerCase()}`}>{signalName(pair.signal)}</span></td><td><div className="row-actions"><button title={`${pair.symbol} 虚拟做多`} aria-label={`${pair.symbol} 虚拟做多`} onClick={e => { e.stopPropagation(); open(pair.symbol, 'LONG'); }} disabled={!canTrade || !!busy || now - (pair.updatedAt ?? 0) > 15000}>多</button><button title={`${pair.symbol} 虚拟做空`} aria-label={`${pair.symbol} 虚拟做空`} onClick={e => { e.stopPropagation(); open(pair.symbol, 'SHORT'); }} disabled={!canTrade || !!busy || now - (pair.updatedAt ?? 0) > 15000}>空</button></div></td></tr>)}</tbody></table>{!snapshot && <div className="empty-state">正在自动抓取交易对与行情…</div>}{snapshot && visible.length === 0 && <div className="empty-state">{accepted.length === 0 ? '暂无通过筛选的币种，请查看连接状态与排除原因。' : '没有符合当前搜索或信号筛选的币种。'}</div>}</div><div className="panel-footer"><ShieldCheck size={15} /> 筛选仅依据交易状态、流动性与数据质量，不代表对项目信誉的保证。</div></section>
        <section className="panel detail-panel"><div className="panel-heading detail-heading"><div><span className="section-kicker">PAIR DETAIL</span><h2>{current?.symbol ?? '币种详情'} <ChevronDown size={16} /></h2><p>{label} · 最新成交价 · 5 分钟已收盘 K 线</p></div><span className={`signal-pill large ${current?.signal.toLowerCase() ?? 'wait'}`}>{current ? signalName(current.signal) : '等待行情'}</span></div><div className="detail-price"><strong>{fmtPrice(current?.price)}</strong><span>USDT</span><em className={current?.change24h != null && current.change24h < 0 ? 'negative' : 'positive'}>{fmtPercent(current?.change24h)}</em></div><p className="detail-quote-time">{label}最新成交价 · 交易所时间（北京）{quoteTime(current?.updatedAt)} · {quoteAge(current?.updatedAt, now)} · {current?.quoteSource === 'websocket' ? 'WebSocket 推送' : 'REST 轮询'}。图表仍使用已收盘 5 分钟 K 线。</p><div className="chart-legend"><span><i className="legend-candle" /> K 线</span><span><i className="legend-fast" /> EMA 9</span><span><i className="legend-slow" /> EMA 21</span></div><PriceChart candles={current ? snapshot?.candles[current.symbol] ?? [] : []} symbol={current?.symbol ?? ''} /><div className="indicator-grid"><div><small>EMA 9</small><strong>{fmtPrice(current?.ema9)}</strong></div><div><small>EMA 21</small><strong>{fmtPrice(current?.ema21)}</strong></div><div><small>RSI 14</small><strong>{current?.rsi14?.toFixed(1) ?? '—'}</strong></div></div><div className="detail-foot"><Clock3 size={14} /> 最新已收盘 K 线：{fmtTime(current?.lastCandleAt)}</div></section>
      </div>

      <div className="lower-grid"><section className="panel"><div className="panel-heading"><div><span className="section-kicker">OPEN POSITIONS</span><h2>当前虚拟持仓 <span className="count-badge">{account?.positions.length ?? 0}</span></h2></div><div className="heading-icon"><BarChart3 size={20} /></div></div>{account?.positions.length ? <div className="position-list">{account.positions.map(position => <div className="position-card" key={position.id}><div className="position-top"><div><span className={`side-mark ${position.side.toLowerCase()}`}>{position.side === 'LONG' ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}{position.side === 'LONG' ? '做多' : '做空'}</span><strong>{position.symbol}</strong></div><button className="button button-small" onClick={() => close(position.id)} disabled={!canTrade || !!busy}>{busy === `close-${position.id}` ? '处理中…' : '按当前报价平仓'}</button></div><div className="position-values"><div><small>入场价 · USDT</small><b>{fmtPrice(position.entryPrice)}</b></div><div><small>止损价 · USDT</small><b>{fmtPrice(position.stopLoss)}</b></div><div><small>止盈价 · USDT</small><b>{fmtPrice(position.takeProfit)}</b></div><div><small>数量 · 基础币等值</small><b>{number.format(position.quantity)}</b></div></div><div className="position-date">开仓时间（北京）{fmtTime(position.openedAt)}</div></div>)}</div> : <div className="empty-state spacious">暂无虚拟持仓。可等待自动信号，也可从候选列表手动模拟入场。</div>}</section><section className="panel"><div className="panel-heading"><div><span className="section-kicker">TRADE HISTORY</span><h2>已完成交易 <span className="count-badge">{account?.trades.length ?? 0}</span></h2></div><a className="text-link" href={api('/api/trades.csv')} download>导出全部 <ArrowRight size={14} /></a></div>{account?.trades.length ? <div className="history-list">{account.trades.slice(0, 8).map(trade => <div className="history-row" key={trade.id}><div><strong>{trade.symbol}</strong><small>{trade.side === 'LONG' ? '做多' : '做空'} · {trade.exitReason === 'stop_loss' ? '止损' : trade.exitReason === 'take_profit' ? '止盈' : trade.exitReason === 'reverse_signal' ? '反向信号' : '手动平仓'} · {fmtTime(trade.closedAt)}</small></div><span className={trade.netPnl < 0 ? 'negative' : 'positive'}>{signed(trade.netPnl)}<small>虚拟积分</small></span></div>)}</div> : <div className="empty-state spacious">尚无已完成的虚拟交易。平仓后可在此查看净盈亏。</div>}</section></div>

      <section className="panel excluded-panel"><div className="panel-heading"><div><span className="section-kicker">SCREENING TRANSPARENCY</span><h2>未通过筛选 <span className="count-badge">{rejected.length}</span></h2><p>展示当前扫描返回的部分排除原因；筛选阈值可在本地配置中调整。</p></div><button className="text-link" onClick={() => setShowAllExcluded(v => !v)}>{showAllExcluded ? '收起' : '展开更多'} <ChevronDown size={15} className={showAllExcluded ? 'rotate' : ''} /></button></div><div className="excluded-list">{rejected.slice(0, showAllExcluded ? rejected.length : 6).map(pair => <div className="excluded-item" key={pair.symbol}><strong>{pair.symbol}</strong><span>{pair.reasons.join(' · ') || '数据不足'}</span><small>{pair.quoteVolume24h == null ? '—' : `${compact.format(pair.quoteVolume24h)} USDT / 24h`}</small></div>)}{rejected.length === 0 && <div className="empty-state">暂无排除记录；等待首次自动扫描完成。</div>}</div></section>
      <ResearchPanel market={market} candidateCount={accepted.length} />
      <AiPanel market={market} />
      <footer className="site-footer"><div><ShieldCheck size={18} /><span>仅供演示 · 所有交易与账户金额均为虚拟积分，不连接交易账户或提交真实订单。</span></div><span>报价与信号基于 OKX 公共行情 · 北京时间显示</span></footer>
    </main>

    {resetOpen && <div className="modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setResetOpen(false); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="reset-title"><div className="modal-icon"><RotateCcw size={23} /></div><h2 id="reset-title">重置{label}虚拟账户？</h2><p>这只会清空当前{label}账户的虚拟持仓与交易记录，将余额恢复为 10,000 虚拟积分，并关闭自动入场。另一市场的账户保持独立，两个市场的行情扫描都会继续运行。</p><div className="modal-actions"><button className="button button-ghost" onClick={() => setResetOpen(false)} disabled={!!busy}>取消</button><button className="button button-danger" onClick={() => void reset()} disabled={!!busy}>{busy === 'reset' ? '重置中…' : '确认重置'}</button></div></div></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);


