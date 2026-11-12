/**
 * Сервер Tiza: у каждой доски своя комната. Кто открыл доску, получает её целиком,
 * а дальше каждое изменение одной вкладки сервер пересылает остальным в той же комнате.
 * Открытые доски живут в памяти, а в базу сохраняются через пару секунд после изменений
 * и когда из комнаты уходит последний человек.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { applyOp, type BoardData, type Laser, type Live, type Op } from '../src/ops.ts';
import {
  accountByKey,
  createAccount,
  deleteWorkspace,
  isRevoked,
  loadAccount,
  loadBoard,
  loadRoadmap,
  loadWorkspace,
  revokeKey,
  saveBoard,
  saveRoadmap,
  saveWorkspace,
  storeName,
  updateAccount,
  type Account,
} from './store.ts';
import {
  checkPassword,
  failed,
  hashPassword,
  Limiter,
  lockedFor,
  loginProblem,
  newKey,
  newRecovery,
  normalizeLogin,
  passwordProblem,
  recoveryHash,
  succeeded,
} from './auth.ts';

const PORT = Number(process.env.PORT ?? 8787);
/** Сколько ждать после изменения, прежде чем писать в базу: подряд идущие правки сохраняются разом. */
const SAVE_DELAY = 2000;
/**
 * Ключ доски - 22 случайных знака из ссылки учителя. Другие адреса не пускаем:
 * так никто не создаст доски с придуманными именами и не подберёт чужую.
 */
const ROOM = /^[A-Za-z0-9_-]{22}$/;

/** Сообщения между доской и сервером. */
type Message =
  | { type: 'init'; board: BoardData } // сервер → вкладка: вот доска целиком
  | { type: 'empty' } // сервер → вкладка: доски ещё нет, пришли свою
  | { type: 'missing' } // сервер → вкладка: ключ доски неверный, связи не будет
  | { type: 'seed'; board: BoardData } // вкладка → сервер: первая версия доски
  | { type: 'op'; op: Op } // в обе стороны: одно изменение
  | Laser // в обе стороны: точка лазерной указки, не сохраняется
  | Live // в обе стороны: линия или фигура, которую рисуют прямо сейчас, не сохраняется
  | { type: 'ack' } // сервер → вкладка: изменение принято (по порядку)
  | { type: 'ping' } // вкладка → сервер: связь жива?
  | { type: 'pong' } // сервер → вкладка: жива
  | { type: 'peers'; teacher: number; student: number }; // сервер → вкладка: кто ещё на этой доске

/** Открытые доски. Пока доска грузится из базы, здесь лежит обещание её загрузить. */
const boards = new Map<string, Promise<BoardData | null>>();
const rooms = new Map<string, Set<WebSocket>>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Кто открыл вкладку: учитель или ученик. Нужно, чтобы показать «ученик на связи». */
type Role = 'teacher' | 'student';
const roles = new WeakMap<WebSocket, Role>();

const send = (ws: WebSocket, msg: Message) => ws.send(JSON.stringify(msg));

/** Рассказывает каждой вкладке в комнате, сколько учителей и учеников там кроме неё. */
function announcePeers(peers: Set<WebSocket>): void {
  for (const ws of peers) {
    if (ws.readyState !== ws.OPEN) continue;
    const others = [...peers].filter((p) => p !== ws && p.readyState === p.OPEN);
    const count = (role: Role) => others.filter((p) => roles.get(p) === role).length;
    send(ws, { type: 'peers', teacher: count('teacher'), student: count('student') });
  }
}

function openBoard(room: string): Promise<BoardData | null> {
  if (!boards.has(room)) boards.set(room, loadBoard(room));
  return boards.get(room)!;
}

/**
 * Доски, изменённые на этом сервере и ещё не записанные в базу. Неизменённую доску не пишем:
 * серверов несколько, и другой мог уже записать в базу более свежую версию.
 */
const dirty = new Set<string>();

/** Сохраняет доску сейчас и отменяет отложенное сохранение. */
async function flush(room: string): Promise<void> {
  clearTimeout(saveTimers.get(room));
  saveTimers.delete(room);
  if (!dirty.delete(room)) return;
  const board = await boards.get(room);
  if (!board) return;
  try {
    await saveBoard(room, board);
  } catch (e) {
    dirty.add(room); // запишем при следующем сохранении
    console.error(`Не получилось сохранить доску ${room}:`, e);
  }
}

function saveLater(room: string): void {
  dirty.add(room);
  if (!saveTimers.has(room)) saveTimers.set(room, setTimeout(() => flush(room), SAVE_DELAY));
}

/* ---------- дорожные карты учеников ---------- */
// Учитель кладёт карту ученика по адресу /roadmap/<ключ ученика>, ученик её читает.
// Менять карту можно только ключом учителя: сервер запоминает его отпечаток при первой записи.

/** Карта - это названия тем и ключи досок, ей хватит и 100 КБ. */
const MAX_ROADMAP = 100 * 1024;

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

function reply(res: ServerResponse, status: number, body = '', type = 'text/plain; charset=utf-8'): void {
  // Сайт живёт на другом адресе (GitHub Pages), поэтому браузеру нужно разрешение читать ответ.
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, PUT, POST',
    'access-control-allow-headers': 'content-type, authorization',
  });
  res.end(body);
}

function readBody(req: IncomingMessage, limit = MAX_ROADMAP): Promise<string | null> {
  return new Promise((done) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        done(null);
        req.destroy();
      }
    });
    req.on('end', () => done(body));
  });
}

async function roadmap(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  if (!ROOM.test(id)) return reply(res, 404, 'Нет такой карты');
  const stored = await loadRoadmap(id);
  if (req.method === 'GET') {
    return stored ? reply(res, 200, stored.data, 'application/json') : reply(res, 404, 'Нет такой карты');
  }
  if (req.method !== 'PUT') return reply(res, 405);
  const key = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  if (!ROOM.test(key) || (stored && stored.writeHash !== hash(key))) return reply(res, 403, 'Нет доступа');
  const body = await readBody(req);
  if (body === null) return reply(res, 413, 'Слишком большая карта');
  try {
    JSON.parse(body);
  } catch {
    return reply(res, 400, 'Это не карта');
  }
  await saveRoadmap(id, body, hash(key));
  reply(res, 204);
}

/* ---------- список учеников учителя ---------- */
// Учитель хранит на сервере свой список учеников с ключами досок и карт:
// так он открывается в любом браузере по ссылке входа. Ключ учителя приходит в заголовке,
// а в базе список лежит под отпечатком ключа.

/** Список учеников - имена, темы и ключи, ему хватит и мегабайта. */
const MAX_WORKSPACE = 1024 * 1024;

const workspaceId = (key: string) => hash(`workspace:${key}`);

async function workspace(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const key = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  if (!ROOM.test(key)) return reply(res, 403, 'Нет доступа');
  const id = workspaceId(key);
  // Пароль сменили: старый ключ на этом устройстве больше не работает, надо войти заново.
  if (await isRevoked(id)) return reply(res, 401, 'Войдите заново');
  if (req.method === 'GET') {
    const stored = await loadWorkspace(id);
    return stored ? reply(res, 200, stored, 'application/json') : reply(res, 404, 'Списка ещё нет');
  }
  if (req.method !== 'PUT') return reply(res, 405);
  const body = await readBody(req, MAX_WORKSPACE);
  if (body === null) return reply(res, 413, 'Слишком большой список');
  try {
    JSON.parse(body);
  } catch {
    return reply(res, 400, 'Это не список');
  }
  await saveWorkspace(id, body);
  reply(res, 204);
}

/* ---------- вход и регистрация ---------- */
// Учитель входит логином и паролем и получает ключ к своему списку учеников.
// Почту не храним: забытый пароль сбрасывается ключом восстановления.

const json = (res: ServerResponse, status: number, body: object) => reply(res, status, JSON.stringify(body), 'application/json');
const problem = (res: ServerResponse, status: number, error: string) => json(res, status, { error });

/** Адрес того, кто спрашивает. Хостинг стоит перед сервером, поэтому настоящий адрес - в заголовке. */
function clientIp(req: IncomingMessage): string {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || '?';
}

/**
 * С одного адреса: 5 новых учётных записей в час (считаются только удачные регистрации,
 * опечатки и занятые логины - нет), 30 попыток регистрации и 30 входов за 15 минут,
 * 10 восстановлений в час.
 */
const registerLimit = new Limiter(5, 60 * 60 * 1000);
const registerTries = new Limiter(30, 15 * 60 * 1000);
const loginLimit = new Limiter(30, 15 * 60 * 1000);
const recoverLimit = new Limiter(10, 60 * 60 * 1000);
const checkLimit = new Limiter(60, 60 * 1000);
const SLOW = 'Слишком много попыток. Подождите немного и попробуйте снова.';

/**
 * Новый ключ к списку учеников: список переезжает под новый ключ, старый отзывается.
 * Так после смены пароля все остальные устройства выходят из учётной записи.
 */
async function rotateKey(a: Account): Promise<string> {
  const oldId = workspaceId(a.workspaceKey);
  const key = newKey();
  const data = await loadWorkspace(oldId);
  if (data) await saveWorkspace(workspaceId(key), data);
  a.workspaceKey = key;
  await updateAccount(a);
  await revokeKey(oldId);
  if (data) await deleteWorkspace(oldId);
  return key;
}

async function auth(req: IncomingMessage, res: ServerResponse, action: string): Promise<void> {
  const ip = clientIp(req);
  if (action === 'available' && req.method === 'GET') {
    if (!checkLimit.allow(ip)) return problem(res, 429, SLOW);
    const login = normalizeLogin(new URL(req.url ?? '/', 'http://localhost').searchParams.get('login'));
    if (loginProblem(login)) return json(res, 200, { free: false });
    return json(res, 200, { free: !(await loadAccount(login)) });
  }
  if (req.method !== 'POST') return reply(res, 405);
  const raw = await readBody(req, 4096);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw ?? '');
  } catch {
    return problem(res, 400, 'Непонятный запрос.');
  }
  const login = normalizeLogin(body.login);

  if (action === 'register') {
    // Поле-ловушка: человек его не видит и не заполняет, а бот заполняет все поля подряд.
    if (body.website) return problem(res, 400, 'Не получилось зарегистрироваться.');
    if (registerLimit.full(ip) || !registerTries.allow(ip)) return problem(res, 429, SLOW);
    const bad = loginProblem(login) ?? passwordProblem(body.password);
    if (bad) return problem(res, 400, bad);
    if (await loadAccount(login)) return problem(res, 409, 'Такой логин уже занят.');
    // Ключ из браузера - список учеников, который у учителя уже есть: он переходит в учётную запись.
    // Чужой (уже привязанный) или отозванный ключ не берём.
    const own = typeof body.key === 'string' && ROOM.test(body.key) ? body.key : null;
    const usable = own && !(await accountByKey(own)) && !(await isRevoked(workspaceId(own)));
    const recovery = newRecovery();
    const a: Account = {
      login,
      passHash: await hashPassword(body.password as string),
      recoveryHash: recoveryHash(recovery),
      workspaceKey: usable ? own : newKey(),
    };
    if (!(await createAccount(a))) return problem(res, 409, 'Такой логин уже занят.');
    registerLimit.count(ip);
    return json(res, 200, { login, key: a.workspaceKey, recovery });
  }

  if (action === 'login') {
    if (!loginLimit.allow(ip)) return problem(res, 429, SLOW);
    const wait = lockedFor(login);
    if (wait) return problem(res, 429, `Слишком много неверных паролей. Попробуйте через ${Math.ceil(wait / 60)} мин.`);
    const a = await loadAccount(login);
    if (!a || typeof body.password !== 'string' || !(await checkPassword(body.password, a.passHash))) {
      failed(login);
      return problem(res, 401, 'Неверный логин или пароль.');
    }
    succeeded(login);
    return json(res, 200, { login, key: a.workspaceKey });
  }

  if (action === 'recover') {
    if (!recoverLimit.allow(ip)) return problem(res, 429, SLOW);
    const bad = passwordProblem(body.password);
    if (bad) return problem(res, 400, bad);
    const a = await loadAccount(login);
    if (!a || recoveryHash(body.recovery) !== a.recoveryHash) return problem(res, 401, 'Неверный логин или ключ восстановления.');
    // Ключ восстановления одноразовый: использовали - выдаём новый.
    const recovery = newRecovery();
    a.passHash = await hashPassword(body.password as string);
    a.recoveryHash = recoveryHash(recovery);
    const key = await rotateKey(a);
    return json(res, 200, { login, key, recovery });
  }

  if (action === 'password') {
    if (!loginLimit.allow(ip)) return problem(res, 429, SLOW);
    const wait = lockedFor(login);
    if (wait) return problem(res, 429, `Слишком много неверных паролей. Попробуйте через ${Math.ceil(wait / 60)} мин.`);
    const bad = passwordProblem(body.newPassword);
    if (bad) return problem(res, 400, bad);
    const a = await loadAccount(login);
    if (!a || typeof body.password !== 'string' || !(await checkPassword(body.password, a.passHash))) {
      failed(login);
      return problem(res, 401, 'Неверный текущий пароль.');
    }
    a.passHash = await hashPassword(body.newPassword as string);
    const key = await rotateKey(a);
    return json(res, 200, { login, key });
  }

  reply(res, 404);
}

// Обычный запрос по адресу сервера отвечает «работает» - так его проверит и хостинг.
const http = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return reply(res, 204);
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path.startsWith('/roadmap/')) {
    try {
      await roadmap(req, res, path.slice('/roadmap/'.length));
    } catch (e) {
      console.error('Ошибка дорожной карты:', e);
      reply(res, 500, 'Ошибка базы');
    }
    return;
  }
  if (path.startsWith('/auth/')) {
    try {
      await auth(req, res, path.slice('/auth/'.length));
    } catch (e) {
      console.error('Ошибка входа:', e);
      problem(res, 500, 'Ошибка сервера. Попробуйте ещё раз.');
    }
    return;
  }
  if (path === '/workspace') {
    try {
      await workspace(req, res);
    } catch (e) {
      console.error('Ошибка списка учеников:', e);
      reply(res, 500, 'Ошибка базы');
    }
    return;
  }
  reply(res, 200, `Сервер Tiza работает. Открытых досок: ${rooms.size}.`);
});

// Картинки едут внутри изменений, поэтому сообщение может быть большим.
const wss = new WebSocketServer({ server: http, maxPayload: 10 * 1024 * 1024 });

/**
 * Вкладки стучатся раз в 10 секунд. Кто молчит минуту, тот уже не с нами (закрыли ноутбук,
 * пропал интернет): закрываем, чтобы комната не держала мёртвые соединения.
 */
const lastSeen = new WeakMap<WebSocket, number>();
setInterval(() => {
  for (const ws of wss.clients) if (Date.now() - (lastSeen.get(ws) ?? 0) > 60_000) ws.terminate();
}, 30_000).unref();

wss.on('connection', async (ws, req) => {
  lastSeen.set(ws, Date.now());
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const room = query.get('board');
  roles.set(ws, query.get('role') === 'student' ? 'student' : 'teacher');
  if (!room || !ROOM.test(room)) {
    // Код закрытия хостинг может потерять по дороге, поэтому сначала говорим словами.
    send(ws, { type: 'missing' });
    return ws.close(1008, 'Нет такой доски');
  }

  if (!rooms.has(room)) rooms.set(room, new Set());
  const peers = rooms.get(room)!;
  peers.add(ws);

  // Сообщения могут прийти, пока доска ещё грузится, - каждое сначала ждёт загрузки.
  const ready = openBoard(room);

  ws.on('message', async (data) => {
    lastSeen.set(ws, Date.now());
    let msg: Message;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    const board = await ready.catch(() => null);
    if (msg.type === 'seed') {
      // Две вкладки могли прислать доску одновременно: остаётся первая, второй отвечаем ею.
      const existing = await boards.get(room);
      if (existing) return send(ws, { type: 'init', board: existing });
      boards.set(room, Promise.resolve(msg.board));
      saveLater(room);
      // Ученик мог открыть доску раньше учителя и ждёт её.
      for (const peer of peers) if (peer !== ws && peer.readyState === peer.OPEN) send(peer, { type: 'init', board: msg.board });
    } else if (msg.type === 'ping') {
      send(ws, { type: 'pong' });
    } else if (msg.type === 'laser' || msg.type === 'live') {
      for (const peer of peers) if (peer !== ws && peer.readyState === peer.OPEN) send(peer, msg);
    } else if (msg.type === 'op') {
      const target = (await boards.get(room)) ?? board;
      if (target) {
        applyOp(target, msg.op);
        saveLater(room);
      }
      for (const peer of peers) if (peer !== ws && peer.readyState === peer.OPEN) send(peer, msg);
      send(ws, { type: 'ack' });
    }
  });

  ws.on('close', async () => {
    peers.delete(ws);
    announcePeers(peers);
    if (peers.size > 0) return;
    rooms.delete(room);
    // Последний ушёл: сохраняем и убираем доску из памяти, если за это время никто не пришёл.
    await flush(room);
    if (!rooms.has(room)) boards.delete(room);
  });

  try {
    const board = await ready;
    send(ws, board ? { type: 'init', board } : { type: 'empty' });
    announcePeers(peers);
  } catch (e) {
    console.error(`Не получилось открыть доску ${room}:`, e);
    ws.close(1011, 'Ошибка базы');
  }
});

// Хостинг перезапускает сервер сигналом SIGTERM: сначала дописываем несохранённое.
async function shutdown(): Promise<void> {
  await Promise.all([...saveTimers.keys()].map(flush));
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

http.listen(PORT, () => console.log(`Сервер Tiza слушает порт ${PORT}, доски хранятся: ${storeName}`));
