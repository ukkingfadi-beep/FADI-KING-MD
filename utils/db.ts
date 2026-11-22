import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { logger } from './logger.ts';

function isWritableDir(dirPath: string): boolean {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

let cachedDataDir: string | null = null;

export function resolveDataDir(): string {
  if (cachedDataDir) return cachedDataDir;

  const candidates = [
    process.env.DATA_DIR?.trim(),
    process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim(),
    fs.existsSync('/data') && isWritableDir('/data') ? '/data' : undefined,
    path.resolve(process.cwd(), 'database'),
  ].filter((v): v is string => Boolean(v));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (isWritableDir(dir)) {
        cachedDataDir = path.resolve(dir);
        return cachedDataDir;
      }
    } catch {
      // Try next candidate
    }
  }

  cachedDataDir = path.resolve(process.cwd(), 'database');
  fs.mkdirSync(cachedDataDir, { recursive: true });
  return cachedDataDir;
}

let sqliteDb: DatabaseSync | null = null;
let pgPool: Pool | null = null;
let pgReady = false;
const hydrationHooks: Array<() => void> = [];

function getSqliteDb(): DatabaseSync {
  if (sqliteDb) return sqliteDb;
  const dataDir = resolveDataDir();
  const dbPath = path.join(dataDir, 'fadi_bot.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS fkmd_store (
      store_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  sqliteDb = db;
  return db;
}

export function registerDbHydrationHook(fn: () => void): void {
  hydrationHooks.push(fn);
}

function notifyHydrationHooks(): void {
  for (const hook of hydrationHooks) {
    try {
      hook();
    } catch {
      // Ignore hook errors
    }
  }
}

export function dbGetSync<T>(key: string): T | null {
  try {
    const db = getSqliteDb();
    const row = db
      .prepare('SELECT payload FROM fkmd_store WHERE store_key = ?')
      .get(key) as { payload?: string } | undefined;
    if (!row?.payload) return null;
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

export function dbSetSync(key: string, value: unknown): void {
  const serialized = JSON.stringify(value);
  const now = new Date().toISOString();
  try {
    const db = getSqliteDb();
    db.prepare(
      `INSERT INTO fkmd_store (store_key, payload, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(store_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
    ).run(key, serialized, now);
  } catch (err) {
    logger.warn('database', `SQLite write failed for key "${key}": ${(err as Error).message}`);
  }

  if (pgPool && pgReady) {
    void pgPool
      .query(
        `INSERT INTO fkmd_store (store_key, payload, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT(store_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
        [key, serialized]
      )
      .catch((err) => {
        logger.warn('database', `PostgreSQL sync failed for "${key}": ${(err as Error).message}`);
      });
  }
}

export function migrateLegacyJsonIfMissing<T>(key: string, legacyFilePath: string): T | null {
  const existing = dbGetSync<T>(key);
  if (existing !== null) return existing;

  if (!fs.existsSync(legacyFilePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyFilePath, 'utf-8')) as T;
    dbSetSync(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export async function initDatabase(): Promise<{
  engine: 'postgres+sqlite' | 'sqlite';
  dataDir: string;
  hydratedKeys: number;
}> {
  const dataDir = resolveDataDir();
  const db = getSqliteDb();
  const dbUrl = process.env.DATABASE_URL?.trim();

  if (!dbUrl) {
    logger.info('database', `Persistent SQLite database ready at ${path.join(dataDir, 'fadi_bot.db')}`);
    return { engine: 'sqlite', dataDir, hydratedKeys: 0 };
  }

  try {
    const isLocal = /localhost|127\.0\.0\.1/i.test(dbUrl);
    pgPool = new Pool({
      connectionString: dbUrl,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
    });

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS fkmd_store (
        store_key TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const remoteRes = await pgPool.query<{ store_key: string; payload: unknown }>(
      'SELECT store_key, payload FROM fkmd_store'
    );

    const remoteKeys = new Set<string>();
    const upsertLocal = db.prepare(
      `INSERT INTO fkmd_store (store_key, payload, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(store_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
    );

    const now = new Date().toISOString();
    for (const row of remoteRes.rows) {
      remoteKeys.add(row.store_key);
      upsertLocal.run(row.store_key, JSON.stringify(row.payload), now);
    }

    // Seed any local SQLite keys that do not yet exist in PostgreSQL
    const localRows = db
      .prepare('SELECT store_key, payload FROM fkmd_store')
      .all() as Array<{ store_key: string; payload: string }>;
    for (const local of localRows) {
      if (!remoteKeys.has(local.store_key)) {
        await pgPool.query(
          `INSERT INTO fkmd_store (store_key, payload, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT(store_key) DO NOTHING`,
          [local.store_key, local.payload]
        );
      }
    }

    pgReady = true;
    notifyHydrationHooks();
    logger.info(
      'database',
      `Connected to PostgreSQL + local SQLite cache (${remoteRes.rows.length} record(s) hydrated).`
    );
    return { engine: 'postgres+sqlite', dataDir, hydratedKeys: remoteRes.rows.length };
  } catch (err) {
    pgReady = false;
    logger.warn(
      'database',
      `PostgreSQL unavailable (${(err as Error).message}). Using persistent SQLite database at ${dataDir}.`
    );
    return { engine: 'sqlite', dataDir, hydratedKeys: 0 };
  }
}

export function getDatabaseStatus(): {
  engine: 'postgres+sqlite' | 'sqlite';
  dataDir: string;
  postgresConfigured: boolean;
} {
  return {
    engine: pgPool && pgReady ? 'postgres+sqlite' : 'sqlite',
    dataDir: resolveDataDir(),
    postgresConfigured: Boolean(process.env.DATABASE_URL?.trim()),
  };
}

const AUTH_BACKUP_PREFIX = 'auth_backup:';

export async function backupAuthDirToDb(sessionKey: string, authDir: string): Promise<void> {
  if (!sessionKey || !fs.existsSync(authDir)) return;
  try {
    const entries = await fs.promises.readdir(authDir, { withFileTypes: true });
    const files: Record<string, string> = {};
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      // Skip large transient pre-key churn beyond recent essentials if huge, keep all small auth JSONs
      const fullPath = path.join(authDir, entry.name);
      const content = await fs.promises.readFile(fullPath, 'utf-8').catch(() => '');
      if (content) {
        files[entry.name] = content;
      }
    }
    if (!files['creds.json']) return;
    dbSetSync(`${AUTH_BACKUP_PREFIX}${sessionKey}`, {
      updatedAt: Date.now(),
      files,
    });
  } catch (err) {
    logger.warn('database', `Auth backup skipped for ${sessionKey}: ${(err as Error).message}`);
  }
}

export async function restoreAuthDirsFromDb(sessionDir: string): Promise<number> {
  let restored = 0;
  try {
    const db = getSqliteDb();
    const rows = db
      .prepare('SELECT store_key, payload FROM fkmd_store WHERE store_key LIKE ?')
      .all(`${AUTH_BACKUP_PREFIX}%`) as Array<{ store_key: string; payload: string }>;

    for (const row of rows) {
      const sessionKey = row.store_key.slice(AUTH_BACKUP_PREFIX.length).trim();
      if (!sessionKey) continue;
      const targetDir = path.join(sessionDir, sessionKey);
      const credsPath = path.join(targetDir, 'creds.json');
      // Only restore if local disk does not already have registered credentials
      if (fs.existsSync(credsPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(credsPath, 'utf-8')) as { registered?: boolean };
          if (parsed?.registered) continue;
        } catch {
          // Proceed with restore if local creds file is corrupted
        }
      }

      const parsed = JSON.parse(row.payload) as { files?: Record<string, string> };
      if (!parsed?.files?.['creds.json']) continue;

      await fs.promises.mkdir(targetDir, { recursive: true });
      for (const [fileName, fileContent] of Object.entries(parsed.files)) {
        const safeName = path.basename(fileName);
        if (!safeName.endsWith('.json')) continue;
        await fs.promises.writeFile(path.join(targetDir, safeName), fileContent, 'utf-8');
      }
      restored += 1;
    }
  } catch (err) {
    logger.warn('database', `Auth restore check failed: ${(err as Error).message}`);
  }
  return restored;
}

export function deleteAuthBackupFromDb(sessionKey: string): void {
  const key = `${AUTH_BACKUP_PREFIX}${sessionKey}`;
  try {
    const db = getSqliteDb();
    db.prepare('DELETE FROM fkmd_store WHERE store_key = ?').run(key);
  } catch {
    // Ignore local SQLite delete error
  }
  if (pgPool && pgReady) {
    void pgPool.query('DELETE FROM fkmd_store WHERE store_key = $1', [key]).catch(() => {});
  }
}
