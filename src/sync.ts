/// <reference types="vite/client" />
import { applyOp, type BoardData, type Op } from './ops';

/**
 * Адрес сервера берётся из .env (VITE_SERVER_URL). Без него на localhost — свой сервер
 * (npm run server), а на опубликованном сайте доска работает как раньше, без связи.
 * VITE_-значения видны всем в коде сайта, поэтому там только адрес, без ключей.
 */
const SERVER: string | null =
  import.meta.env.VITE_SERVER_URL || (import.meta.env.DEV ? `ws://${location.hostname}:8787` : null);
/** Через сколько миллисекунд пробовать снова, если связь пропала. */
const RETRY = 2000;

/** Есть ли связь: подключаемся (сервер может просыпаться до минуты), на связи или нет связи. */
export type LinkState = 'connecting' | 'online' | 'offline' | 'waiting';

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
  /** Связь появилась или пропала. */
  state: (state: LinkState) => void;
};

/**
 * Подключает доску к серверу. Возвращает функцию, которая отправляет свои изменения.
 * Пока связи нет (сервер просыпается или пропал), изменения копятся и уходят после подключения:
 * сервер присылает свою доску, к ней сверху применяются накопленные изменения.
 */
export function connect(room: string, on: Handlers): (op: Op) => void {
  let ws: WebSocket | null = null;
  /** Были ли уже на связи: до первого раза это «подключение…» (сервер просыпается), потом — «нет связи». */
  let wasOnline = false;
  /** Сервер прислал доску в этом соединении: теперь изменения можно слать сразу. */
  let synced = false;
  /** Изменения, которые ещё не дошли до сервера. */
  const pending: Op[] = [];
  /**
   * Изменения, уехавшие внутри своей доски (seed). Если другая вкладка успела раньше,
   * сервер ответит своей доской — тогда их надо применить к ней заново.
   */
  let seeded: Op[] = [];

  const send = (msg: object) => ws!.send(JSON.stringify(msg));

  function open(): void {
    if (!SERVER) return;
    ws = new WebSocket(`${SERVER}/?board=${encodeURIComponent(room)}`);
    synced = false;
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
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
        for (const op of unsent) send({ type: 'op', op });
      } else if (msg.type === 'op') {
        seeded = []; // сервер уже живёт с нашей доской
        on.op(msg.op);
      }
      // На связи мы, когда сервер прислал доску (или сказал, что её нет), а не когда открылось соединение.
      if (msg.type === 'empty' || msg.type === 'init') {
        synced = true;
        wasOnline = true;
        on.state('online');
      }
    };
    ws.onclose = () => {
      synced = false;
      // Не знаем, дошла ли своя доска до сервера, — на всякий случай пошлём её изменения снова.
      pending.unshift(...seeded.splice(0));
      on.state(wasOnline ? 'offline' : 'connecting');
      setTimeout(open, RETRY);
    };
  }

  if (SERVER) on.state('connecting');
  open();
  return (op) => {
    if (!SERVER) return;
    if (synced && ws?.readyState === WebSocket.OPEN) send({ type: 'op', op });
    else pending.push(op);
  };
}
