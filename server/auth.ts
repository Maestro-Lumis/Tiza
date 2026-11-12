/**
 * Учётные записи учителей: логин и пароль. Почту не храним: забытый пароль сбрасывается
 * ключом восстановления, который учитель получает один раз при регистрации.
 * Здесь только проверки и шифрование, без базы и сети.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/** Логин: латиница, цифры, точка и подчёркивание, 3-30 знаков. Хранится маленькими буквами. */
const LOGIN = /^[a-z0-9._]{3,30}$/;
export const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

/** Maestro и maestro - один логин, чтобы нельзя было завести двойника. */
export function normalizeLogin(login: unknown): string {
  return typeof login === 'string' ? login.trim().toLowerCase() : '';
}

export function loginProblem(login: string): string | null {
  if (login.length < 3) return 'Логин - от 3 знаков.';
  if (login.length > 30) return 'Логин - не длиннее 30 знаков.';
  if (!LOGIN.test(login)) return 'В логине можно только латинские буквы, цифры, точку и подчёркивание.';
  return null;
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Пароль - от ${MIN_PASSWORD} знаков.`;
  if (password.length > MAX_PASSWORD) return 'Слишком длинный пароль.';
  return null;
}

/**
 * Пароль в базе - только отпечаток scrypt с солью: даже с базой на руках пароль не узнать,
 * а подбирать его долго. Формат: scrypt$соль$отпечаток.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = await scryptAsync(password, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Ключ доступа к списку учеников: 16 случайных байт, 22 знака - как ключи досок. */
export function newKey(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Ключ восстановления: 24 знака (цифры и буквы A-F) группами по четыре -
 * его легко переписать с бумажки.
 */
export function newRecovery(): string {
  return randomBytes(12).toString('hex').toUpperCase().match(/.{4}/g)!.join('-');
}

/** Пробелы, дефисы и регистр при вводе ключа восстановления не важны. */
export function recoveryHash(recovery: unknown): string {
  const clean = typeof recovery === 'string' ? recovery.toUpperCase().replace(/[^0-9A-F]/g, '') : '';
  return createHash('sha256').update(`recovery:${clean}`).digest('hex');
}

/* ---------- защита от перебора и ботов ---------- */

/**
 * Не больше max попыток за window миллисекунд с одного адреса. Счётчики живут в памяти:
 * после перезапуска сервера они обнуляются, но перебору этого всё равно мало.
 */
export class Limiter {
  private hits = new Map<string, number[]>();
  // Поля без «private max» в конструкторе: Node запускает TypeScript, просто убирая типы, и такой записи не понимает.
  private max: number;
  private window: number;

  constructor(max: number, window: number) {
    this.max = max;
    this.window = window;
  }

  /** true - можно и попытка засчитана; false - слишком часто. */
  allow(who: string): boolean {
    if (this.full(who)) return false;
    this.count(who);
    return true;
  }

  /** Лимит уже исчерпан? Ничего не засчитывает. */
  full(who: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(who) ?? []).filter((t) => now - t < this.window);
    this.hits.set(who, recent);
    return recent.length >= this.max;
  }

  /** Засчитать попытку. */
  count(who: string): void {
    const now = Date.now();
    const recent = this.hits.get(who) ?? [];
    recent.push(now);
    this.hits.set(who, recent);
    // Старые адреса подчищаем, чтобы память не росла.
    if (this.hits.size > 10000) for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.window)) this.hits.delete(k);
  }
}

/** После стольких неверных паролей подряд логин закрывается на время. */
const MAX_FAILS = 5;
const LOCK_TIME = 5 * 60 * 1000;
const fails = new Map<string, { n: number; until: number }>();

/** Сколько секунд ещё закрыт вход в этот логин; 0 - открыт. */
export function lockedFor(login: string): number {
  const f = fails.get(login);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}

export function failed(login: string): void {
  const f = fails.get(login) ?? { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= MAX_FAILS) {
    f.until = Date.now() + LOCK_TIME;
    f.n = 0;
  }
  fails.set(login, f);
}

export function succeeded(login: string): void {
  fails.delete(login);
}
