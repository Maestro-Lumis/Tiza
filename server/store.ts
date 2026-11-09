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
