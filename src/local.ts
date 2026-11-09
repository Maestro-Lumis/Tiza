/**
 * Доски в браузере учителя лежат в IndexedDB: там места сотни мегабайт,
 * а в localStorage всего около 5 МБ на все доски вместе - пара скриншотов, и место кончается.
 * Раньше доски хранились в localStorage; при первом чтении они переезжают сюда.
 */
const DB_NAME = 'tiza';
const STORE = 'boards';
/** Старые доски в localStorage: tiza:board и tiza:board:<ученик>:<тема>. */
const OLD_PREFIX = 'tiza:board';

let db: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return db;
}

/** Одна операция с хранилищем досок: ждём, пока она запишется на диск. */
async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const tx = (await openDb()).transaction(STORE, mode);
  const req = action(tx.objectStore(STORE));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let migrated: Promise<void> | null = null;

/** Переносит все старые доски из localStorage сразу: так там освобождается место. */
function migrate(): Promise<void> {
  migrated ??= (async () => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(OLD_PREFIX));
    for (const key of keys) {
      try {
        const data = JSON.parse(localStorage.getItem(key) ?? 'null');
        if (data !== null && (await run('readonly', (s) => s.get(key))) === undefined) {
          await run('readwrite', (s) => s.put(data, key));
        }
        localStorage.removeItem(key);
      } catch {
        // Испорченную доску оставляем как есть: перенести её нельзя, но и терять незачем.
      }
    }
  })();
  return migrated;
}

/** Сохранённая доска или null, если её ещё нет. */
export async function readBoard(key: string): Promise<unknown> {
  try {
    await migrate();
    return (await run('readonly', (s) => s.get(key))) ?? null;
  } catch {
    return null;
  }
}

/** Сохраняет доску. Браузер копирует данные сам, ссылки на живые массивы доски не остаются. */
export function writeBoard(key: string, data: unknown): Promise<void> {
  return run('readwrite', (s) => s.put(data, key)).then(() => undefined);
}

export function deleteBoard(key: string): void {
  run('readwrite', (s) => s.delete(key)).catch(() => {});
  try {
    localStorage.removeItem(key);
  } catch {
    // Хранилище недоступно: удалять нечего.
  }
}
