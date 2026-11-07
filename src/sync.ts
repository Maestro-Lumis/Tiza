/// <reference types="vite/client" />
import { applyOp, type BoardData, type Laser, type Op } from './ops';
import { roadmapOf, type Roadmap, type Student } from './students';

/**
 * Адрес сервера берётся из .env (VITE_SERVER_URL). Без него на localhost — свой сервер
 * (npm run server), а на опубликованном сайте доска работает как раньше, без связи.
 * VITE_-значения видны всем в коде сайта, поэтому там только адрес, без ключей.
 */
const SERVER: string | null =
  import.meta.env.VITE_SERVER_URL || (import.meta.env.DEV ? `ws://${location.hostname}:8787` : null);
/** Через сколько миллисекунд пробовать снова, если связь пропала. */
const RETRY = 2000;
/**
 * Раз в сколько миллисекунд проверяем, что связь жива, и сколько ждём ответа.
 * Соединение может умереть молча (заснул Wi-Fi, хостинг оборвал): браузер узнает об этом
 * только через минуту, а изменения всё это время улетали бы в пустоту.
 */
const PING = 10000;
const SILENCE = 25000;

/** Есть ли связь: подключаемся (сервер может просыпаться до минуты), на связи или нет связи. */
export type LinkState = 'connecting' | 'online' | 'offline' | 'waiting' | 'missing';

/** Сервер подключён: значок связи на доске имеет смысл показывать. */
export const hasServer = SERVER !== null;

/**
 * Будит сервер заранее. Бесплатный сервер засыпает без посетителей и просыпается до минуты,
 * поэтому стучимся к нему уже со списка учеников — к открытию доски он успеет проснуться.
 */
export function wakeServer(): void {
  if (!SERVER) return;
  fetch(SERVER.replace(/^ws/, 'http'), { mode: 'no-cors' }).catch(() => {});
}

type Handlers = {
  /**
   * Своя доска целиком: её просит сервер, если доски у него ещё нет.
   * null — своей доски нет (ученик): ждём, пока доску откроет учитель.
   */
  local: () => BoardData | null;
  /** Доска с сервера целиком: заменяет то, что было в вкладке. */
  init: (board: BoardData) => void;
  /** Изменение от другой вкладки или ученика. */
  op: (op: Op) => void;
  /** Точка лазера от другой вкладки или ученика. */
  laser: (point: Laser) => void;
  /** Связь появилась или пропала. */
  state: (state: LinkState) => void;
};

/**
 * Подключает доску к серверу. Возвращает функцию, которая отправляет свои изменения.
 * Пока связи нет (сервер просыпается или пропал), изменения копятся и уходят после подключения:
 * сервер присылает свою доску, к ней сверху применяются накопленные изменения.
 * Без ключа доски (общая доска без ученика) связи нет: доска живёт только в браузере.
 */
export function connect(room: string | null, on: Handlers): { send: (op: Op) => void; laser: (point: Laser) => void } {
  const server = room ? SERVER : null;
  let ws: WebSocket | null = null;
  /** Были ли уже на связи: до первого раза это «подключение…» (сервер просыпается), потом — «нет связи». */
  let wasOnline = false;
  /** Сервер прислал доску в этом соединении: теперь изменения можно слать сразу. */
  let synced = false;
  /** Сервер сказал, что такой доски нет: больше не стучимся. */
  let missing = false;
  /** Изменения, которые ещё не дошли до сервера. */
  const pending: Op[] = [];
  /**
   * Изменения, уехавшие внутри своей доски (seed). Если другая вкладка успела раньше,
   * сервер ответит своей доской — тогда их надо применить к ней заново.
   */
  let seeded: Op[] = [];
  /** Отправленные изменения, которые сервер ещё не подтвердил. Если связь оборвётся — пошлём снова. */
  let unacked: Op[] = [];
  /** Когда сервер последний раз что-то присылал. */
  let heard = 0;
  let pinger: ReturnType<typeof setInterval> | undefined;

  const send = (msg: object) => ws!.send(JSON.stringify(msg));

  function open(): void {
    if (!server || !room) return;
    ws = new WebSocket(`${server}/?board=${encodeURIComponent(room)}`);
    synced = false;
    heard = Date.now();
    clearInterval(pinger);
    pinger = setInterval(() => {
      if (Date.now() - heard > SILENCE) return drop();
      if (ws?.readyState === WebSocket.OPEN) send({ type: 'ping' });
    }, PING);
    ws.onmessage = (e) => {
      heard = Date.now();
      const msg = JSON.parse(e.data);
      if (msg.type === 'pong') return;
      if (msg.type === 'ack') return void unacked.shift();
      if (msg.type === 'missing') {
        missing = true;
        return on.state('missing');
      }
      if (msg.type === 'empty') {
        const board = on.local();
        if (!board) return on.state('waiting'); // сервер пришлёт доску, когда её откроет учитель
        // На сервере доски нет: шлём свою, накопленное в ней уже есть.
        seeded = pending.splice(0);
        send({ type: 'seed', board });
      } else if (msg.type === 'init') {
        // Доска сервера + всё, что сделали без связи, — показываем и досылаем.
        const unsent = [...seeded, ...pending.splice(0)];
        seeded = [];
        for (const op of unsent) applyOp(msg.board, op);
        on.init(msg.board);
        for (const op of unsent) sendOp(op);
      } else if (msg.type === 'op') {
        seeded = []; // сервер уже живёт с нашей доской
        on.op(msg.op);
      } else if (msg.type === 'laser') on.laser(msg);
      // На связи мы, когда сервер прислал доску (или сказал, что её нет), а не когда открылось соединение.
      if (msg.type === 'empty' || msg.type === 'init') {
        synced = true;
        wasOnline = true;
        on.state('online');
      }
    };
    ws.onclose = (e) => closed(e.code);
  }

  function closed(code?: number): void {
    synced = false;
    clearInterval(pinger);
    // Сервер не пустил: ключ доски неверный, пробовать снова бесполезно.
    if (missing || code === 1008) return on.state('missing');
    // Не знаем, дошли ли своя доска и последние изменения, — на всякий случай пошлём их снова.
    pending.unshift(...seeded.splice(0), ...unacked.splice(0));
    on.state(wasOnline ? 'offline' : 'connecting');
    setTimeout(open, RETRY);
  }

  /** Связь молчит слишком долго: не ждём, пока браузер заметит обрыв, а переподключаемся сами. */
  function drop(): void {
    if (!ws) return;
    ws.onclose = null;
    ws.onmessage = null;
    ws.close();
    closed();
  }

  function sendOp(op: Op): void {
    unacked.push(op);
    send({ type: 'op', op });
  }

  if (server) on.state('connecting');
  open();
  return {
    send(op) {
      if (!server) return;
      if (synced && ws?.readyState === WebSocket.OPEN) sendOp(op);
      else pending.push(op);
    },
    // Лазер без связи не копим: через минуту старый след уже никому не нужен.
    laser(point) {
      if (synced && ws?.readyState === WebSocket.OPEN) send(point);
    },
  };
}

/* ---------- дорожная карта ученика ---------- */

/** Обычный адрес сервера (https://…) для запросов карты. */
const HTTP = SERVER?.replace(/^ws/, 'http') ?? null;

/** Кладёт карту ученика на сервер, чтобы он видел новые темы по своей ссылке. */
export async function publishRoadmap(share: { read: string; write: string }, roadmap: Roadmap): Promise<boolean> {
  if (!HTTP) return false;
  try {
    const res = await fetch(`${HTTP}/roadmap/${share.read}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${share.write}` },
      body: JSON.stringify(roadmap),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Если у ученика уже есть ссылка, обновляем его карту на сервере (новая тема, статус, имя). */
export function syncRoadmap(student: Student | undefined): void {
  if (student?.share) void publishRoadmap(student.share, roadmapOf(student));
}

/** Карта ученика по ключу из его ссылки; null — такой нет или сервер недоступен. */
export async function fetchRoadmap(key: string): Promise<Roadmap | 'missing' | null> {
  if (!HTTP) return null;
  try {
    const res = await fetch(`${HTTP}/roadmap/${encodeURIComponent(key)}`);
    if (res.status === 404) return 'missing';
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
