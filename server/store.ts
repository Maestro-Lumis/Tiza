/**
 * Где сервер хранит доски: база libSQL. На хостинге это Turso (адрес и токен из .env),
 * у себя на компьютере - файл data/tiza.db. Код один и тот же, меняется только адрес.
 */
import { mkdirSync } from 'node:fs';
import { createClient } from '@libsql/client';
import type { BoardData } from '../src/ops.ts';

const url = process.env.TURSO_DATABASE_URL || 'file:data/tiza.db';
// Папка data/ в git не попадает (см. .gitignore), но её надо создать до первого запуска.
if (url.startsWith('file:')) mkdirSync('data', { recursive: true });

const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });

await db.execute(
  'CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)',
);

await db.execute(
  'CREATE TABLE IF NOT EXISTS roadmaps (id TEXT PRIMARY KEY, data TEXT NOT NULL, write_hash TEXT NOT NULL, updated_at INTEGER NOT NULL)',
);

await db.execute(
  'CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)',
);

// Учётные записи учителей. workspace_key - ключ к списку учеников: его выдаём после входа.
await db.execute(
  `CREATE TABLE IF NOT EXISTS accounts (
    login TEXT PRIMARY KEY,
    pass_hash TEXT NOT NULL,
    recovery_hash TEXT NOT NULL,
    workspace_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )`,
);

// Отозванные ключи: после смены пароля старый ключ на других устройствах больше не работает.
await db.execute('CREATE TABLE IF NOT EXISTS revoked_keys (id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL)');

export const storeName = url.startsWith('file:') ? url.slice(5) : 'Turso';

/** Доска из базы или null, если такой ещё нет. */
export async function loadBoard(id: string): Promise<BoardData | null> {
  const rs = await db.execute({ sql: 'SELECT data FROM boards WHERE id = ?', args: [id] });
  return rs.rows[0] ? JSON.parse(String(rs.rows[0].data)) : null;
}

export async function saveBoard(id: string, board: BoardData): Promise<void> {
  await db.execute({
    sql: `INSERT INTO boards (id, data, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    args: [id, JSON.stringify(board), Date.now()],
  });
}

/* ---------- дорожные карты учеников ---------- */

/** Дорожная карта для ученика и отпечаток ключа учителя, которым её можно менять. */
export type StoredRoadmap = { data: string; writeHash: string };

export async function loadRoadmap(id: string): Promise<StoredRoadmap | null> {
  const rs = await db.execute({ sql: 'SELECT data, write_hash FROM roadmaps WHERE id = ?', args: [id] });
  const row = rs.rows[0];
  return row ? { data: String(row.data), writeHash: String(row.write_hash) } : null;
}

export async function saveRoadmap(id: string, data: string, writeHash: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO roadmaps (id, data, write_hash, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    args: [id, data, writeHash, Date.now()],
  });
}

/* ---------- список учеников учителя ---------- */
// id - отпечаток ключа учителя: самого ключа в базе нет, по базе в чужой список не войти.

export async function loadWorkspace(id: string): Promise<string | null> {
  const rs = await db.execute({ sql: 'SELECT data FROM workspaces WHERE id = ?', args: [id] });
  return rs.rows[0] ? String(rs.rows[0].data) : null;
}

export async function saveWorkspace(id: string, data: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO workspaces (id, data, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    args: [id, data, Date.now()],
  });
}

export async function deleteWorkspace(id: string): Promise<void> {
  await db.execute({ sql: 'DELETE FROM workspaces WHERE id = ?', args: [id] });
}

/* ---------- учётные записи ---------- */

export type Account = { login: string; passHash: string; recoveryHash: string; workspaceKey: string };

function account(row: Record<string, unknown> | undefined): Account | null {
  if (!row) return null;
  return {
    login: String(row.login),
    passHash: String(row.pass_hash),
    recoveryHash: String(row.recovery_hash),
    workspaceKey: String(row.workspace_key),
  };
}

export async function loadAccount(login: string): Promise<Account | null> {
  const rs = await db.execute({ sql: 'SELECT * FROM accounts WHERE login = ?', args: [login] });
  return account(rs.rows[0]);
}

/** Кому принадлежит ключ: чужой список к новому логину не привязать. */
export async function accountByKey(key: string): Promise<Account | null> {
  const rs = await db.execute({ sql: 'SELECT * FROM accounts WHERE workspace_key = ?', args: [key] });
  return account(rs.rows[0]);
}

/** false - логин уже занят (кто-то успел раньше). */
export async function createAccount(a: Account): Promise<boolean> {
  try {
    await db.execute({
      sql: 'INSERT INTO accounts (login, pass_hash, recovery_hash, workspace_key, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [a.login, a.passHash, a.recoveryHash, a.workspaceKey, Date.now()],
    });
    return true;
  } catch {
    return false;
  }
}

export async function updateAccount(a: Account): Promise<void> {
  await db.execute({
    sql: 'UPDATE accounts SET pass_hash = ?, recovery_hash = ?, workspace_key = ? WHERE login = ?',
    args: [a.passHash, a.recoveryHash, a.workspaceKey, a.login],
  });
}

export async function revokeKey(id: string): Promise<void> {
  await db.execute({ sql: 'INSERT OR IGNORE INTO revoked_keys (id, revoked_at) VALUES (?, ?)', args: [id, Date.now()] });
}

export async function isRevoked(id: string): Promise<boolean> {
  const rs = await db.execute({ sql: 'SELECT 1 FROM revoked_keys WHERE id = ?', args: [id] });
  return rs.rows.length > 0;
}

export async function listLogins(): Promise<string[]> {
  const rs = await db.execute('SELECT login FROM accounts ORDER BY created_at');
  return rs.rows.map((r) => String(r.login));
}
