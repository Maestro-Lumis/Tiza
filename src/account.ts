import { loadStudents, newRoom, replaceStudents, STAMP_KEY, STUDENTS_CHANGED, type Student } from './students';
import { hasServer, serverFetch } from './sync';

/**
 * Список учеников учителя хранится и в браузере, и на сервере. В браузере - чтобы всё
 * открывалось сразу и без связи, на сервере - чтобы его можно было открыть в другом браузере.
 * Доступ к списку - секретный ключ: учитель получает его, когда входит логином и паролем.
 */
const KEY = 'tiza:key';
/** Под каким логином вошли в этом браузере. */
const LOGIN = 'tiza:login';
/** Подряд идущие правки отправляем разом, через столько миллисекунд после последней. */
const PUSH_DELAY = 800;

/** Сохранён ли список на сервере: сохранено, отправляется, нет связи, без сервера. */
export type SaveState = 'saved' | 'saving' | 'offline' | 'local';

type Stored = { students: Student[]; at: number };

let state: SaveState = hasServer ? 'saving' : 'local';
const listeners = new Set<(s: SaveState) => void>();

function setState(next: SaveState): void {
  state = next;
  for (const fn of listeners) fn(state);
}

/** Подписка на состояние сохранения; сразу вызывается с текущим. */
export function onSaveState(fn: (s: SaveState) => void): void {
  listeners.add(fn);
  fn(state);
}

/** Ключ учителя; при первом заходе придумывает его. */
export function teacherKey(): string {
  try {
    let key = localStorage.getItem(KEY);
    if (!key) {
      key = newRoom();
      localStorage.setItem(KEY, key);
    }
    return key;
  } catch {
    return '';
  }
}

function stamp(): number {
  try {
    return Number(localStorage.getItem(STAMP_KEY)) || 0;
  } catch {
    return 0;
  }
}

async function request(method: 'GET' | 'PUT', body?: string, keepalive = false): Promise<Response | null> {
  const key = teacherKey();
  if (!hasServer || !key) return null;
  const res = await serverFetch('/workspace', {
    method,
    body,
    keepalive,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  });
  // Пароль сменили на другом устройстве: этот ключ отозван, нужно войти заново.
  if (res?.status === 401) signedOut();
  return res;
}

/** Ключ отозван: выходим и ведём на главную, там спросят логин и пароль. */
function signedOut(): void {
  logout();
  location.replace('./?out=1');
}

let timer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;

/** Отправляет список на сервер сейчас. Не получилось - попробуем при следующей правке или заходе. */
async function push(keepalive = false): Promise<void> {
  clearTimeout(timer);
  if (!hasServer) return;
  dirty = false;
  setState('saving');
  const data: Stored = { students: loadStudents(), at: stamp() };
  const res = await request('PUT', JSON.stringify(data), keepalive);
  if (res?.ok) {
    if (!dirty) setState('saved');
  } else {
    dirty = true;
    setState('offline');
  }
}

function pushLater(): void {
  if (!hasServer) return;
  dirty = true;
  setState('saving');
  clearTimeout(timer);
  timer = setTimeout(() => void push(), PUSH_DELAY);
}

/**
 * Сверяет список с сервером. Новее на сервере - берём его (true: список в браузере сменился),
 * новее в браузере или на сервере пусто - отправляем свой.
 */
export async function pull(): Promise<boolean> {
  if (!hasServer) return false;
  const res = await request('GET');
  if (!res) {
    setState('offline');
    return false;
  }
  if (res.status === 404) {
    if (loadStudents().length) await push();
    else setState('saved');
    return false;
  }
  if (!res.ok) {
    setState('offline');
    return false;
  }
  try {
    const remote = (await res.json()) as Stored;
    if (Array.isArray(remote.students) && remote.at > stamp()) {
      replaceStudents(remote.students, remote.at);
      setState('saved');
      return true;
    }
    if (remote.at < stamp()) await push();
    else setState('saved');
  } catch {
    setState('offline');
  }
  return false;
}

/* ---------- вход, регистрация, восстановление ---------- */

/** Логин, под которым вошли в этом браузере; null - не входили. */
export function currentLogin(): string | null {
  try {
    return localStorage.getItem(LOGIN);
  } catch {
    return null;
  }
}

/** Ответ сервера: данные или текст ошибки, который можно показать учителю. */
type AuthResult = { login?: string; key?: string; recovery?: string; error?: string };

async function authPost(action: string, body: object): Promise<AuthResult> {
  const res = await serverFetch(`/auth/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res) return { error: 'Сервер не отвечает. Если он спал, подождите минуту и попробуйте снова.' };
  try {
    const data = (await res.json()) as AuthResult;
    return res.ok ? data : { error: data.error ?? 'Не получилось. Попробуйте ещё раз.' };
  } catch {
    return { error: 'Сервер ответил непонятно. Попробуйте ещё раз.' };
  }
}

/**
 * Вошли: запоминаем логин и ключ. Ключ другой, чем был в браузере, - это чужой или
 * старый список: убираем его, и при сверке придёт список с сервера.
 */
async function signIn(result: AuthResult): Promise<void> {
  if (!result.key || !result.login) return;
  try {
    if (localStorage.getItem(KEY) !== result.key) {
      replaceStudents([], 0);
      localStorage.setItem(KEY, result.key);
    }
    localStorage.setItem(LOGIN, result.login);
  } catch {
    // Хранилище недоступно: вход до перезагрузки.
  }
  await pull();
}

/** Свободен ли логин; null - сервер не ответил. */
export async function loginFree(login: string): Promise<boolean | null> {
  const res = await serverFetch(`/auth/available?${new URLSearchParams({ login })}`);
  if (!res?.ok) return null;
  try {
    return ((await res.json()) as { free: boolean }).free;
  } catch {
    return null;
  }
}

/**
 * Регистрация. Ученики, которые уже есть в этом браузере, переходят в новую учётную запись:
 * сервер привязывает к ней ключ браузера. website - поле-ловушка для ботов.
 */
export async function register(login: string, password: string, website: string): Promise<AuthResult> {
  const result = await authPost('register', { login, password, website, key: teacherKey() });
  if (!result.error) await signIn(result);
  return result;
}

export async function login(login: string, password: string): Promise<AuthResult> {
  const result = await authPost('login', { login, password });
  if (!result.error) await signIn(result);
  return result;
}

/** Забыли пароль: логин, ключ восстановления и новый пароль. Сервер выдаст новый ключ восстановления. */
export async function recover(login: string, recovery: string, password: string): Promise<AuthResult> {
  const result = await authPost('recover', { login, recovery, password });
  if (!result.error) await signIn(result);
  return result;
}

/** Смена пароля: остальные устройства выходят из учётной записи. */
export async function changePassword(password: string, newPassword: string): Promise<AuthResult> {
  const result = await authPost('password', { login: currentLogin(), password, newPassword });
  if (!result.error) await signIn(result);
  return result;
}

/**
 * Выход: из браузера убирается всё, что относится к учителю, - ключ, логин, ученики
 * и копии досок. Тема, цвета и толщина мела остаются: это настройки браузера, а не учителя.
 */
export function logout(): void {
  clearTimeout(timer);
  dirty = false;
  try {
    for (const k of [KEY, LOGIN, STAMP_KEY, 'tiza:students']) localStorage.removeItem(k);
  } catch {
    // Хранилище недоступно: и так ничего не сохранено.
  }
  try {
    indexedDB.deleteDatabase('tiza');
  } catch {
    // Досок в браузере нет.
  }
}

window.addEventListener(STUDENTS_CHANGED, pushLater);
// Закрывают вкладку сразу после правки: дописываем то, что не успело уйти.
window.addEventListener('pagehide', () => {
  if (dirty) void push(true);
});
