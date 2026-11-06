/// <reference types="vite/client" />
import type { BoardData, Op } from './ops';

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
export type LinkState = 'connecting' | 'online' | 'offline';

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
  /** Своя доска целиком: её просит сервер, если доски у него ещё нет. */
  local: () => BoardData;
  /** Доска с сервера целиком: заменяет то, что было в вкладке. */
  init: (board: BoardData) => void;
  /** Изменение от другой вкладки или ученика. */
  op: (op: Op) => void;
  /** Связь появилась или пропала. */
  state: (state: LinkState) => void;
};

/** Подключает доску к серверу. Возвращает функцию, которая отправляет свои изменения. */
export function connect(room: string, on: Handlers): (op: Op) => void {
  let ws: WebSocket | null = null;
  /** Были ли уже на связи: до первого раза это «подключение…» (сервер просыпается), потом — «нет связи». */
  let wasOnline = false;

  function open(): void {
    if (!SERVER) return;
    ws = new WebSocket(`${SERVER}/?board=${encodeURIComponent(room)}`);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      // На связи мы, когда сервер прислал доску (или сказал, что её нет), а не когда открылось соединение.
      if (msg.type === 'empty' || msg.type === 'init') {
        wasOnline = true;
        on.state('online');
      }
      if (msg.type === 'empty') ws!.send(JSON.stringify({ type: 'seed', board: on.local() }));
      else if (msg.type === 'init') on.init(msg.board);
      else if (msg.type === 'op') on.op(msg.op);
    };
    ws.onclose = () => {
      on.state(wasOnline ? 'offline' : 'connecting');
      setTimeout(open, RETRY);
    };
  }

  if (SERVER) on.state('connecting');
  open();
  return (op) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'op', op }));
  };
}
