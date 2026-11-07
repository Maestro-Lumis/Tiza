/**
 * Сервер Tiza: у каждой доски своя комната. Кто открыл доску, получает её целиком,
 * а дальше каждое изменение одной вкладки сервер пересылает остальным в той же комнате.
 * Открытые доски живут в памяти, а в базу сохраняются через пару секунд после изменений
 * и когда из комнаты уходит последний человек.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { applyOp, type BoardData, type Op } from '../src/ops.ts';
import { loadBoard, loadRoadmap, saveBoard, saveRoadmap, storeName } from './store.ts';

const PORT = Number(process.env.PORT ?? 8787);
/** Сколько ждать после изменения, прежде чем писать в базу: подряд идущие правки сохраняются разом. */
const SAVE_DELAY = 2000;
/**
 * Ключ доски — 22 случайных знака из ссылки учителя. Другие адреса не пускаем:
 * так никто не создаст доски с придуманными именами и не подберёт чужую.
 */
const ROOM = /^[A-Za-z0-9_-]{22}$/;

/** Сообщения между доской и сервером. */
type Message =
  | { type: 'init'; board: BoardData } // сервер → вкладка: вот доска целиком
  | { type: 'empty' } // сервер → вкладка: доски ещё нет, пришли свою
  | { type: 'missing' } // сервер → вкладка: ключ доски неверный, связи не будет
  | { type: 'seed'; board: BoardData } // вкладка → сервер: первая версия доски
  | { type: 'op'; op: Op }; // в обе стороны: одно изменение

/** Открытые доски. Пока доска грузится из базы, здесь лежит обещание её загрузить. */
const boards = new Map<string, Promise<BoardData | null>>();
const rooms = new Map<string, Set<WebSocket>>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

const send = (ws: WebSocket, msg: Message) => ws.send(JSON.stringify(msg));

function openBoard(room: string): Promise<BoardData | null> {
  if (!boards.has(room)) boards.set(room, loadBoard(room));
  return boards.get(room)!;
}

/** Сохраняет доску сейчас и отменяет отложенное сохранение. */
async function flush(room: string): Promise<void> {
  clearTimeout(saveTimers.get(room));
  saveTimers.delete(room);
  const board = await boards.get(room);
  if (!board) return;
  try {
    await saveBoard(room, board);
  } catch (e) {
    console.error(`Не получилось сохранить доску ${room}:`, e);
  }
}

function saveLater(room: string): void {
  if (!saveTimers.has(room)) saveTimers.set(room, setTimeout(() => flush(room), SAVE_DELAY));
}

/* ---------- дорожные карты учеников ---------- */
// Учитель кладёт карту ученика по адресу /roadmap/<ключ ученика>, ученик её читает.
// Менять карту можно только ключом учителя: сервер запоминает его отпечаток при первой записи.

/** Карта — это названия тем и ключи досок, ей хватит и 100 КБ. */
const MAX_ROADMAP = 100 * 1024;

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

function reply(res: ServerResponse, status: number, body = '', type = 'text/plain; charset=utf-8'): void {
  // Сайт живёт на другом адресе (GitHub Pages), поэтому браузеру нужно разрешение читать ответ.
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, PUT',
    'access-control-allow-headers': 'content-type, authorization',
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((done) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_ROADMAP) {
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

// Обычный запрос по адресу сервера отвечает «работает» — так его проверит и хостинг.
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
  reply(res, 200, `Сервер Tiza работает. Открытых досок: ${rooms.size}.`);
});

// Картинки едут внутри изменений, поэтому сообщение может быть большим.
const wss = new WebSocketServer({ server: http, maxPayload: 10 * 1024 * 1024 });

wss.on('connection', async (ws, req) => {
  const room = new URL(req.url ?? '/', 'http://localhost').searchParams.get('board');
  if (!room || !ROOM.test(room)) {
    // Код закрытия хостинг может потерять по дороге, поэтому сначала говорим словами.
    send(ws, { type: 'missing' });
    return ws.close(1008, 'Нет такой доски');
  }

  if (!rooms.has(room)) rooms.set(room, new Set());
  const peers = rooms.get(room)!;
  peers.add(ws);

  // Сообщения могут прийти, пока доска ещё грузится, — каждое сначала ждёт загрузки.
  const ready = openBoard(room);

  ws.on('message', async (data) => {
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
    } else if (msg.type === 'op') {
      const target = (await boards.get(room)) ?? board;
      if (target) {
        applyOp(target, msg.op);
        saveLater(room);
      }
      for (const peer of peers) if (peer !== ws && peer.readyState === peer.OPEN) send(peer, msg);
    }
  });

  ws.on('close', async () => {
    peers.delete(ws);
    if (peers.size > 0) return;
    rooms.delete(room);
    // Последний ушёл: сохраняем и убираем доску из памяти, если за это время никто не пришёл.
    await flush(room);
    if (!rooms.has(room)) boards.delete(room);
  });

  try {
    const board = await ready;
    send(ws, board ? { type: 'init', board } : { type: 'empty' });
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
