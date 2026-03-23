import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../logger.js';
import { runMigrations } from './migrate_db.js';

const log = createLogger('database');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT,
  received_at TEXT NOT NULL,
  body_logged INTEGER DEFAULT 0,
  body_text TEXT,
  processed_at TEXT,
  action TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER REFERENCES emails(id),
  response_body TEXT NOT NULL,
  resend_message_id TEXT,
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER REFERENCES emails(id),
  reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  urgency TEXT NOT NULL,
  draft_response TEXT,
  telegram_notified INTEGER DEFAULT 0,
  ricardo_action TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_address TEXT NOT NULL,
  date TEXT NOT NULL,
  count INTEGER DEFAULT 1,
  UNIQUE(sender_address, date)
);

CREATE TABLE IF NOT EXISTS llm_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER REFERENCES emails(id),
  request_messages TEXT NOT NULL,
  response_content TEXT NOT NULL,
  tool_calls TEXT,
  model TEXT NOT NULL,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

export function initDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  runMigrations(db);

  log.info('Database initialised', { path: dbPath });
  _db = db;
  return db;
}

let _db: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (!_db) {
    if (!dbPath) {
      throw new Error('Database not initialised. Call initDatabase() first or provide a path.');
    }
    _db = initDatabase(dbPath);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// Run standalone: npx tsx src/utils/init_db.ts
const isMain = process.argv[1]?.endsWith('init_db.ts');
if (isMain) {
  const { getConfig } = await import('../config.js');
  const config = getConfig();
  initDatabase(config.logging.database);
  console.log('Database initialised at', config.logging.database);
}
