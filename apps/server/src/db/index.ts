import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
import { dataDir, dbPath } from '../config.js';
import { logger } from '../logger.js';
import { DEFAULT_CASE_TYPES, DEFAULT_CREDITOR_STAGES, DOC_TYPE_KEYWORDS } from '@lcm/shared';

export type DB = BetterSQLite3Database<typeof schema>;
export { schema };

let dbInstance: DB | null = null;
let sqliteInstance: Database.Database | null = null;

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, '../../drizzle');

export function openDatabase(file: string = dbPath()): DB {
  if (dbInstance) return dbInstance;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  if (fs.existsSync(migrationsFolder)) {
    migrate(db, { migrationsFolder });
  } else {
    logger.warn({ migrationsFolder }, 'migrations フォルダが見つかりません');
  }
  ensureFts(sqlite);
  seedDefaults(sqlite);
  dbInstance = db;
  sqliteInstance = sqlite;
  return db;
}

export function db(): DB {
  if (!dbInstance) return openDatabase();
  return dbInstance;
}

export function sqlite(): Database.Database {
  if (!sqliteInstance) openDatabase();
  return sqliteInstance!;
}

export function closeDatabase() {
  sqliteInstance?.close();
  sqliteInstance = null;
  dbInstance = null;
}

/** テスト用: 一時ファイル DB を開く */
export function openTestDatabase(): DB {
  closeDatabase();
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'lcm-test-'));
  return openDatabase(path.join(dir, 'test.db'));
}

/** FTS5 (trigram) 仮想テーブル。日本語は分かち書きできないため trigram を使う */
function ensureFts(s: Database.Database) {
  s.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS style_samples_fts USING fts5(
      text, context_text, content='style_samples', content_rowid='id', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS style_samples_ai AFTER INSERT ON style_samples BEGIN
      INSERT INTO style_samples_fts(rowid, text, context_text) VALUES (new.id, new.text, new.context_text);
    END;
    CREATE TRIGGER IF NOT EXISTS style_samples_ad AFTER DELETE ON style_samples BEGIN
      INSERT INTO style_samples_fts(style_samples_fts, rowid, text, context_text) VALUES ('delete', old.id, old.text, old.context_text);
    END;
    CREATE TRIGGER IF NOT EXISTS style_samples_au AFTER UPDATE ON style_samples BEGIN
      INSERT INTO style_samples_fts(style_samples_fts, rowid, text, context_text) VALUES ('delete', old.id, old.text, old.context_text);
      INSERT INTO style_samples_fts(rowid, text, context_text) VALUES (new.id, new.text, new.context_text);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS form_templates_fts USING fts5(
      name, extracted_text, content='form_templates', content_rowid='id', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS form_templates_ai AFTER INSERT ON form_templates BEGIN
      INSERT INTO form_templates_fts(rowid, name, extracted_text) VALUES (new.id, new.name, new.extracted_text);
    END;
    CREATE TRIGGER IF NOT EXISTS form_templates_ad AFTER DELETE ON form_templates BEGIN
      INSERT INTO form_templates_fts(form_templates_fts, rowid, name, extracted_text) VALUES ('delete', old.id, old.name, old.extracted_text);
    END;
    CREATE TRIGGER IF NOT EXISTS form_templates_au AFTER UPDATE ON form_templates BEGIN
      INSERT INTO form_templates_fts(form_templates_fts, rowid, name, extracted_text) VALUES ('delete', old.id, old.name, old.extracted_text);
      INSERT INTO form_templates_fts(rowid, name, extracted_text) VALUES (new.id, new.name, new.extracted_text);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      body, content='messages', content_rowid='id', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
    END;
  `);
}

function seedDefaults(s: Database.Database) {
  const count = (s.prepare('SELECT COUNT(*) AS c FROM case_types').get() as { c: number }).c;
  if (count > 0) return;
  const insert = s.prepare(
    'INSERT INTO case_types (key, label, sort_order, has_creditors, creditor_stages, doc_type_keywords) VALUES (?, ?, ?, ?, ?, ?)',
  );
  DEFAULT_CASE_TYPES.forEach((ct, i) => {
    insert.run(
      ct.key,
      ct.label,
      i,
      ct.hasCreditors ? 1 : 0,
      JSON.stringify(ct.hasCreditors ? DEFAULT_CREDITOR_STAGES : []),
      JSON.stringify(DOC_TYPE_KEYWORDS),
    );
  });
  logger.info('事件類型の初期値を投入しました');
}

export function ensureDataDir() {
  fs.mkdirSync(dataDir(), { recursive: true });
}
