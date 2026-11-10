/// <reference types="vite/client" />
import { applyOp, type BoardData, type Laser, type Op } from './ops';
import { roadmapOf, type Roadmap, type Student } from './students';

/**
 * Серверов может быть несколько: например, в России и в Германии. Все хранят доски в одной базе,
 * поэтому подключаться можно к любому. Список берётся из .env:
 *   VITE_SERVERS=РФ=wss://…,Render=wss://…
 * Сайт идёт к первому, кто ответит, по одному и тому же порядку у всех: так учитель и ученик
 * оказываются на одном сервере и видят рисование друг друга сразу.
 * Старая настройка VITE_SERVER_URL с одним адресом тоже работает. Без неё на localhost -
 * свой сервер (npm run server). VITE_-значения видны всем в коде сайта: там только адреса.
 */
export type Server = { name: string; url: string };

function readServers(): Server[] {
  const list = (import.meta.env.VITE_SERVERS ?? '')
    .split(',')
    .map((item: string) => item.trim())
    .filter(Boolean)
    .map((item: string, i: number): Server => {
      const eq = item.indexOf('=');
      return eq > 0 ? { name: item.slice(0, eq).trim(), url: item.slice(eq + 1).trim() } : { name: `Сервер ${i + 1}`, url: item };
    });
  if (list.length) return list;
  const one = import.meta.env.VITE_SERVER_URL || (import.meta.env.DEV ? `ws://${location.hostname}:8787` : '');
  return one ? [{ name: 'Сервер', url: one }] : [];
}

export const SERVERS = readServers();

/** Через сколько миллисекунд пробовать снова, если связь пропала. */
const RETRY = 2000;
/**
 * Раз в сколько миллисекунд проверяем, что связь жива, и сколько ждём ответа.
 * Соединение может умереть молча (заснул Wi-Fi, хостинг оборвал): браузер узнает об этом
 * только через минуту, а изменения всё это время улетали бы в пустоту.
 */
const PING = 10000;
const SILENCE = 25000;
/**
 * Сколько ждать сервер, прежде чем идти к следующему в списке. Последний ждём сколько надо:
 * бесплатный сервер просыпается до минуты.
 */
const SWITCH_AFTER = 8000;
/** Раз в сколько миллисекунд проверять, не ожил ли первый сервер, пока сидим на запасном. */
const BACK_CHECK = 30000;

/** Есть ли связь: подключаемся (сервер может просыпаться до минуты), на связи или нет связи. */
export type LinkState = 'connecting' | 'online' | 'offline' | 'waiting' | 'missing';

/** Сервер подключён: значок связи на доске имеет смысл показывать. */
export const hasServer = SERVERS.length > 0;

/* ---------- какой сервер выбран ---------- */

/** Выбранный вручную сервер лежит в браузере; нет его - «Авто», по порядку списка. */
const CHOICE = 'tiza:server';

export function chosenServer(): string | null {
  try {
    const name = localStorage.getItem(CHOICE);
    return SERVERS.some((s) => s.name === name) ? name : null;
  } catch {
    return null;
  }
}

export function chooseServer(name: string | null): void {
  try {
    if (name) localStorage.setItem(CHOICE, name);
    else localStorage.removeItem(CHOICE);
  } catch {
    // Хранилище недоступно: выбор действует до перезагрузки.
  }
}

/** Серверы в том порядке, в каком к ним идти: выбранный вручную - первым. */
function ordered(): Server[] {
  const name = chosenServer();
  return name ? [...SERVERS.filter((s) => s.name === name), ...SERVERS.filter((s) => s.name !== name)] : SERVERS;
}

const httpOf = (server: Server) => server.url.replace(/^ws/, 'http');

/**
 * Обычный запрос к серверу (карта ученика, список учеников): идём по порядку,
 * пока кто-нибудь не ответит. База общая, поэтому ответ любого сервера годится.
 */
export async function serverFetch(path: string, init: RequestInit = {}): Promise<Response | null> {
  const list = ordered();
  for (const [i, server] of list.entries()) {
    try {
      const last = i === list.length - 1;
      return await fetch(httpOf(server) + path, last ? init : { ...init, signal: AbortSignal.timeout(SWITCH_AFTER) });
    } catch {
      // Этот сервер не ответил: пробуем следующий.
    }
  }
  return null;
}

/**
 * Будит серверы заранее. Бесплатный сервер засыпает без посетителей и просыпается до минуты,
 * поэтому стучимся к нему уже со списка учеников - к открытию доски он успеет проснуться.
 */
export function wakeServer(): void {
  for (const server of SERVERS) fetch(httpOf(server), { mode: 'no-cors' }).catch(() => {});
}

/** Задержка до сервера в миллисекундах или null, если он не ответил. */
export async function probe(server: Server): Promise<number | null> {
  const ask = () => fetch(httpOf(server), { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  try {
    // Первый запрос ещё и открывает соединение, поэтому меряем второй.
    await ask();
    const start = performance.now();
    await ask();
    return Math.round(performance.now() - start);
  } catch {
    return null;
  }
}

/** Что показать в окошке связи: сервер, задержка и кто ещё на доске. */
export type LinkInfo = {
  server: Server | null;
  /** Задержка до сервера, мс; null - ещё не мерили. */
  rtt: number | null;
  /** Сколько учителей и учеников на доске кроме этой вкладки; null - сервер не сообщил. */
  others: { teacher: number; student: number } | null;
};

type Handlers = {
  /**
   * Своя доска целиком: её просит сервер, если доски у него ещё нет.
   * null - своей доски нет (ученик): ждём, пока доску откроет учитель.
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
  /** Сменился сервер, задержка или кто ещё на доске. */
  info: (info: LinkInfo) => void;
};

/** Связь доски с сервером: отправить изменение, точку лазера, переподключиться после смены сервера. */
export type Link = { send: (op: Op) => void; laser: (point: Laser) => void; reconnect: () => void };

/**
 * Подключает доску к серверу. Пока связи нет (сервер просыпается или пропал), изменения копятся
 * и уходят после подключения: сервер присылает свою доску, к ней сверху применяются накопленные.
 * Сервер не ответил - идём к следующему по списку; сидим на запасном - время от времени
 * проверяем, не ожил ли первый, и возвращаемся к нему.
 * Без ключа доски (общая доска без ученика) связи нет: доска живёт только в браузере.
 */
export function connect(room: string | null, role: 'teacher' | 'student', on: Handlers): Link {
  let servers = room ? ordered() : [];
  /** К какому серверу из списка подключаемся сейчас. */
  let index = 0;
  /** К какому серверу идти после обрыва; null - решим по тому, был ли этот на связи. */
  let next: number | null = null;
  let ws: WebSocket | null = null;
  /** Были ли уже на связи: до первого раза это «подключение…» (сервер просыпается), потом - «нет связи». */
  let wasOnline = false;
  /** Сервер прислал доску в этом соединении: теперь изменения можно слать сразу. */
  let synced = false;
  /** Сервер сказал, что такой доски нет: больше не стучимся. */
  let missing = false;
  /** Изменения, которые ещё не дошли до сервера. */
  const pending: Op[] = [];
  /**
   * Изменения, уехавшие внутри своей доски (seed). Если другая вкладка успела раньше,
   * сервер ответит своей доской - тогда их надо применить к ней заново.
   */
  let seeded: Op[] = [];
  /** Отправленные изменения, которые сервер ещё не подтвердил. Если связь оборвётся - пошлём снова. */
  let unacked: Op[] = [];
  /** Когда сервер последний раз что-то присылал и когда ушёл последний ping. */
  let heard = 0;
  let pingAt = 0;
  let pinger: ReturnType<typeof setInterval> | undefined;
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const info: LinkInfo = { server: null, rtt: null, others: null };

  const send = (msg: object) => ws!.send(JSON.stringify(msg));

  function ping(): void {
    if (ws?.readyState !== WebSocket.OPEN) return;
    pingAt = performance.now();
    send({ type: 'ping' });
  }

  function open(): void {
    if (!room || !servers.length) return;
    const server = servers[index];
    ws = new WebSocket(`${server.url}/?${new URLSearchParams({ board: room, role })}`);
    synced = false;
    heard = Date.now();
    Object.assign(info, { server, rtt: null, others: null });
    on.info(info);
    clearInterval(pinger);
    pinger = setInterval(() => {
      if (Date.now() - heard > SILENCE) return drop();
      ping();
    }, PING);
    // Не последний в списке и молчит: не ждём его, идём к следующему.
    clearTimeout(giveUp);
    if (index < servers.length - 1) giveUp = setTimeout(() => !synced && drop(), SWITCH_AFTER);
    ws.onmessage = (e) => {
      heard = Date.now();
      const msg = JSON.parse(e.data);
      if (msg.type === 'pong') {
        info.rtt = Math.round(performance.now() - pingAt);
        return on.info(info);
      }
      if (msg.type === 'peers') {
        info.others = { teacher: msg.teacher, student: msg.student };
        return on.info(info);
      }
      if (msg.type === 'ack') return void unacked.shift();
      if (msg.type === 'missing') {
        missing = true;
        return on.state('missing');
      }
      if (msg.type === 'empty') {
        // Сервер ответил, доски у него пока нет: к другому серверу уходить незачем.
        clearTimeout(giveUp);
        const board = on.local();
        if (!board) {
          ping();
          return on.state('waiting'); // сервер пришлёт доску, когда её откроет учитель
        }
        // На сервере доски нет: шлём свою, накопленное в ней уже есть.
        seeded = pending.splice(0);
        send({ type: 'seed', board });
      } else if (msg.type === 'init') {
        // Доска сервера + всё, что сделали без связи, - показываем и досылаем.
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
        clearTimeout(giveUp);
        synced = true;
        wasOnline = true;
        on.state('online');
        ping();
      }
    };
    ws.onclose = (e) => closed(e.code);
  }

  function closed(code?: number): void {
    const wasSynced = synced;
    synced = false;
    clearInterval(pinger);
    clearTimeout(giveUp);
    // Сервер не пустил: ключ доски неверный, пробовать снова бесполезно.
    if (missing || code === 1008) return on.state('missing');
    // Не знаем, дошли ли своя доска и последние изменения, - на всякий случай пошлём их снова.
    pending.unshift(...seeded.splice(0), ...unacked.splice(0));
    // Работавший сервер оборвался - начинаем снова с первого; не ответил - идём к следующему.
    index = next ?? (wasSynced ? 0 : (index + 1) % servers.length);
    next = null;
    Object.assign(info, { rtt: null, others: null });
    on.info(info);
    on.state(wasOnline ? 'offline' : 'connecting');
    setTimeout(open, index === 0 && !wasSynced ? RETRY : 0);
  }

  /** Связь молчит слишком долго: не ждём, пока браузер заметит обрыв, а переподключаемся сами. */
  function drop(): void {
    if (!ws) return;
    ws.onclose = null;
    ws.onmessage = null;
    ws.close();
    closed();
  }

  // Сидим на запасном сервере: проверяем, не ожил ли первый, и возвращаемся к нему,
  // чтобы снова оказаться на одном сервере с учеником.
  if (servers.length > 1) {
    setInterval(async () => {
      if (!synced || index === 0) return;
      if ((await probe(servers[0])) !== null && synced && index !== 0) {
        next = 0;
        drop();
      }
    }, BACK_CHECK);
  }

  function sendOp(op: Op): void {
    unacked.push(op);
    send({ type: 'op', op });
  }

  if (servers.length) on.state('connecting');
  open();
  return {
    send(op) {
      if (!servers.length) return;
      if (synced && ws?.readyState === WebSocket.OPEN) sendOp(op);
      else pending.push(op);
    },
    // Лазер без связи не копим: через минуту старый след уже никому не нужен.
    laser(point) {
      if (synced && ws?.readyState === WebSocket.OPEN) send(point);
    },
    /** Выбор сервера сменился: подключаемся заново по новому порядку. */
    reconnect() {
      if (!servers.length) return;
      servers = ordered();
      next = 0;
      wasOnline = false;
      drop();
    },
  };
}

/* ---------- дорожная карта ученика ---------- */

/** Кладёт карту ученика на сервер, чтобы он видел новые темы по своей ссылке. */
export async function publishRoadmap(share: { read: string; write: string }, roadmap: Roadmap): Promise<boolean> {
  const res = await serverFetch(`/roadmap/${share.read}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${share.write}` },
    body: JSON.stringify(roadmap),
  });
  return res?.ok ?? false;
}

/** Если у ученика уже есть ссылка, обновляем его карту на сервере (новая тема, статус, имя). */
export function syncRoadmap(student: Student | undefined): void {
  if (student?.share) void publishRoadmap(student.share, roadmapOf(student));
}

/** Карта ученика по ключу из его ссылки; null - такой нет или сервер недоступен. */
export async function fetchRoadmap(key: string): Promise<Roadmap | 'missing' | null> {
  const res = await serverFetch(`/roadmap/${encodeURIComponent(key)}`);
  if (!res) return null;
  if (res.status === 404) return 'missing';
  try {
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
