import type { Market } from './types.js';

export const marketLabel = (market: Market) => market === 'swap' ? 'USDT 永续' : '现货';
export const marketSymbol = (market: Market, symbol: string) =>
  (market === 'swap' ? /^[A-Z0-9]+-USDT-SWAP$/ : /^[A-Z0-9]+-USDT$/).test(symbol);
export const marketPath = (path: string, market: Market) => `${path}${path.includes('?') ? '&' : '?'}market=${market}`;
