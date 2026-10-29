/**
 * Сервер Tiza: у каждой доски своя комната. Кто открыл доску, получает её целиком,
 * а дальше каждое изменение одной вкладки сервер пересылает остальным в той же комнате.
 * Пока доски живут в памяти сервера и пропадают при его перезапуске.
 */
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { applyOp, type BoardData, type Op } from '../src/ops.ts';

const PORT = Number(process.env.PORT ?? 8787);

/** Сообщения между доской и сервером. */
type Message =
  | { type: 'init'; board: BoardData } // сервер → вкладка: вот доска целиком
  | { type: 'empty' } // сервер → вкладка: доски ещё нет, пришли свою
  | { type: 'seed'; board: BoardData } // вкладка → сервер: первая версия доски
  | { type: 'op'; op: Op }; // в обе стороны: одно изменение

const boards = new Map<string, BoardData>();
const rooms = new Map<string, Set<WebSocket>>();

const send = (ws: WebSocket, msg: Message) => ws.send(JSON.stringify(msg));

// Обычный запрос по адресу сервера отвечает «работает» — так его проверит и хостинг.
const http = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`Сервер Tiza работает. Открытых досок: ${rooms.size}.`);
});

// Картинки едут внутри изменений, поэтому сообщение может быть большим.
const wss = new WebSocketServer({ server: http, maxPayload: 10 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  const room = new URL(req.url ?? '/', 'http://localhost').searchParams.get('board');
  if (!room) return ws.close(1008, 'Нужен параметр board');

  if (!rooms.has(room)) rooms.set(room, new Set());
  const peers = rooms.get(room)!;
  peers.add(ws);

  const board = boards.get(room);
  send(ws, board ? { type: 'init', board } : { type: 'empty' });

  ws.on('message', (data) => {
    let msg: Message;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === 'seed') {
      // Две вкладки могли прислать доску одновременно: остаётся первая, второй отвечаем ею.
      const existing = boards.get(room);
      if (existing) return send(ws, { type: 'init', board: existing });
      boards.set(room, msg.board);
    } else if (msg.type === 'op') {
      const target = boards.get(room);
      if (target) applyOp(target, msg.op);
      for (const peer of peers) if (peer !== ws && peer.readyState === peer.OPEN) send(peer, msg);
    }
  });

  ws.on('close', () => {
    peers.delete(ws);
    if (peers.size === 0) rooms.delete(room);
  });
});

http.listen(PORT, () => console.log(`Сервер Tiza слушает порт ${PORT}`));
