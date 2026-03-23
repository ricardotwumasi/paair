import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';

const log = createLogger('migration');

const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: 'add_telegram_message_id_to_escalations',
    sql: 'ALTER TABLE escalations ADD COLUMN telegram_message_id INTEGER',
  },
  {
    name: 'add_resolved_at_to_escalations',
    sql: 'ALTER TABLE escalations ADD COLUMN resolved_at TEXT',
  },
  {
    name: 'add_resolved_response_to_escalations',
    sql: 'ALTER TABLE escalations ADD COLUMN resolved_response TEXT',
  },
];

const SYSTEM_STATE_SQL = `
CREATE TABLE IF NOT EXISTS system_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER DEFAULT 0,
  paused_at TEXT,
  resumed_at TEXT
);
INSERT OR IGNORE INTO system_state (id, paused) VALUES (1, 0);
`;

/**
 * Run idempotent schema migrations on the database.
 * ALTER TABLE statements are wrapped in try/catch since SQLite
 * does not support IF NOT EXISTS on ALTER TABLE.
 */
export function runMigrations(db: Database.Database): void {
  // Column migrations
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration.sql);
      log.info(`Migration applied: ${migration.name}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('duplicate column name')) {
        // Already applied; skip silently
      } else {
        log.error(`Migration failed: ${migration.name}`, { error: msg });
        throw error;
      }
    }
  }

  // System state table (CREATE IF NOT EXISTS is idempotent)
  db.exec(SYSTEM_STATE_SQL);

  // Reset any escalations stuck in 'editing' state from a previous crash
  const resetCount = db
    .prepare("UPDATE escalations SET ricardo_action = 'pending' WHERE ricardo_action = 'editing'")
    .run();
  if (resetCount.changes > 0) {
    log.info(`Reset ${resetCount.changes} escalation(s) from 'editing' to 'pending'`);
  }

  log.info('Database migrations complete');
}
