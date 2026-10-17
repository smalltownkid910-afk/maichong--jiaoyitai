import { dirname, extname, basename, join } from 'node:path';
import type { Market } from '../shared/types.js';

export function marketDatabasePath(path: string, market: Market) {
  if (market === 'spot') return path;
  const ext = extname(path);
  return join(dirname(path), `${basename(path, ext)}.swap${ext}`);
}
