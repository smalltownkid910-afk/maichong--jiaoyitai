import React from 'react';
import { CandlestickSeries, createChart, LineSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { EMA } from 'technicalindicators';
import type { Candle } from '../shared/types';

export function PriceChart({ candles, symbol }: { candles: Candle[]; symbol: string }) {
  const container = React.useRef<HTMLDivElement>(null);
  const chart = React.useRef<IChartApi | null>(null);
  const bars = React.useRef<ISeriesApi<'Candlestick'> | null>(null);
  const fast = React.useRef<ISeriesApi<'Line'> | null>(null);
  const slow = React.useRef<ISeriesApi<'Line'> | null>(null);

  React.useEffect(() => {
    if (!container.current) return;
    const instance = createChart(container.current, {
      autoSize: true,
      layout: { background: { color: '#101b2a' }, textColor: '#8293aa', fontFamily: 'Inter, Microsoft YaHei, sans-serif', fontSize: 11 },
      grid: { vertLines: { color: '#1a2a3c' }, horzLines: { color: '#1a2a3c' } },
      rightPriceScale: { borderColor: '#26384c' },
      timeScale: { borderColor: '#26384c', timeVisible: true, secondsVisible: false,
        tickMarkFormatter: (timestamp: unknown) => typeof timestamp === 'number' ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp * 1000)) : null },
      localization: { timeFormatter: (timestamp: number) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp * 1000)) }
    });
    chart.current = instance;
    bars.current = instance.addSeries(CandlestickSeries, { upColor: '#42c99a', downColor: '#ef7474', borderVisible: false, wickUpColor: '#42c99a', wickDownColor: '#ef7474', priceLineVisible: false });
    fast.current = instance.addSeries(LineSeries, { color: '#f4b65e', lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
    slow.current = instance.addSeries(LineSeries, { color: '#73a9f6', lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
    return () => { instance.remove(); chart.current = null; bars.current = null; fast.current = null; slow.current = null; };
  }, []);

  React.useEffect(() => {
    const closed = candles.filter(c => c.confirmed && c.timestamp + 300_000 <= Date.now())
      .filter(c => [c.open, c.high, c.low, c.close].every(value => Number.isFinite(value) && value > 0))
      .sort((a, b) => a.timestamp - b.timestamp);
    bars.current?.setData(closed.map(c => ({ time: Math.floor(c.timestamp / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    const precision = (closed.at(-1)?.close ?? 1) < 1 ? 8 : 4;
    bars.current?.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
    const values = closed.map(c => c.close);
    const ema = (period: number) => EMA.calculate({ period, values }).map((value, i) => ({ time: Math.floor(closed[i + period - 1].timestamp / 1000) as UTCTimestamp, value }));
    fast.current?.setData(closed.length >= 9 ? ema(9) : []);
    slow.current?.setData(closed.length >= 21 ? ema(21) : []);
    chart.current?.timeScale().fitContent();
  }, [candles, symbol]);

  return <div className="chart-wrap"><div className="price-chart" ref={container} />{candles.length === 0 && <div className="chart-empty">等待已收盘 5 分钟 K 线</div>}</div>;
}
