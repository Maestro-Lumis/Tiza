import { loadStudents, newRoom, replaceStudents, STAMP_KEY, STUDENTS_CHANGED, type Student } from './students';
import { hasServer, serverFetch } from './sync';

/**
 * Список учеников учителя хранится и в браузере, и на сервере. В браузере - чтобы всё
 * открывалось сразу и без связи, на сервере - чтобы его можно было открыть в другом браузере.
 * Вход - секретный ключ учителя: он лежит в браузере, а в другой браузер попадает по ссылке входа.
 * Ключ в ссылке стоит после #, поэтому не уходит ни на сервер сайта, ни в его журналы.
 */
const KEY = 'tiza:key';
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
  return serverFetch('/workspace', {
    method,
    body,
    keepalive,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  });
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

/** Ссылка входа: открыть её в другом браузере - и там тот же список учеников. */
export function loginLink(): string {
  const link = new URL('./', location.href);
  link.hash = `key=${teacherKey()}`;
  return link.href;
}

/**
 * Пришли по ссылке входа: запоминаем ключ из неё и убираем его из адресной строки.
 * false - учитель передумал менять список в этом браузере.
 */
export function takeKeyFromLink(): boolean {
  const key = new URLSearchParams(location.hash.slice(1)).get('key');
  if (!key) return false;
  history.replaceState(null, '', location.pathname + location.search);
  if (!/^[A-Za-z0-9_-]{22}$/.test(key) || key === teacherKey()) return false;
  const question = 'В этом браузере уже есть ученики. Заменить их списком из ссылки входа?';
  if (loadStudents().length && !confirm(question)) return false;
  try {
    localStorage.setItem(KEY, key);
    // Список из ссылки главнее: при сверке возьмём серверный.
    localStorage.setItem(STAMP_KEY, '0');
  } catch {
    return false;
  }
  return true;
}

window.addEventListener(STUDENTS_CHANGED, pushLater);
// Закрывают вкладку сразу после правки: дописываем то, что не успело уйти.
window.addEventListener('pagehide', () => {
  if (dirty) void push(true);
});
