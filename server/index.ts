/**
 * Сервер Tiza: у каждой доски своя комната. Кто открыл доску, получает её целиком,
 * а дальше каждое изменение одной вкладки сервер пересылает остальным в той же комнате.
 * Открытые доски живут в памяти, а в базу сохраняются через пару секунд после изменений
 * и когда из комнаты уходит последний человек.
 */
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { applyOp, type BoardData, type Op } from '../src/ops.ts';
import { loadBoard, saveBoard, storeName } from './store.ts';

const PORT = Number(process.env.PORT ?? 8787);
/** Сколько ждать после изменения, прежде чем писать в базу: подряд идущие правки сохраняются разом. */
const SAVE_DELAY = 2000;

/** Сообщения между доской и сервером. */
type Message =
  | { type: 'init'; board: BoardData } // сервер → вкладка: вот доска целиком
  | { type: 'empty' } // сервер → вкладка: доски ещё нет, пришли свою
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

// Обычный запрос по адресу сервера отвечает «работает» — так его проверит и хостинг.
const http = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`Сервер Tiza работает. Открытых досок: ${rooms.size}.`);
});

// Картинки едут внутри изменений, поэтому сообщение может быть большим.
const wss = new WebSocketServer({ server: http, maxPayload: 10 * 1024 * 1024 });

wss.on('connection', async (ws, req) => {
  const room = new URL(req.url ?? '/', 'http://localhost').searchParams.get('board');
  if (!room) return ws.close(1008, 'Нужен параметр board');

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
