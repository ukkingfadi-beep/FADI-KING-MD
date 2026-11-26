import fs from 'fs';
import path from 'path';
import tls from 'tls';
import { DatabaseSync } from 'node:sqlite';
import { MongoClient, type Collection } from 'mongodb';
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

let cachedPersistentVolumeDir: string | null | undefined;
let cachedDataDir: string | null = null;
let cachedSessionDir: string | null = null;
let sessionsMigrated = false;

export function resolvePersistentVolumeDir(): string | null {
  if (cachedPersistentVolumeDir !== undefined) {
    return cachedPersistentVolumeDir;
  }

  const volumeCandidates = [
    process.env.DATA_DIR?.trim(),
    process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim(),
    fs.existsSync('/data') && isWritableDir('/data') ? '/data' : undefined,
  ].filter((v): v is string => Boolean(v));

  for (const dir of volumeCandidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (isWritableDir(dir)) {
        cachedPersistentVolumeDir = path.resolve(dir);
        return cachedPersistentVolumeDir;
      }
    } catch {
      // Try next volume candidate
    }
  }

  cachedPersistentVolumeDir = null;
  return null;
}

export function resolveDataDir(): string {
  if (cachedDataDir) return cachedDataDir;

  const volumeDir = resolvePersistentVolumeDir();
  if (volumeDir) {
    cachedDataDir = volumeDir;
    return cachedDataDir;
  }

  cachedDataDir = path.resolve(process.cwd(), 'database');
  fs.mkdirSync(cachedDataDir, { recursive: true });
  return cachedDataDir;
}

function copySessionTreeIfMissing(srcDir: string, destDir: string): boolean {
  if (!fs.existsSync(path.join(srcDir, 'creds.json'))) return false;
  if (fs.existsSync(path.join(destDir, 'creds.json'))) return false;

  try {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const srcFile = path.join(srcDir, entry.name);
      const destFile = path.join(destDir, entry.name);
      if (!fs.existsSync(destFile)) {
        fs.copyFileSync(srcFile, destFile);
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function migrateLegacySessionsIfNeeded(targetSessionDir: string): number {
  if (sessionsMigrated) return 0;
  sessionsMigrated = true;

  const volumeDir = resolvePersistentVolumeDir();
  const legacyDirs = Array.from(
    new Set(
      [
        volumeDir ? path.join(volumeDir, 'sessions') : '',
        path.resolve(process.cwd(), 'database', 'sessions'),
        path.resolve(process.cwd(), 'auth_info_baileys'),
      ]
        .filter(Boolean)
        .map((d) => path.resolve(d))
        .filter((d) => d !== path.resolve(targetSessionDir))
    )
  );

  let migratedCount = 0;
  for (const legacyDir of legacyDirs) {
    if (!fs.existsSync(legacyDir)) continue;
    try {
      const entries = fs.readdirSync(legacyDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name !== 'main' && !entry.name.startsWith('vip_')) continue;
        const copied = copySessionTreeIfMissing(
          path.join(legacyDir, entry.name),
          path.join(targetSessionDir, entry.name)
        );
        if (copied) migratedCount += 1;
      }
    } catch {
      // Ignore unreadable legacy folder
    }
  }

  if (migratedCount > 0) {
    logger.info(
      'database',
      `Migrated ${migratedCount} existing WhatsApp session folder(s) into persistent auth directory ${targetSessionDir}.`
    );
  }
  return migratedCount;
}

/**
 * Resolves the Baileys authentication directory (`auth_info_baileys`).
 * On Railway or platforms with a persistent volume mount (`RAILWAY_VOLUME_MOUNT_PATH`, `DATA_DIR`, or `/data`),
 * relative paths such as `database/sessions` or `auth_info_baileys` are anchored on the persistent volume
 * so redeploying from GitHub never wipes paired sessions.
 */
export function resolveSessionDir(): string {
  if (cachedSessionDir) return cachedSessionDir;

  const volumeDir = resolvePersistentVolumeDir();
  const dataDir = resolveDataDir();
  const cwdRoot = path.resolve(process.cwd());
  const rawOverride = (process.env.AUTH_DIR || process.env.SESSION_DIR || '').trim();

  let targetDir: string;
  if (rawOverride && path.isAbsolute(rawOverride)) {
    const resolvedOverride = path.resolve(rawOverride);
    const pointsIntoEphemeralCwd =
      resolvedOverride === cwdRoot || resolvedOverride.startsWith(cwdRoot + path.sep);
    targetDir =
      volumeDir && pointsIntoEphemeralCwd
        ? path.join(volumeDir, 'auth_info_baileys')
        : resolvedOverride;
  } else if (volumeDir) {
    const cleanRel = rawOverride
      .replace(/^\.[\\/]/, '')
      .replace(/^database[\\/]/, '')
      .trim();
    const folderName =
      !cleanRel || cleanRel === 'sessions' || cleanRel === 'auth_info_baileys'
        ? 'auth_info_baileys'
        : path.basename(cleanRel);
    targetDir = path.join(volumeDir, folderName);
  } else if (rawOverride) {
    const cleanRel = rawOverride.replace(/^\.[\\/]/, '').trim();
    targetDir =
      cleanRel === 'database/sessions'
        ? path.join(dataDir, 'auth_info_baileys')
        : path.resolve(cwdRoot, cleanRel);
  } else {
    targetDir = path.join(dataDir, 'auth_info_baileys');
  }

  fs.mkdirSync(targetDir, { recursive: true });
  migrateLegacySessionsIfNeeded(targetDir);
  cachedSessionDir = path.resolve(targetDir);
  return cachedSessionDir;
}

interface FkmdStoreDoc {
  store_key: string;
  payload: unknown;
  updated_at: Date;
}

let sqliteDb: DatabaseSync | null = null;
let pgPool: Pool | null = null;
let pgReady = false;
let mongoClient: MongoClient | null = null;
let mongoCollection: Collection<FkmdStoreDoc> | null = null;
let mongoReady = false;
let mongoReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let dbInitialized = false;

const hydrationHooks: Array<() => void> = [];
const pendingWriteQueue = new Map<string, Promise<void>>();
const dirtyRemoteKeys = new Set<string>();

function resolveMongoUri(): string {
  const raw = (
    process.env.MONGODB_URI?.trim() ||
    process.env.MONGO_URL?.trim() ||
    process.env.MONGODB_URL?.trim() ||
    process.env.MONGO_PRIVATE_URL?.trim() ||
    process.env.MONGO_PUBLIC_URL?.trim() ||
    ''
  )
    .replace(/^['"]|['"]$/g, '')
    .trim();

  if (!raw || !/^mongodb(\+srv)?:\/\//i.test(raw)) {
    return '';
  }
  return raw;
}

function formatMongoConnectError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err || 'Unknown connection failure');
  if (/SSL alert number 80|tlsv1 alert internal error/i.test(msg)) {
    return 'TLS handshake rejected by MongoDB host (SSL alert 80 — verify Atlas Network Access allows 0.0.0.0/0 and URI credentials are valid)';
  }
  if (/ERR_SSL|SSL routines|tlsv1/i.test(msg)) {
    return 'TLS handshake failed with MongoDB host — verify cluster TLS settings and Atlas IP Access List (0.0.0.0/0)';
  }
  if (/auth failed|Authentication failed|bad auth/i.test(msg)) {
    return 'MongoDB authentication failed — verify username/password in MONGODB_URI';
  }
  return msg;
}

async function connectMongoWithFallback(mongoUri: string): Promise<MongoClient> {
  const baseOptions = {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 8_000,
    family: 4 as const,
    autoSelectFamily: false,
  };

  const primaryClient = new MongoClient(mongoUri, baseOptions);
  try {
    await primaryClient.connect();
    return primaryClient;
  } catch (primaryErr) {
    await primaryClient.close().catch(() => {});
    const errMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    if (!/SSL|TLS|tlsv1|ERR_SSL|alert/i.test(errMsg)) {
      throw primaryErr;
    }

    // Retry with explicit TLS 1.2 secureContext (resolves OpenSSL 3 / Node 22 handshake issues while preserving full cert verification)
    const tls12Client = new MongoClient(mongoUri, {
      ...baseOptions,
      tls: true,
      secureContext: tls.createSecureContext({
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
      }),
    });
    try {
      await tls12Client.connect();
      return tls12Client;
    } catch (tls12Err) {
      await tls12Client.close().catch(() => {});
      throw tls12Err;
    }
  }
}

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

function enqueueKeyWrite(key: string, op: () => Promise<void>): void {
  const prev = pendingWriteQueue.get(key) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(op)
    .finally(() => {
      if (pendingWriteQueue.get(key) === next) {
        pendingWriteQueue.delete(key);
      }
    });
  pendingWriteQueue.set(key, next);
}

function writeRemoteKey(key: string, parsedPayload: unknown, serialized: string, onlyIfMissing: boolean): void {
  const cleanKey = String(key);

  if (mongoCollection && mongoReady) {
    enqueueKeyWrite(cleanKey, async () => {
      if (!mongoCollection || !mongoReady) return;
      try {
        if (onlyIfMissing) {
          await mongoCollection.updateOne(
            { store_key: cleanKey },
            {
              $setOnInsert: {
                store_key: cleanKey,
                payload: parsedPayload,
                updated_at: new Date(),
              },
            },
            { upsert: true }
          );
        } else {
          await mongoCollection.updateOne(
            { store_key: cleanKey },
            {
              $set: {
                store_key: cleanKey,
                payload: parsedPayload,
                updated_at: new Date(),
              },
            },
            { upsert: true }
          );
        }
      } catch (err) {
        logger.warn('database', `MongoDB write failed for "${cleanKey}": ${(err as Error).message}`);
      }
    });
  }

  if (pgPool && pgReady) {
    enqueueKeyWrite(`pg:${cleanKey}`, async () => {
      if (!pgPool || !pgReady) return;
      try {
        const sql = onlyIfMissing
          ? `INSERT INTO fkmd_store (store_key, payload, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT(store_key) DO NOTHING`
          : `INSERT INTO fkmd_store (store_key, payload, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT(store_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`;
        await pgPool.query(sql, [cleanKey, serialized]);
      } catch (err) {
        logger.warn('database', `PostgreSQL sync failed for "${cleanKey}": ${(err as Error).message}`);
      }
    });
  }
}

export function dbGetSync<T>(key: string): T | null {
  try {
    const db = getSqliteDb();
    const row = db
      .prepare('SELECT payload FROM fkmd_store WHERE store_key = ?')
      .get(String(key)) as { payload?: string } | undefined;
    if (!row?.payload) return null;
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

export function dbSetSync(key: string, value: unknown): void {
  const cleanKey = String(key);
  const serialized = JSON.stringify(value);
  const parsedPayload = JSON.parse(serialized) as unknown;
  const now = new Date().toISOString();

  if (!dbInitialized) {
    dirtyRemoteKeys.add(cleanKey);
  }

  try {
    const db = getSqliteDb();
    db.prepare(
      `INSERT INTO fkmd_store (store_key, payload, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(store_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
    ).run(cleanKey, serialized, now);
  } catch (err) {
    logger.warn('database', `SQLite write failed for key "${cleanKey}": ${(err as Error).message}`);
  }

  writeRemoteKey(cleanKey, parsedPayload, serialized, false);
}

/**
 * Seeds an initial default/fallback value ONLY if no record exists yet locally or in the external database.
 * Existing MongoDB / PostgreSQL / SQLite records are never overwritten.
 */
export function dbSeedSync(key: string, fallbackValue: unknown): void {
  const cleanKey = String(key);
  const serialized = JSON.stringify(fallbackValue);
  const parsedPayload = JSON.parse(serialized) as unknown;
  const now = new Date().toISOString();

  try {
    const db = getSqliteDb();
    db.prepare(
      `INSERT INTO fkmd_store (store_key, payload, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(store_key) DO NOTHING`
    ).run(cleanKey, serialized, now);
  } catch (err) {
    logger.warn('database', `SQLite seed failed for key "${cleanKey}": ${(err as Error).message}`);
  }

  if (dbInitialized) {
    writeRemoteKey(cleanKey, parsedPayload, serialized, true);
  }
}

export function migrateLegacyJsonIfMissing<T>(key: string, legacyFilePath: string): T | null {
  const existing = dbGetSync<T>(key);
  if (existing !== null) return existing;

  if (!fs.existsSync(legacyFilePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyFilePath, 'utf-8')) as T;
    dbSeedSync(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function resolveMongoDbName(mongoUri: string): string {
  const explicit = process.env.MONGODB_DB_NAME?.trim();
  if (explicit) return explicit;
  try {
    const afterHost = mongoUri.replace(/^mongodb(\+srv)?:\/\/[^/]+/i, '');
    const pathPart = afterHost.split('?')[0]?.replace(/^\/+/, '').trim();
    if (pathPart) return decodeURIComponent(pathPart);
  } catch {
    // Fallback to default database name
  }
  return 'fadi_king_md';
}

async function tryConnectAndHydrateMongo(
  mongoUri: string,
  db: DatabaseSync,
  sessionDir: string,
  options?: { silentOnFailure?: boolean }
): Promise<number | null> {
  let client: MongoClient | null = null;
  try {
    client = await connectMongoWithFallback(mongoUri);
    const dbName = resolveMongoDbName(mongoUri);
    const collection = client.db(dbName).collection<FkmdStoreDoc>('fkmd_store');
    await collection.createIndex({ store_key: 1 }, { unique: true });

    const remoteDocs = await collection
      .find({}, { projection: { _id: 0, store_key: 1, payload: 1 } })
      .toArray();

    const remoteKeys = new Set<string>();
    const upsertLocal = db.prepare(
      `INSERT INTO fkmd_store (store_key, payload, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(store_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
    );

    const now = new Date().toISOString();
    for (const doc of remoteDocs) {
      if (!doc?.store_key) continue;
      const key = String(doc.store_key);
      remoteKeys.add(key);
      if (dirtyRemoteKeys.has(key)) continue;
      upsertLocal.run(key, JSON.stringify(doc.payload), now);
    }

    const localRows = db
      .prepare('SELECT store_key, payload FROM fkmd_store')
      .all() as Array<{ store_key: string; payload: string }>;

    for (const local of localRows) {
      const key = String(local.store_key);
      let parsed: unknown;
      try {
        parsed = JSON.parse(local.payload);
      } catch {
        continue;
      }

      if (dirtyRemoteKeys.has(key)) {
        await collection.updateOne(
          { store_key: key },
          {
            $set: {
              store_key: key,
              payload: parsed,
              updated_at: new Date(),
            },
          },
          { upsert: true }
        );
      } else if (!remoteKeys.has(key)) {
        await collection.updateOne(
          { store_key: key },
          {
            $setOnInsert: {
              store_key: key,
              payload: parsed,
              updated_at: new Date(),
            },
          },
          { upsert: true }
        );
      }
    }

    mongoClient = client;
    mongoCollection = collection;
    mongoReady = true;
    dbInitialized = true;
    dirtyRemoteKeys.clear();
    notifyHydrationHooks();
    logger.info(
      'database',
      `Connected to MongoDB (${dbName}) + local SQLite cache (${remoteDocs.length} record(s) hydrated). Session dir: ${sessionDir}`
    );
    return remoteDocs.length;
  } catch (err) {
    if (client) {
      await client.close().catch(() => {});
    }
    mongoClient = null;
    mongoCollection = null;
    mongoReady = false;
    if (!options?.silentOnFailure) {
      logger.warn(
        'database',
        `MongoDB unavailable (${formatMongoConnectError(err)}). Using persistent SQLite cache and retrying in background.`
      );
    }
    return null;
  }
}

function scheduleMongoReconnect(mongoUri: string, sessionDir: string): void {
  if (mongoReconnectTimer) {
    clearTimeout(mongoReconnectTimer);
    mongoReconnectTimer = null;
  }
  mongoReconnectTimer = setTimeout(() => {
    mongoReconnectTimer = null;
    if (mongoReady) return;
    void tryConnectAndHydrateMongo(mongoUri, getSqliteDb(), sessionDir, {
      silentOnFailure: true,
    }).then((hydrated) => {
      if (hydrated === null && !mongoReady) {
        scheduleMongoReconnect(mongoUri, sessionDir);
      }
    });
  }, 60_000);
  mongoReconnectTimer.unref?.();
}

export async function initDatabase(): Promise<{
  engine: 'mongodb+sqlite' | 'postgres+sqlite' | 'sqlite';
  dataDir: string;
  sessionDir: string;
  persistentVolumeMounted: boolean;
  hydratedKeys: number;
}> {
  const dataDir = resolveDataDir();
  const sessionDir = resolveSessionDir();
  const persistentVolumeMounted = Boolean(resolvePersistentVolumeDir());
  const db = getSqliteDb();

  const mongoUri = resolveMongoUri();
  if (mongoUri) {
    const hydrated = await tryConnectAndHydrateMongo(mongoUri, db, sessionDir);
    if (hydrated !== null) {
      return {
        engine: 'mongodb+sqlite',
        dataDir,
        sessionDir,
        persistentVolumeMounted,
        hydratedKeys: hydrated,
      };
    }
    scheduleMongoReconnect(mongoUri, sessionDir);
  }

  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl) {
    dbInitialized = true;
    logger.info(
      'database',
      `Persistent SQLite ready at ${path.join(dataDir, 'fadi_bot.db')} | Auth sessions dir: ${sessionDir}`
    );
    return {
      engine: 'sqlite',
      dataDir,
      sessionDir,
      persistentVolumeMounted,
      hydratedKeys: 0,
    };
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
    dbInitialized = true;
    dirtyRemoteKeys.clear();
    notifyHydrationHooks();
    logger.info(
      'database',
      `Connected to PostgreSQL + local SQLite cache (${remoteRes.rows.length} record(s) hydrated). Session dir: ${sessionDir}`
    );
    return {
      engine: 'postgres+sqlite',
      dataDir,
      sessionDir,
      persistentVolumeMounted,
      hydratedKeys: remoteRes.rows.length,
    };
  } catch (err) {
    pgReady = false;
    dbInitialized = true;
    logger.warn(
      'database',
      `PostgreSQL unavailable (${(err as Error).message}). Using persistent SQLite database at ${dataDir}.`
    );
    return {
      engine: 'sqlite',
      dataDir,
      sessionDir,
      persistentVolumeMounted,
      hydratedKeys: 0,
    };
  }
}

export async function flushDatabaseWrites(timeoutMs = 2500): Promise<void> {
  const pending = Array.from(pendingWriteQueue.values());
  if (pending.length === 0) return;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export async function closeDatabase(): Promise<void> {
  if (mongoReconnectTimer) {
    clearTimeout(mongoReconnectTimer);
    mongoReconnectTimer = null;
  }
  await flushDatabaseWrites();
  if (mongoClient) {
    await mongoClient.close().catch(() => {});
    mongoClient = null;
    mongoCollection = null;
    mongoReady = false;
  }
  if (pgPool) {
    await pgPool.end().catch(() => {});
    pgPool = null;
    pgReady = false;
  }
}

export function getDatabaseStatus(): {
  engine: 'mongodb+sqlite' | 'postgres+sqlite' | 'sqlite';
  dataDir: string;
  sessionDir: string;
  persistentVolumeMounted: boolean;
  mongoConfigured: boolean;
  postgresConfigured: boolean;
} {
  const engine: 'mongodb+sqlite' | 'postgres+sqlite' | 'sqlite' =
    mongoCollection && mongoReady
      ? 'mongodb+sqlite'
      : pgPool && pgReady
        ? 'postgres+sqlite'
        : 'sqlite';
  return {
    engine,
    dataDir: resolveDataDir(),
    sessionDir: resolveSessionDir(),
    persistentVolumeMounted: Boolean(resolvePersistentVolumeDir()),
    mongoConfigured: Boolean(resolveMongoUri()),
    postgresConfigured: Boolean(process.env.DATABASE_URL?.trim()),
  };
}

const AUTH_BACKUP_PREFIX = 'auth_backup:';
const MAX_AUTH_BACKUP_BYTES = 12 * 1024 * 1024;

export async function backupAuthDirToDb(sessionKey: string, authDir: string): Promise<void> {
  if (!sessionKey || !fs.existsSync(authDir)) return;
  try {
    const entries = await fs.promises.readdir(authDir, { withFileTypes: true });
    const files: Record<string, string> = {};
    const sortedNames = entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name)
      .sort((a, b) => {
        if (a === 'creds.json') return -1;
        if (b === 'creds.json') return 1;
        if (a.startsWith('lid-mapping-') && !b.startsWith('lid-mapping-')) return -1;
        if (b.startsWith('lid-mapping-') && !a.startsWith('lid-mapping-')) return 1;
        if (a.startsWith('app-state-sync-') && !b.startsWith('app-state-sync-')) return -1;
        if (b.startsWith('app-state-sync-') && !a.startsWith('app-state-sync-')) return 1;
        return a.localeCompare(b);
      });

    let totalBytes = 0;
    for (const fileName of sortedNames) {
      const fullPath = path.join(authDir, fileName);
      const content = await fs.promises.readFile(fullPath, 'utf-8').catch(() => '');
      if (!content) continue;
      const bytes = Buffer.byteLength(content, 'utf-8');
      if (fileName !== 'creds.json' && totalBytes + bytes > MAX_AUTH_BACKUP_BYTES) {
        continue;
      }
      files[fileName] = content;
      totalBytes += bytes;
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
      const sessionKey = path.basename(row.store_key.slice(AUTH_BACKUP_PREFIX.length).trim());
      if (!sessionKey) continue;
      const targetDir = path.join(sessionDir, sessionKey);
      const credsPath = path.join(targetDir, 'creds.json');
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
  if (mongoCollection && mongoReady) {
    enqueueKeyWrite(key, async () => {
      if (!mongoCollection || !mongoReady) return;
      await mongoCollection.deleteOne({ store_key: String(key) }).catch(() => {});
    });
  }
  if (pgPool && pgReady) {
    enqueueKeyWrite(`pg:${key}`, async () => {
      if (!pgPool || !pgReady) return;
      await pgPool.query('DELETE FROM fkmd_store WHERE store_key = $1', [key]).catch(() => {});
    });
  }
}
