import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function openDatabase(path: string) {
  const full = resolve(path);
  mkdirSync(dirname(full), { recursive: true });
  const db = new DatabaseSync(full);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL UNIQUE, side TEXT NOT NULL,
      quantity REAL NOT NULL, entry_price REAL NOT NULL, stop_loss REAL NOT NULL,
      take_profit REAL NOT NULL, entry_fee REAL NOT NULL, opened_at INTEGER NOT NULL,
      signal_candle_at INTEGER NOT NULL, fee_rate REAL NOT NULL, slippage_rate REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, side TEXT NOT NULL, quantity REAL NOT NULL,
      entry_price REAL NOT NULL, stop_loss REAL NOT NULL, take_profit REAL NOT NULL,
      entry_fee REAL NOT NULL, opened_at INTEGER NOT NULL, signal_candle_at INTEGER NOT NULL,
      fee_rate REAL NOT NULL, slippage_rate REAL NOT NULL, exit_price REAL NOT NULL,
      exit_fee REAL NOT NULL, closed_at INTEGER NOT NULL, exit_reason TEXT NOT NULL,
      gross_pnl REAL NOT NULL, net_pnl REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processed_signals (symbol TEXT PRIMARY KEY, candle_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS handled_signals (symbol TEXT PRIMARY KEY, candle_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS equity_samples (timestamp INTEGER PRIMARY KEY, equity REAL NOT NULL);
  `);
  db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('balance','10000'),('initial_balance','10000'),('auto_trading','false'),('auto_started_at','0')").run();
  return db;
}
export type AppDatabase = ReturnType<typeof openDatabase>;
