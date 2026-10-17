import { z } from 'zod';
import { SCREEN } from './screen.js';

const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_PATH: z.string().min(1).default('./data/trader.sqlite'),
  OKX_REST_URL: z.url().default('https://openapi.okx.com'),
  OKX_WS_URL: z.union([z.literal(''), z.url().refine(value => ['wss:', 'ws:'].includes(new URL(value).protocol))]).default('wss://ws.okx.com/ws/v5/public'),
  MARKET_POLL_MS: z.coerce.number().int().min(500).max(10000).default(1000),
  SCREEN_MIN_AGE_DAYS: z.coerce.number().min(0).max(3650).default(90),
  SCREEN_MIN_QUOTE_VOLUME: z.coerce.number().min(0).default(10_000_000),
  SCREEN_MAX_SPREAD_PCT: z.coerce.number().min(0).max(100).default(0.2),
  SCREEN_MIN_DEPTH: z.coerce.number().min(0).default(100_000),
  SCREEN_MAX_5M_MOVE_PCT: z.coerce.number().min(0).max(100).default(5),
  SCREEN_EXCLUDED_STABLE_BASES: z.string().default(SCREEN.excludedStableBases.join(','))
    .transform(value => [...new Set(value.split(',').map(base => base.trim().toUpperCase()).filter(Boolean))])
    .pipe(z.array(z.string().regex(/^[A-Z0-9]{2,20}$/))),
  SIM_FEE_RATE: z.coerce.number().min(0).max(0.1).default(0.001),
  SIM_SLIPPAGE_RATE: z.coerce.number().min(0).max(0.1).default(0.0005),
  OPENAI_BASE_URL: z.union([z.literal(''), z.url()]).default(''),
  OPENAI_MODEL: z.string().default(''),
  OPENAI_API_KEY: z.string().default('')
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`配置无效：${z.prettifyError(result.error)}`);
  return result.data;
}
export type Config = ReturnType<typeof loadConfig>;
