import { backgroundOf, contains, imageElement, readImage, rectOf, type BoardImage, type Rect } from './images';
import { boardKey, getStudent, topicRoom } from './students';
import { boundsOf, defaultSize, drawShape, type Shape, type ShapeKind } from './shapes';
import { readDocx, splitTasks } from './tasks';
import { applyOp, LISTS, type BoardData, type Item, type Laser, type ListName, type Op, type Wipe } from './ops';
import { connect, hasServer, type LinkState } from './sync';
import { readBoard, writeBoard } from './local';
import { downloadNotebook } from './notebook';
import './theme';

type Point = { x: number; y: number };
type Stroke = { id: string; color: string; points: Point[] };
type Tool = 'pen' | 'eraser' | 'pointer' | 'laser' | 'shape' | 'select';
/** Карточка задания из Word. Высота считается по тексту при отрисовке. */
/** s — масштаб: карточку можно увеличить или уменьшить целиком, вместе с текстом. */
type Card = { id: string; x: number; y: number; w: number; h: number; s?: number; title: string; text: string; wipes?: Wipe[] };
/** Место и размер предмета, у карточки ещё и масштаб: так их запоминает история. */
type Box = Rect & { s?: number };
/** То, что указка умеет двигать: картинка или карточка. */
type Movable = BoardImage | Card | Shape;
/**
 * Одно действие для истории:
 * линии, картинки или карточки добавили / стёрли, либо что-то сдвинули или изменили размер.
 */
type Change =
  | { kind: 'add' | 'remove'; strokes: Stroke[]; images?: BoardImage[]; cards?: Card[]; shapes?: Shape[] }
  | { kind: 'move'; image: Movable; from: Box; to: Box }
  | { kind: 'erase'; removed: Stroke[]; added: Stroke[]; wipes: { item: Movable; wipe: Wipe }[] };

/** Радиус губки в пикселях экрана: такой, чтобы стереть одну букву. */
const ERASER_RADIUS = 8;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;
/** Размер уголка для изменения размера картинки — в пикселях экрана. */
const HANDLE = 12;
/** Меньше этой ширины картинку не сжать. */
const MIN_IMAGE = 24;
/** Карточки заданий: ширина по умолчанию, самая узкая, отступы и шрифт — в координатах доски. */
const CARD_WIDTH = 420;
const MIN_CARD = 200;
/** Во сколько раз карточку можно уменьшить и увеличить. */
const MIN_CARD_SCALE = 0.4;
const MAX_CARD_SCALE = 4;
const CARD_PAD = 16;
const CARD_GAP = 24;
const CARD_LINE = 26;
/** Таблица в карточке: шрифт помельче, высота строки и отступ текста от линий ячейки. */
const TABLE_LINE = 22;
const CELL_PAD = 8;
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
/** Сколько миллисекунд живёт след лазерной указки. */
const LASER_LIFE = 900;
/** Чья это доска и какой темы: board.html?student=andrey&topic=… */
const params = new URLSearchParams(location.search);
const studentId = params.get('student');
const topicId = params.get('topic');
/**
 * Ключ, под которым доска лежит в хранилище браузера: у каждой темы свой.
 * Без ученика и темы открывается старая общая доска.
 */
/** Ученик открывает доску по ссылке учителя: board.html?room=…&title=… */
const room = params.get('room');
const isGuest = room !== null;
const STORAGE_KEY = room ?? (studentId && topicId ? boardKey(studentId, topicId) : 'tiza:board');
/** Секретный ключ доски на сервере: у ученика он из ссылки, у учителя — из темы. */
const serverRoom = room ?? (studentId && topicId ? topicRoom(studentId, topicId) : null);

const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const mainCtx = canvas.getContext('2d')!;
/** Куда рисуем сейчас: на доску или на запасной холст, если на предмете есть стёртые места. */
let ctx = mainCtx;
const layer = document.createElement('canvas');
const layerCtx = layer.getContext('2d')!;
const palette = document.querySelector<HTMLDivElement>('#palette')!;
const undoButton = document.querySelector<HTMLButtonElement>('#undo')!;
const redoButton = document.querySelector<HTMLButtonElement>('#redo')!;
const zoomButton = document.querySelector<HTMLButtonElement>('#zoom-reset')!;
const fileInput = document.querySelector<HTMLInputElement>('#image-file')!;
const docInput = document.querySelector<HTMLInputElement>('#doc-file')!;
const notice = document.querySelector<HTMLParagraphElement>('#notice')!;

/* ---------- над доской: куда вернуться и какая тема ---------- */

function showHeader(): void {
  const back = document.querySelector<HTMLAnchorElement>('#back')!;
  const title = document.querySelector<HTMLSpanElement>('#topic-title')!;
  if (isGuest) {
    // Ученик возвращается к своей дорожной карте, если пришёл с неё.
    const map = params.get('map');
    if (map) {
      back.href = `roadmap.html?${new URLSearchParams({ key: map })}`;
      back.textContent = '← Мои темы';
    } else back.hidden = true;
    title.textContent = params.get('title') ?? '';
    document.title = title.textContent ? `Tiza: ${title.textContent}` : 'Tiza';
    return;
  }
  const student = studentId ? getStudent(studentId) : undefined;
  const topic = student?.topics?.find((t) => t.id === topicId);
  if (!student) return; // общая доска: ссылка ведёт к списку учеников, как в разметке
  back.href = `student.html?id=${encodeURIComponent(student.id)}`;
  back.textContent = `← ${student.name}`;
  title.textContent = topic?.title ?? '';
  document.title = topic ? `Tiza: ${topic.title}` : `Tiza: ${student.name}`;
}

showHeader();

/** Короткое сообщение над доской; пустая строка его прячет. */
function showNotice(text: string): void {
  notice.textContent = text;
  notice.hidden = !text;
}

/* ---------- доска ученика без сервера ---------- */

if (isGuest && !hasServer) showNotice('Сайт пока не подключён к серверу, поэтому доска учителя здесь не появится.');

/* ---------- сохранение в браузере ---------- */

/**
 * Достаёт сохранённую доску; если её нет или данные испорчены, доска пустая.
 * Старые доски хранились просто списком линий — их тоже понимаем.
 */
async function load(): Promise<{ strokes: Stroke[]; images: BoardImage[]; cards: Card[]; shapes: Shape[] }> {
  const empty = { strokes: [], images: [], cards: [], shapes: [] };
  if (isGuest) return empty; // доска ученика приходит с сервера
  try {
    const data = ((await readBoard(STORAGE_KEY)) ?? []) as { strokes?: unknown; images?: unknown; cards?: unknown; shapes?: unknown };
    const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []);
    // У старых линий не было id, а без него другая вкладка не поймёт, какую линию стёрли.
    const withIds = (v: unknown): Stroke[] => list<Stroke>(v).map((s) => ({ ...s, id: s.id ?? newId() }));
    if (Array.isArray(data)) return { ...empty, strokes: withIds(data) };
    return { strokes: withIds(data.strokes), images: list(data.images), cards: list(data.cards), shapes: list(data.shapes) };
  } catch {
    return empty;
  }
}

function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

const NO_SPACE = 'В браузере не хватает места: последние изменения не сохранятся. Удали лишние картинки.';

function save(): void {
  // У ученика доска живёт на сервере: в его браузере копию не держим.
  if (isGuest) return;
  writeBoard(STORAGE_KEY, { strokes, images, cards, shapes }).then(
    () => notice.textContent === NO_SPACE && showNotice(''),
    // Чаще всего кончилось место на диске. Рисовать можно, но не сохранится.
    () => showNotice(NO_SPACE),
  );
}

const board = await load();
/** Все нарисованные линии. */
const strokes: Stroke[] = board.strokes;
/** Картинки на доске; они лежат под линиями, чтобы по скриншоту можно было рисовать. */
const images: BoardImage[] = board.images;
/** Карточки заданий из Word; лежат над картинками и под линиями. */
const cards: Card[] = board.cards;
/** Фигуры из ящика: лежат над карточками и под линиями мела. */
const shapes: Shape[] = board.shapes;
/** Какую фигуру рисуем из ящика и фигура, которую тянем прямо сейчас. */
let shapeKind: ShapeKind = 'rect';
let draft: Shape | null = null;
/** Линия, которую рисуем прямо сейчас. */
let current: Stroke | null = null;
/** Что изменило текущее движение губки: какие линии заменены кусками и где стёрто на предметах. */
let erased: { removed: Stroke[]; added: Stroke[]; wipes: Map<Movable, Wipe> } | null = null;
/** Где губка: последняя стёртая точка и кружок под курсором. */
let eraserLast: Point | null = null;
let eraserRing: Point | null = null;
/** Цвет мела, выбранный на палитре. */
let color = palette.querySelector<HTMLButtonElement>('[aria-pressed="true"]')!.dataset.color!;
let tool: Tool = 'pen';

/** Выбранная указкой картинка или карточка. */
let selected: Movable | null = null;
/** Рамка выделения, которую тянем сейчас, и всё, что попало в выделенный участок. */
let marquee: { start: Point; end: Point } | null = null;
let picked: { strokes: Stroke[]; images: BoardImage[]; cards: Card[]; shapes: Shape[] } | null = null;
/**
 * След лазерной указки: точки доски со временем появления.
 * Он ничего не рисует на доске и не сохраняется — только показывает, куда смотреть.
 */
/** Точка следа: где, когда появилась и начинает ли новое движение. */
type LaserPoint = { x: number; y: number; t: number; start?: boolean };
/** Свой след и след того, кто на другом конце (учитель видит лазер ученика, и наоборот). */
let laserTrail: LaserPoint[] = [];
let remoteTrail: LaserPoint[] = [];
let laserDown = false;
let laserFrame = 0;

/** Что делаем с картинкой, пока зажата кнопка мыши: двигаем или меняем размер. */
let dragging: { mode: 'move' | 'resize'; start: Point; from: Box } | null = null;
/** Какая кнопка горела на полке, пока правой кнопкой мыши показываем лазер. */
let heldTool: HTMLButtonElement | null = null;

const undoStack: Change[] = [];
const redoStack: Change[] = [];

/**
 * Камера: где доска на экране и насколько она увеличена.
 * Линии хранятся в координатах доски, поэтому при сдвиге и масштабе не меняются.
 */
const camera = { x: 0, y: 0, zoom: 1 };
/** Плотность пикселей экрана (2 на Retina). */
let dpr = 1;
/** Последняя точка экрана, пока двигаем доску. */
let panning: Point | null = null;
/** Пока зажат пробел, мышь двигает доску, а не рисует. */
let spaceHeld = false;

/** Подгоняет холст под размер окна с учётом плотности пикселей экрана. */
function resize(): void {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  draw();
}

function drawStroke(s: Stroke): void {
  ctx.strokeStyle = chalkColors[s.color] ?? s.color;
  ctx.beginPath();
  ctx.moveTo(s.points[0].x, s.points[0].y);
  for (const p of s.points) ctx.lineTo(p.x, p.y);
  ctx.stroke();
}

/* ---------- цвета темы ---------- */

/**
 * Цвет линии хранится кодом мела (#25231f — графит и т. д.),
 * а рисуется цветом текущей темы: в тёмной теме графит становится белым мелом.
 */
const CHALK_VARS: Record<string, string> = {
  '#25231f': '--chalk-ink',
  '#ae4f29': '--chalk-red',
  '#33589e': '--chalk-blue',
};
const chalkColors: Record<string, string> = {};
let paperColor = '';
let accentColor = '';
let cardColor = '';
let lineColor = '';
let inkColor = '';

/** Берёт цвета из CSS текущей темы (светлой или тёмной). */
function readTheme(): void {
  const css = getComputedStyle(document.documentElement);
  paperColor = css.getPropertyValue('--paper').trim();
  accentColor = css.getPropertyValue('--accent').trim();
  cardColor = css.getPropertyValue('--card').trim();
  lineColor = css.getPropertyValue('--line').trim();
  inkColor = css.getPropertyValue('--ink').trim();
  for (const [code, name] of Object.entries(CHALK_VARS)) {
    chalkColors[code] = css.getPropertyValue(name).trim();
  }
}

/** Уголок для изменения размера — правый нижний угол картинки или карточки. */
function handleRect(i: Movable): Rect {
  const size = HANDLE / camera.zoom;
  return { x: i.x + i.w - size / 2, y: i.y + i.h - size / 2, w: size, h: size };
}

/** Переносит текст по словам, чтобы строки помещались в ширину карточки. */
function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > width) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Где что стоит в карточке: строки текста, линии таблиц и высота всей карточки. */
type CardLayout = {
  h: number;
  texts: { x: number; y: number; text: string; font: string }[];
  grid: { x1: number; y1: number; x2: number; y2: number }[];
};

/**
 * Раскладывает текст карточки. Строки с табуляцией — это строки таблицы из Word:
 * подряд идущие такие строки рисуем одной таблицей с сеткой.
 */
function layoutCard(c: Card): CardLayout {
  const layout: CardLayout = { h: 0, texts: [], grid: [] };
  const left = c.x + CARD_PAD;
  const width = c.w - CARD_PAD * 2;
  const top = c.y + CARD_PAD + 26;
  let y = top;
  const rows = c.text.split('\n');
  for (let i = 0; i < rows.length; ) {
    if (!rows[i].includes('\t')) {
      ctx.font = `18px ${FONT}`;
      for (const text of wrapText(rows[i], width)) {
        layout.texts.push({ x: left, y, text, font: ctx.font });
        y += CARD_LINE;
      }
      i++;
      continue;
    }
    const table: string[][] = [];
    while (i < rows.length && rows[i].includes('\t')) table.push(rows[i++].split('\t'));
    y = layoutTable(table, left, y + 4, width, layout) + 8;
  }
  layout.h = y - top + CARD_PAD * 2 + 22;
  return layout;
}

/** Таблица: ширина столбцов по самому длинному тексту, а если не влезает — сжимаем и переносим. */
function layoutTable(table: string[][], left: number, top: number, width: number, layout: CardLayout): number {
  ctx.font = `16px ${FONT}`;
  const cols = Math.max(...table.map((r) => r.length));
  const natural = Array.from({ length: cols }, (_, k) =>
    Math.max(20, ...table.map((r) => ctx.measureText(r[k] ?? '').width)) + CELL_PAD * 2,
  );
  const total = natural.reduce((a, b) => a + b, 0);
  const widths = natural.map((w) => (total > width ? (w * width) / total : w));
  const right = left + widths.reduce((a, b) => a + b, 0);

  let y = top;
  layout.grid.push({ x1: left, y1: y, x2: right, y2: y });
  for (const row of table) {
    let x = left;
    let height = TABLE_LINE;
    widths.forEach((w, k) => {
      const lines = wrapText(row[k] ?? '', w - CELL_PAD * 2);
      lines.forEach((text, n) => layout.texts.push({ x: x + CELL_PAD, y: y + 4 + n * TABLE_LINE, text, font: ctx.font }));
      height = Math.max(height, lines.length * TABLE_LINE);
      x += w;
    });
    y += height + 8;
    layout.grid.push({ x1: left, y1: y, x2: right, y2: y });
  }
  let x = left;
  for (const w of [0, ...widths]) {
    x += w;
    layout.grid.push({ x1: x, y1: top, x2: x, y2: y });
  }
  return y;
}

/** Место и размер предмета для истории; у карточки вместе с масштабом. */
function boxSnapshot(m: Movable): Box {
  return isCard(m) ? { ...rectOf(m), s: m.s ?? 1 } : rectOf(m);
}

/**
 * Карточку раскладываем в её собственном размере (масштаб 1, угол в нуле),
 * а рисуем увеличенной или уменьшенной: так текст растёт вместе с листом.
 */
function inCard(c: Card, paint: (local: Card) => void): void {
  const s = c.s ?? 1;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.scale(s, s);
  paint({ ...c, x: 0, y: 0, w: c.w / s });
  ctx.restore();
}

/** Рисует лист карточки и заодно запоминает её высоту по содержимому. */
function drawCardSheet(c: Card): CardLayout {
  let layout!: CardLayout;
  inCard(c, (local) => {
    layout = layoutCard(local);
    ctx.fillStyle = cardColor;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(0, 0, local.w, layout.h, 10);
    ctx.fill();
    ctx.stroke();
  });
  c.h = layout.h * (c.s ?? 1);
  return layout;
}

/** Текст карточки: заголовок и строки задания. Губка стирает только его, лист остаётся. */
function drawCardText(c: Card, layout: CardLayout): void {
  inCard(c, (local) => drawCardLines(local, layout));
}

function drawCardLines(c: Card, layout: CardLayout): void {
  ctx.fillStyle = accentColor;
  ctx.font = `600 14px ${FONT}`;
  ctx.textBaseline = 'top';
  ctx.fillText(c.title, c.x + CARD_PAD, c.y + CARD_PAD);

  ctx.fillStyle = inkColor;
  for (const t of layout.texts) {
    ctx.font = t.font;
    ctx.fillText(t.text, t.x, t.y);
  }
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const g of layout.grid) {
    ctx.moveTo(g.x1, g.y1);
    ctx.lineTo(g.x2, g.y2);
  }
  ctx.stroke();
}

function drawSelection(i: Movable): void {
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2 / camera.zoom;
  ctx.strokeRect(i.x, i.y, i.w, i.h);
  const h = handleRect(i);
  ctx.fillStyle = accentColor;
  ctx.fillRect(h.x, h.y, h.w, h.h);
}

/* ---------- выделение участка ---------- */

/** Прямоугольник по двум углам, в любую сторону. */
function rectBetween(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Всё, что задевает рамка: линию — любой её точкой, предмет — любым краем. */
function pickIn(r: Rect): NonNullable<typeof picked> {
  const touched = <T extends Movable>(list: T[]) => list.filter((m) => overlaps(r, boxOf(m)));
  return {
    strokes: strokes.filter((s) => s.points.some((p) => contains(r, p))),
    images: touched(images),
    cards: touched(cards),
    shapes: touched(shapes),
  };
}

function pickedCount(): number {
  return picked ? picked.strokes.length + picked.images.length + picked.cards.length + picked.shapes.length : 0;
}

/** Рамка, которую тянут, и пунктир вокруг выделенного. */
function drawPicked(): void {
  ctx.save();
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.5 / camera.zoom;
  ctx.setLineDash([6 / camera.zoom, 4 / camera.zoom]);
  if (marquee) {
    const r = rectBetween(marquee.start, marquee.end);
    ctx.fillStyle = accentColor;
    ctx.globalAlpha = 0.08;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.globalAlpha = 1;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
  if (picked) {
    const pad = 4 / camera.zoom;
    for (const s of picked.strokes) {
      const xs = s.points.map((p) => p.x);
      const ys = s.points.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      ctx.strokeRect(x - pad, y - pad, Math.max(...xs) - x + pad * 2, Math.max(...ys) - y + pad * 2);
    }
    for (const m of [...picked.images, ...picked.cards, ...picked.shapes]) {
      const b = boxOf(m);
      ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    }
  }
  ctx.restore();
}

function clearPicked(): void {
  if (!picked) return;
  picked = null;
  showNotice('');
  draw();
}

/** Delete убирает всё выделенное разом; отменяется одним Ctrl/⌘ + Z. */
function deletePicked(): void {
  if (!picked) return;
  const gone = picked;
  picked = null;
  showNotice('');
  for (const s of gone.strokes) removeFrom(strokes, s);
  for (const i of gone.images) removeFrom(images, i);
  for (const c of gone.cards) removeFrom(cards, c);
  for (const s of gone.shapes) removeFrom(shapes, s);
  record({ kind: 'remove', ...gone });
  draw();
  save();
}

/** Прямоугольник предмета: у фигуры ширина и высота могут быть отрицательными. */
function boxOf(m: Movable): Rect {
  return isShape(m) ? boundsOf(m) : m;
}

/**
 * Рисует предмет со стёртыми местами. Они должны быть прозрачными, а не цвета бумаги:
 * так под ними видно то, что лежит ниже. Поэтому предмет сначала рисуем на запасном холсте.
 */
function withWipes(item: Movable, paint: () => void): void {
  if (!item.wipes?.length) return paint();
  // Рисуем туда же, куда и всё остальное: на экран или на лист тетради.
  const base = ctx;
  if (layer.width !== base.canvas.width || layer.height !== base.canvas.height) {
    layer.width = base.canvas.width;
    layer.height = base.canvas.height;
  }
  const transform = base.getTransform();
  layerCtx.setTransform(1, 0, 0, 1, 0, 0);
  layerCtx.clearRect(0, 0, layer.width, layer.height);
  layerCtx.setTransform(transform);
  layerCtx.lineWidth = base.lineWidth;
  layerCtx.lineCap = layerCtx.lineJoin = 'round';
  layerCtx.strokeStyle = base.strokeStyle;
  layerCtx.fillStyle = base.fillStyle;
  ctx = layerCtx;
  paint();
  ctx = base;

  layerCtx.globalCompositeOperation = 'destination-out';
  strokeWipes(layerCtx, item, '#000');
  layerCtx.globalCompositeOperation = 'source-over';

  base.save();
  base.setTransform(1, 0, 0, 1, 0, 0);
  base.drawImage(layer, 0, 0);
  base.restore();
}

/** Проводит следы губки по предмету указанным цветом. */
function strokeWipes(target: CanvasRenderingContext2D, item: Movable, color: string): void {
  const b = boxOf(item);
  target.strokeStyle = color;
  target.lineCap = target.lineJoin = 'round';
  for (const wipe of item.wipes ?? []) {
    target.lineWidth = wipe.r * 2 * (b.w || 1);
    target.beginPath();
    target.moveTo(b.x + wipe.points[0].x * (b.w || 1), b.y + wipe.points[0].y * (b.h || 1));
    for (const p of wipe.points) target.lineTo(b.x + p.x * (b.w || 1), b.y + p.y * (b.h || 1));
    target.stroke();
  }
}

/** Кружок показывает, какую область сотрёт губка. */
function drawEraserRing(p: Point): void {
  ctx.strokeStyle = inkColor;
  ctx.lineWidth = 1 / camera.zoom;
  ctx.beginPath();
  ctx.arc(p.x, p.y, ERASER_RADIUS / camera.zoom, 0, Math.PI * 2);
  ctx.stroke();
}

function draw(): void {
  // Фон заливаем в координатах экрана, всё остальное рисуем в координатах доски.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = paperColor;
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, dpr * camera.x, dpr * camera.y);
  drawItems(draft);

  if (selected) drawSelection(selected);
  drawPicked();
  if (tool === 'eraser' && eraserRing) drawEraserRing(eraserRing);
  drawLaser();
  updateLedge();
}

/** Всё, что лежит на доске: картинки, карточки, фигуры и линии. Без выделения и лазера. */
function drawItems(extra: Shape | null): void {
  for (const i of images) {
    const img = imageElement(i, draw);
    if (!img) continue;
    ctx.drawImage(img, i.x, i.y, i.w, i.h);
    // На картинке губка закрашивает стёртое её же фоном: на скриншоте пропадает буква, а не появляется дыра.
    if (i.wipes?.length) strokeWipes(ctx, i, backgroundOf(i.id, img));
  }
  for (const c of cards) {
    const layout = drawCardSheet(c);
    withWipes(c, () => drawCardText(c, layout));
  }

  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of extra ? [...shapes, extra] : shapes) {
    ctx.strokeStyle = ctx.fillStyle = chalkColors[s.color] ?? s.color;
    withWipes(s, () => drawShape(ctx, s));
  }
  for (const s of strokes) drawStroke(s);
}

/** Рисует оба следа лазера. */
function drawLaser(): void {
  const now = performance.now();
  laserTrail = laserTrail.filter((p) => now - p.t < LASER_LIFE);
  remoteTrail = remoteTrail.filter((p) => now - p.t < LASER_LIFE);
  drawTrail(laserTrail, now);
  drawTrail(remoteTrail, now);
}

/** Один след: свежие точки яркие и толстые, старые тают. */
function drawTrail(trail: LaserPoint[], now: number): void {
  if (!trail.length) return;
  ctx.strokeStyle = accentColor;
  ctx.fillStyle = accentColor;
  ctx.lineCap = 'round';
  for (let i = 1; i < trail.length; i++) {
    if (trail[i].start) continue; // новое движение: с прошлым следом не соединяем
    const a = 1 - (now - trail[i].t) / LASER_LIFE;
    ctx.globalAlpha = a;
    ctx.lineWidth = (2 + 5 * a) / camera.zoom;
    ctx.beginPath();
    ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
    ctx.lineTo(trail[i].x, trail[i].y);
    ctx.stroke();
  }
  const head = trail[trail.length - 1];
  ctx.globalAlpha = 1 - (now - head.t) / LASER_LIFE;
  ctx.beginPath();
  ctx.arc(head.x, head.y, 6 / camera.zoom, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** Пока след виден, перерисовываем доску каждый кадр, чтобы он плавно таял. */
function animateLaser(): void {
  if (laserFrame || (!laserTrail.length && !remoteTrail.length)) return;
  laserFrame = requestAnimationFrame(() => {
    laserFrame = 0;
    draw();
    animateLaser();
  });
}

function addLaserPoint(p: Point, start = false): void {
  laserTrail.push({ x: p.x, y: p.y, t: performance.now(), start });
  link.laser({ type: 'laser', x: p.x, y: p.y, start });
  animateLaser();
}

/** Кнопки на полке: бледные отмена и возврат, если нечего делать, и текущий масштаб. */
function updateLedge(): void {
  undoButton.classList.toggle('is-off', undoStack.length === 0);
  redoButton.classList.toggle('is-off', redoStack.length === 0);
  zoomButton.textContent = `${Math.round(camera.zoom * 100)}%`;
}

/** Точка на экране (в пикселях от левого верхнего угла холста). */
function screenPoint(e: MouseEvent): Point {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** Точка экрана в координатах доски, с учётом сдвига и масштаба. */
function toBoard(s: Point): Point {
  return { x: (s.x - camera.x) / camera.zoom, y: (s.y - camera.y) / camera.zoom };
}

function pointOf(e: MouseEvent): Point {
  return toBoard(screenPoint(e));
}

/* ---------- сдвиг и масштаб ---------- */

/** Увеличивает доску в factor раз так, чтобы точка под курсором осталась на месте. */
function zoomAt(factor: number, at: Point): void {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor));
  const k = zoom / camera.zoom;
  camera.x = at.x - (at.x - camera.x) * k;
  camera.y = at.y - (at.y - camera.y) * k;
  camera.zoom = zoom;
  draw();
}

/** Масштаб от центра экрана — для кнопок на полке. */
function zoomCenter(factor: number): void {
  zoomAt(factor, { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });
}

/** Исходное положение доски и масштаб 100%. */
function resetView(): void {
  Object.assign(camera, { x: 0, y: 0, zoom: 1 });
  draw();
}

/** Курсор подсказывает, что сейчас произойдёт; at — точка доски под мышью (для указки). */
/**
 * Курсор лазера — светящаяся точка цвета следа, а не крестик: сразу видно, что это указка.
 * Цвет берём из темы, поэтому собираем картинку на ходу.
 */
function laserCursor(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="${accentColor}" opacity="0.25"/><circle cx="12" cy="12" r="5" fill="${accentColor}"/><circle cx="12" cy="12" r="2" fill="#fff" opacity="0.8"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
}

function updateCursor(at?: Point): void {
  if (panning) canvas.style.cursor = 'grabbing';
  else if (spaceHeld) canvas.style.cursor = 'grab';
  else if (tool === 'eraser') canvas.style.cursor = 'none';
  else if (tool === 'laser') canvas.style.cursor = laserCursor();
  else if (tool === 'pen' || tool === 'shape' || tool === 'select') canvas.style.cursor = 'crosshair';
  else if (dragging?.mode === 'resize' || (at && selected && contains(handleRect(selected), at))) canvas.style.cursor = 'nwse-resize';
  // Указка — лапка: схватить можно и предмет, и саму доску.
  else if (dragging) canvas.style.cursor = 'grabbing';
  else canvas.style.cursor = 'grab';
}

/* ---------- история: отмена и возврат ---------- */

function removeFrom<T>(list: T[], item: T): void {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
}

/** Применяет действие к доске; reverse = true делает обратное (для отмены). */
function apply(change: Change, reverse = false): void {
  if (change.kind === 'move') {
    Object.assign(change.image, reverse ? change.from : change.to);
    return;
  }
  if (change.kind === 'erase') {
    for (const s of reverse ? change.added : change.removed) removeFrom(strokes, s);
    strokes.push(...(reverse ? change.removed : change.added));
    for (const { item, wipe } of change.wipes) {
      // По id, а не по ссылке: после переподключения следы губки приходят с сервера новыми объектами.
      if (reverse) item.wipes = item.wipes?.filter((w) => w.id !== wipe.id);
      else if (!item.wipes?.some((w) => w.id === wipe.id)) (item.wipes ??= []).push(wipe);
    }
    return;
  }
  const add = (change.kind === 'add') !== reverse;
  for (const s of change.strokes) {
    if (add) strokes.push(s);
    else removeFrom(strokes, s);
  }
  for (const i of change.images ?? []) {
    if (add) images.push(i);
    else removeFrom(images, i);
    if (!add && selected === i) selected = null;
  }
  for (const s of change.shapes ?? []) {
    if (add) shapes.push(s);
    else removeFrom(shapes, s);
    if (!add && selected === s) selected = null;
  }
  for (const c of change.cards ?? []) {
    if (add) cards.push(c);
    else removeFrom(cards, c);
    if (!add && selected === c) selected = null;
  }
}

function listOf(m: Movable): ListName {
  return isShape(m) ? 'shapes' : isCard(m) ? 'cards' : 'images';
}

/** То же действие в виде изменений для сервера: другие вкладки найдут всё по id. */
function opsOf(change: Change, reverse = false): Op[] {
  if (change.kind === 'move') {
    const m = change.image;
    return [{ type: 'move', list: listOf(m), id: m.id, rect: reverse ? change.from : change.to }];
  }
  if (change.kind === 'erase') {
    const gone = reverse ? change.added : change.removed;
    const back = reverse ? change.removed : change.added;
    const ops: Op[] = [];
    if (gone.length) ops.push({ type: 'remove', list: 'strokes', ids: gone.map((s) => s.id) });
    if (back.length) ops.push({ type: 'add', list: 'strokes', items: back });
    for (const { item, wipe } of change.wipes) {
      const target = { list: listOf(item), id: item.id };
      ops.push(reverse ? { type: 'unwipe', ...target, wipeId: wipe.id } : { type: 'wipe', ...target, wipe });
    }
    return ops;
  }
  const add = (change.kind === 'add') !== reverse;
  const ops: Op[] = [];
  for (const list of LISTS) {
    const items: Item[] = change[list] ?? [];
    if (!items.length) continue;
    ops.push(add ? { type: 'add', list, items } : { type: 'remove', list, ids: items.map((i) => i.id) });
  }
  return ops;
}

/** Действие уже случилось на доске: кладём его в историю и отправляем остальным. */
function record(change: Change): void {
  undoStack.push(change);
  redoStack.length = 0;
  opsOf(change).forEach(sendOp);
  updateLedge();
}

function undo(): void {
  const change = undoStack.pop();
  if (!change) return;
  apply(change, true);
  opsOf(change, true).forEach(sendOp);
  redoStack.push(change);
  draw();
  save();
}

function redo(): void {
  const change = redoStack.pop();
  if (!change) return;
  apply(change);
  opsOf(change).forEach(sendOp);
  undoStack.push(change);
  draw();
  save();
}

/* ---------- губка ---------- */

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function touches(s: Stroke, p: Point): boolean {
  // Губка одного размера на экране при любом масштабе.
  const r = ERASER_RADIUS / camera.zoom;
  if (s.points.length === 1) return Math.hypot(p.x - s.points[0].x, p.y - s.points[0].y) < r;
  for (let i = 1; i < s.points.length; i++) {
    if (distToSegment(p, s.points[i - 1], s.points[i]) < r) return true;
  }
  return false;
}

/** Стирает в одной точке: вырезает кусок из линий и оставляет след на предметах под губкой. */
function eraseAt(p: Point): void {
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    if (!touches(s, p)) continue;
    const parts = cutStroke(s, p);
    strokes.splice(i, 1, ...parts);
    // Кусок, появившийся в этом же движении, просто забываем: до движения его не было.
    const own = erased!.added.indexOf(s);
    if (own >= 0) erased!.added.splice(own, 1);
    else erased!.removed.push(s);
    erased!.added.push(...parts);
  }
  const r = ERASER_RADIUS / camera.zoom;
  for (const item of [...images, ...cards, ...shapes]) {
    const b = boxOf(item);
    // У фигур подписи и толщина линий выходят за прямоугольник, поэтому запас больше.
    const pad = isShape(item) ? r + 16 : r;
    if (!contains({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }, p)) continue;
    let wipe = erased!.wipes.get(item);
    if (!wipe) {
      wipe = { id: newId(), r: r / (b.w || 1), points: [] };
      erased!.wipes.set(item, wipe);
      (item.wipes ??= []).push(wipe);
    }
    wipe.points.push({ x: round((p.x - b.x) / (b.w || 1)), y: round((p.y - b.y) / (b.h || 1)) });
  }
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/** Вырезает из линии круг губки. Возвращает куски, которые остались. */
function cutStroke(s: Stroke, p: Point): Stroke[] {
  const r = ERASER_RADIUS / camera.zoom;
  const runs: Point[][] = [];
  let run: Point[] = [];
  const visit = (q: Point) => {
    if (Math.hypot(q.x - p.x, q.y - p.y) >= r) return void run.push(q);
    if (run.length) runs.push(run);
    run = [];
  };
  s.points.forEach((q, i) => {
    const prev = s.points[i - 1];
    // Длинный отрезок рядом с губкой дробим, чтобы край выреза был точным.
    if (prev && distToSegment(p, prev, q) < r) {
      const n = Math.ceil(Math.hypot(q.x - prev.x, q.y - prev.y) / (r / 4));
      for (let k = 1; k < n; k++) visit({ x: prev.x + ((q.x - prev.x) * k) / n, y: prev.y + ((q.y - prev.y) * k) / n });
    }
    visit(q);
  });
  if (run.length) runs.push(run);
  return runs.filter((points) => points.length > 1).map((points) => ({ id: newId(), color: s.color, points }));
}

/** Ведёт губку до точки: быстрое движение мыши не должно оставлять нестёртых промежутков. */
function eraseTo(p: Point): void {
  const from = eraserLast ?? p;
  const step = ERASER_RADIUS / camera.zoom / 2;
  const n = Math.max(1, Math.ceil(Math.hypot(p.x - from.x, p.y - from.y) / step));
  for (let i = 1; i <= n; i++) eraseAt({ x: from.x + ((p.x - from.x) * i) / n, y: from.y + ((p.y - from.y) * i) / n });
  eraserLast = p;
  draw();
}

/* ---------- картинки ---------- */

/** Верхняя фигура, карточка или картинка под точкой доски — в том порядке, как они лежат. */
function imageAt(p: Point): Movable | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    // У тонкой линии рамка нулевой высоты, поэтому даём запас в 8 пикселей экрана.
    const b = boundsOf(shapes[i]);
    const pad = 8 / camera.zoom;
    if (contains({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }, p)) return shapes[i];
  }
  for (let i = cards.length - 1; i >= 0; i--) if (contains(cards[i], p)) return cards[i];
  for (let i = images.length - 1; i >= 0; i--) if (contains(images[i], p)) return images[i];
  return null;
}

const isCard = (m: Movable): m is Card => 'title' in m;
const isShape = (m: Movable): m is Shape => 'kind' in m;

/**
 * Кладёт картинку на доску центром в точку экрана.
 * Большую уменьшаем, чтобы она занимала не больше 60% видимой части доски.
 */
async function insertImage(file: Blob, atScreen: Point): Promise<void> {
  try {
    const { src, w, h } = await readImage(file);
    const k = Math.min(1, (canvas.clientWidth * 0.6) / camera.zoom / w, (canvas.clientHeight * 0.6) / camera.zoom / h);
    const c = toBoard(atScreen);
    const item: BoardImage = {
      id: crypto.randomUUID().slice(0, 8),
      src,
      x: c.x - (w * k) / 2,
      y: c.y - (h * k) / 2,
      w: w * k,
      h: h * k,
    };
    images.push(item);
    record({ kind: 'add', strokes: [], images: [item] });
    select(palette.querySelector<HTMLButtonElement>('[data-tool="pointer"]')!);
    selected = item;
    draw();
    save();
  } catch {
    showNotice('Не получилось вставить картинку. Попробуй другой файл.');
  }
}

function deleteSelected(): void {
  if (!selected) return;
  const item = selected;
  selected = null;
  if (isShape(item)) {
    removeFrom(shapes, item);
    record({ kind: 'remove', strokes: [], shapes: [item] });
  } else if (isCard(item)) {
    removeFrom(cards, item);
    record({ kind: 'remove', strokes: [], cards: [item] });
  } else {
    removeFrom(images, item);
    record({ kind: 'remove', strokes: [], images: [item] });
  }
  draw();
  save();
}

/* ---------- тетрадь: доска в PDF ---------- */

/** Прямоугольники всего, что лежит на доске. */
function itemBoxes(): Rect[] {
  const strokeBoxes = strokes.map((st) => {
    const xs = st.points.map((p) => p.x);
    const ys = st.points.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x: x - 3, y: y - 3, w: Math.max(...xs) - x + 6, h: Math.max(...ys) - y + 6 };
  });
  return [...images.map(rectOf), ...cards.map(rectOf), ...shapes.map(boundsOf), ...strokeBoxes];
}

/**
 * Рисует доску в печатных цветах светлой темы: белый мел становится графитом,
 * карточки — светлыми листами. После этого возвращаем цвета текущей темы.
 */
function paintForPrint(target: CanvasRenderingContext2D): void {
  paperColor = '#ffffff';
  cardColor = '#fffcf4';
  lineColor = '#d7cdb7';
  inkColor = '#25231f';
  accentColor = '#ae4f29';
  // Код мела и есть его цвет на светлой бумаге.
  for (const code of Object.keys(CHALK_VARS)) chalkColors[code] = code;
  ctx = target;
  try {
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    drawItems(null);
  } finally {
    ctx = mainCtx;
    readTheme();
  }
}

/** Ждём картинки, которые ещё грузятся, но не дольше нескольких секунд. */
async function imagesReady(): Promise<void> {
  for (let tries = 0; tries < 50; tries++) {
    if (images.every((i) => imageElement(i, draw))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

let downloading = false;

async function downloadPdf(): Promise<void> {
  if (downloading) return;
  const boxes = itemBoxes();
  if (!boxes.length) {
    showNotice('Доска пустая: в тетрадь пока нечего положить.');
    return;
  }
  downloading = true;
  showNotice('Собираю тетрадь…');
  try {
    await imagesReady();
    const title = document.querySelector('#topic-title')?.textContent?.trim() || 'Доска';
    const studentName = !isGuest && studentId ? getStudent(studentId)?.name : undefined;
    const now = new Date();
    const date = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    const day = now.toISOString().slice(0, 10);
    const pages = await downloadNotebook({
      boxes,
      paint: paintForPrint,
      title,
      subtitle: studentName ? `${studentName} · ${date}` : date,
      // В имени файла не должно быть знаков, которые запрещены в Windows.
      fileName: `${title.replace(/[\\/:*?"<>|]/g, '-')} — ${day}.pdf`,
    });
    showNotice(`Тетрадь скачана: ${pages} ${pages === 1 ? 'лист' : pages < 5 ? 'листа' : 'листов'}.`);
  } catch {
    showNotice('Не получилось собрать PDF. Попробуй ещё раз.');
  } finally {
    downloading = false;
    draw();
  }
}

/**
 * Читает Word, находит задания («Задание 1», «№ 214»…) и кладёт их карточками
 * столбиком у левого края видимой части доски, чтобы справа было место для решения.
 */
async function insertTasks(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith('.docx')) {
    showNotice('Нужен файл Word в формате .docx. Старый .doc можно пересохранить в Word как .docx.');
    return;
  }
  try {
    const tasks = splitTasks(await readDocx(file));
    if (!tasks.length) {
      showNotice('В документе не нашлось заданий. Каждое должно начинаться с «Задание 1», «№ 3» или быть пунктом нумерованного списка.');
      return;
    }
    const start = toBoard({ x: 40, y: 72 });
    const added: Card[] = [];
    let y = start.y;
    for (const t of tasks) {
      const card: Card = { id: crypto.randomUUID().slice(0, 8), x: start.x, y, w: CARD_WIDTH, h: 0, title: t.title, text: t.text };
      // Высоту узнаём, «нарисовав» карточку: она нужна, чтобы следующая встала ниже.
      ctx.font = `18px ${FONT}`;
      card.h = layoutCard(card).h;
      y += card.h + CARD_GAP;
      added.push(card);
    }
    cards.push(...added);
    record({ kind: 'add', strokes: [], cards: added });
    draw();
    save();
    // Если сохранилось (нет предупреждения о месте), коротко сообщаем, сколько заданий нашли.
    if (notice.hidden) {
      showNotice(`Добавлено заданий: ${added.length}.`);
      setTimeout(() => notice.textContent?.startsWith('Добавлено') && showNotice(''), 4000);
    }
  } catch {
    showNotice('Не получилось прочитать документ. Проверь, что это файл Word (.docx).');
  }
}

const centerOfScreen = (): Point => ({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });

/* ---------- палитра ---------- */

function select(button: HTMLButtonElement): void {
  tool = (button.dataset.tool as Tool | undefined) ?? 'pen';
  if (tool === 'pen') color = button.dataset.color!;
  if (tool !== 'pointer') selected = null;
  if (tool !== 'select') clearPicked();
  updateCursor();
  draw();
  // @ts-ignore
  for (const b of palette.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b === button));
  }
}

/* ---------- ящик с фигурами ---------- */

const shapesBox = document.querySelector<HTMLDivElement>('#shapes')!;
const boxButton = document.querySelector<HTMLButtonElement>('#shapes-box')!;

function toggleBox(open = shapesBox.hidden): void {
  shapesBox.hidden = !open;
  boxButton.setAttribute('aria-expanded', String(open));
}

/** Выбрали фигуру в ящике: дальше её рисуем на доске, растягивая мышью, текущим мелом. */
function chooseShape(button: HTMLButtonElement): void {
  shapeKind = button.dataset.shape as ShapeKind;
  tool = 'shape';
  selected = null;
  // На полке приподнимается ящик; цвет фигуры — последний выбранный мел.
  for (const b of palette.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === boxButton));
  for (const b of shapesBox.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === button));
  draw();
  toggleBox(false);
  updateCursor();
}

boxButton.addEventListener('click', () => toggleBox());
shapesBox.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-shape]');
  if (button) chooseShape(button);
});

/* ---------- мышь, палец, стилус ---------- */

canvas.addEventListener('pointerdown', (e) => {
  const p = pointOf(e);
  toggleBox(false);
  // Правая кнопка мыши — лазер, каким бы инструментом ни рисовали: зажал и показываешь.
  if (e.button === 2) {
    e.preventDefault();
    // На полке на это время горит лазер, а отпустил кнопку — вернётся то, что было.
    heldTool = palette.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    for (const b of palette.querySelectorAll<HTMLButtonElement>('[aria-pressed]')) {
      b.setAttribute('aria-pressed', String(b.dataset.tool === 'laser'));
    }
    canvas.style.cursor = laserCursor();
    laserDown = true;
    addLaserPoint(p, true);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Указатель уже отпущен.
    }
    return;
  }
  // Средняя кнопка мыши или зажатый пробел — двигаем доску.
  if (e.button === 1 || spaceHeld) {
    e.preventDefault();
    panning = screenPoint(e);
    updateCursor();
    return;
  }
  if (tool === 'pointer') {
    if (selected && contains(handleRect(selected), p)) {
      dragging = { mode: 'resize', start: p, from: boxSnapshot(selected) };
    } else {
      selected = imageAt(p);
      // Мимо картинок указка двигает саму доску.
      if (selected) dragging = { mode: 'move', start: p, from: boxSnapshot(selected) };
      else panning = screenPoint(e);
    }
    try {
      // Тянем картинку, даже если мышь выскочила за край окна.
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Указатель уже отпущен — тогда и захватывать нечего.
    }
    updateCursor(p);
    draw();
    return;
  }
  if (tool === 'select') {
    // Новая рамка: прежнее выделение снимается.
    picked = null;
    showNotice('');
    marquee = { start: p, end: p };
    return;
  }
  if (tool === 'laser') {
    laserDown = true;
    addLaserPoint(p, true);
    return;
  }
  if (tool === 'shape') {
    draft = { id: crypto.randomUUID().slice(0, 8), kind: shapeKind, color, x: p.x, y: p.y, w: 0, h: 0 };
    return;
  }
  if (tool === 'eraser') {
    erased = { removed: [], added: [], wipes: new Map() };
    eraserLast = null;
    eraseTo(p);
    return;
  }
  current = { id: newId(), color, points: [p] };
  strokes.push(current);
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  if (panning) {
    const p = screenPoint(e);
    camera.x += p.x - panning.x;
    camera.y += p.y - panning.y;
    panning = p;
    return draw();
  }
  // Лазер раньше остальных: правой кнопкой его включают поверх любого инструмента.
  if (laserDown) return addLaserPoint(pointOf(e));
  if (dragging && selected) {
    const p = pointOf(e);
    const dx = p.x - dragging.start.x;
    const dy = p.y - dragging.start.y;
    const from = dragging.from;
    if (dragging.mode === 'move') {
      selected.x = from.x + dx;
      selected.y = from.y + dy;
    } else if (isShape(selected)) {
      // У фигуры уголок — это её второй конец: тянем его куда угодно.
      selected.w = from.w + dx;
      selected.h = from.h + dy;
    } else if (isCard(selected)) {
      const s0 = from.s ?? 1;
      if (e.shiftKey) {
        // С Shift меняется только ширина: текст переносится по-новому, высота подстроится.
        selected.w = Math.max(MIN_CARD * s0, from.w + dx);
      } else {
        // Без Shift карточка растёт или уменьшается целиком, вместе с текстом.
        // Уголок идёт за мышью вдоль диагонали карточки: широкая низкая карточка не раздувается от лёгкого движения вниз.
        const k = ((from.w + dx) * from.w + (from.h + dy) * from.h) / (from.w * from.w + from.h * from.h);
        const s = Math.min(MAX_CARD_SCALE, Math.max(MIN_CARD_SCALE, s0 * k));
        selected.s = s;
        selected.w = (from.w * s) / s0;
      }
    } else if (e.shiftKey) {
      // С зажатым Shift ширина и высота меняются отдельно: картинку можно сплющить или вытянуть.
      selected.w = Math.max(MIN_IMAGE, from.w + dx);
      selected.h = Math.max(MIN_IMAGE, from.h + dy);
    } else {
      // Без Shift пропорции сохраняются, чтобы скриншот не растягивался.
      const w = Math.max(MIN_IMAGE, from.w + Math.max(dx, (dy * from.w) / from.h));
      selected.w = w;
      selected.h = (w * from.h) / from.w;
    }
    return draw();
  }
  if (tool === 'eraser') {
    eraserRing = pointOf(e);
    return erased ? eraseTo(eraserRing) : draw();
  }
  if (tool === 'pointer') return updateCursor(pointOf(e));
  if (marquee) {
    marquee.end = pointOf(e);
    return draw();
  }
  if (draft) {
    const p = pointOf(e);
    draft.w = p.x - draft.x;
    draft.h = p.y - draft.y;
    return draw();
  }
  if (!current) return;
  current.points.push(pointOf(e));
  draw();
});

function finish(): void {
  const wiped = erased && (erased.removed.length > 0 || erased.wipes.size > 0);
  let changed = current !== null || !!wiped;
  if (current) record({ kind: 'add', strokes: [current] });
  if (erased && wiped) {
    const wipes = [...erased.wipes].map(([item, wipe]) => ({ item, wipe }));
    record({ kind: 'erase', removed: erased.removed, added: erased.added, wipes });
  }
  if (draft) {
    // Просто кликнули, не растягивая, — ставим фигуру обычного размера.
    if (Math.abs(draft.w) < 4 && Math.abs(draft.h) < 4) Object.assign(draft, defaultSize(draft.kind));
    shapes.push(draft);
    record({ kind: 'add', strokes: [], shapes: [draft] });
    draft = null;
    changed = true;
  }
  if (dragging && selected) {
    const to = boxSnapshot(selected);
    const from = dragging.from;
    if (to.x !== from.x || to.y !== from.y || to.w !== from.w || to.h !== from.h || to.s !== from.s) {
      record({ kind: 'move', image: selected, from, to });
      changed = true;
    }
  }
  if (marquee) {
    picked = pickIn(rectBetween(marquee.start, marquee.end));
    marquee = null;
    const n = pickedCount();
    if (!n) picked = null;
    showNotice(n ? `Выделено: ${n}. Delete — удалить, Esc — снять выделение.` : '');
    draw();
  }
  current = null;
  erased = null;
  panning = null;
  dragging = null;
  laserDown = false;
  if (heldTool) {
    for (const b of palette.querySelectorAll<HTMLButtonElement>('[aria-pressed]')) {
      b.setAttribute('aria-pressed', String(b === heldTool));
    }
    heldTool = null;
  }
  updateCursor();
  if (changed) save();
}

canvas.addEventListener('pointerleave', () => {
  eraserRing = null;
  if (tool === 'eraser') draw();
});
canvas.addEventListener('pointerup', finish);
// Правая кнопка занята лазером: меню браузера над доской не нужно.
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointercancel', finish);

/** Колесо или два пальца на тачпаде двигают доску; с Ctrl/⌘ (или щипок) — масштаб. */
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) return zoomAt(Math.exp(-e.deltaY * 0.01), screenPoint(e));
    camera.x -= e.deltaX;
    camera.y -= e.deltaY;
    draw();
  },
  { passive: false },
);

/* ---------- вставка картинок ---------- */

// Ctrl/⌘ + V: скриншот из буфера обмена появляется в центре экрана.
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  const file = item?.getAsFile();
  if (!file) return;
  e.preventDefault();
  insertImage(file, centerOfScreen());
});

// Файл картинки, перетащенный на доску, ложится туда, где его отпустили.
canvas.addEventListener('dragover', (e) => e.preventDefault());
canvas.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (file) insertImage(file, screenPoint(e));
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) insertImage(file, centerOfScreen());
  fileInput.value = '';
});

docInput.addEventListener('change', () => {
  const file = docInput.files?.[0];
  if (file) insertTasks(file);
  docInput.value = '';
});

palette.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest('button');
  if (!button) return;
  // Кнопка «картинка» не инструмент: она открывает выбор файла.
  if (button.id === 'add-image') return fileInput.click();
  if (button.id === 'add-doc') return docInput.click();
  if (button.id === 'notebook') return void downloadPdf();
  // Ящик открывается своим обработчиком и сам не меняет инструмент.
  if (button.id === 'shapes-box') return;
  select(button);
});

undoButton.addEventListener('click', undo);
redoButton.addEventListener('click', redo);
document.querySelector('#zoom-in')!.addEventListener('click', () => zoomCenter(1.25));
document.querySelector('#zoom-out')!.addEventListener('click', () => zoomCenter(1 / 1.25));
zoomButton.addEventListener('click', resetView);

/* ---------- клавиатура ---------- */

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();

  // Ctrl/⌘ + Z — отменить, с Shift — вернуть; Ctrl + Y — тоже вернуть.
  if (mod && (key === 'z' || key === 'я')) {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && (key === 'y' || key === 'н')) {
    e.preventDefault();
    redo();
    return;
  }
  // Ctrl/⌘ + 0 — вернуть доску на место и масштаб 100%.
  if (mod && e.key === '0') {
    e.preventDefault();
    resetView();
    return;
  }
  if (mod || e.altKey) return;

  if (e.code === 'Space') {
    e.preventDefault();
    spaceHeld = true;
    updateCursor();
    return;
  }

  // Delete или Backspace убирают выделенный участок или выбранную картинку, Esc снимает выбор.
  if ((e.key === 'Delete' || e.key === 'Backspace') && picked) {
    e.preventDefault();
    deletePicked();
    return;
  }
  if (e.key === 'Escape' && picked) {
    clearPicked();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
    e.preventDefault();
    deleteSelected();
    return;
  }
  if (e.key === 'Escape' && !shapesBox.hidden) {
    toggleBox(false);
    return;
  }
  if (e.key === 'Escape' && selected) {
    selected = null;
    draw();
    return;
  }

  if (key === 'l' || key === 'д') select(palette.querySelector<HTMLButtonElement>('[data-tool="laser"]')!);
  // 1, 2, 3 — мелки по порядку; E — губка; V — указка; L — лазер; S — выделение.
  const chalk = palette.querySelectorAll<HTMLButtonElement>('[data-color]')[Number(e.key) - 1];
  if (chalk) select(chalk);
  if (key === 'e' || key === 'у') select(palette.querySelector<HTMLButtonElement>('[data-tool="eraser"]')!);
  if (key === 'v' || key === 'м') select(palette.querySelector<HTMLButtonElement>('[data-tool="pointer"]')!);
  if (key === 's' || key === 'ы') select(palette.querySelector<HTMLButtonElement>('[data-tool="select"]')!);
});

window.addEventListener('keyup', (e) => {
  if (e.code !== 'Space') return;
  spaceHeld = false;
  updateCursor();
});

window.addEventListener('resize', resize);
// Сменили тему кнопкой или в системе — перекрашиваем доску сразу, без перезагрузки.
window.addEventListener('themechange', () => {
  readTheme();
  draw();
});

/* ---------- связь с сервером ---------- */

/** Те же массивы, что рисует доска: изменения с сервера меняют их на месте. */
const live = { strokes, images, cards, shapes } as unknown as BoardData;

/** Значок связи вверху: виден, только когда у сайта есть сервер. */
const linkStatus = document.querySelector<HTMLSpanElement>('#link-status')!;
const LINK_TEXT: Record<LinkState, [string, string]> = {
  connecting: ['подключение…', 'Сервер просыпается, это бывает до минуты. Пока ученик не видит твоих изменений.'],
  online: ['на связи', 'Ученик видит изменения на доске сразу.'],
  offline: ['нет связи', 'Связь с сервером пропала, пробую снова. Пока ученик не видит твоих изменений.'],
  missing: ['доска не найдена', 'Ссылка неверная или устарела. Попроси у учителя новую.'],
  waiting: ['ждём учителя', 'Учитель ещё не открывал эту доску. Она появится, как только он её откроет.'],
};

function showLink(state: LinkState): void {
  linkStatus.hidden = false;
  linkStatus.dataset.state = state;
  linkStatus.textContent = LINK_TEXT[state][0];
  linkStatus.dataset.tip = LINK_TEXT[state][1];
}

const link = connect(serverRoom, {
  local: () => (isGuest ? null : live),
  init(board) {
    for (const list of LISTS) {
      // Что уже есть во вкладке, обновляем на месте: на эти предметы ссылается история отмен,
      // и после переподключения отменять можно то, что сделано до обрыва связи.
      const mine = new Map(live[list].map((i) => [i.id, i]));
      const next = board[list].map((item) => {
        const own = mine.get(item.id);
        if (!own) return item;
        Object.assign(own, item);
        own.wipes = item.wipes;
        return own;
      });
      live[list].splice(0, live[list].length, ...next);
    }
    if (selected && ![...images, ...cards, ...shapes].includes(selected)) selected = null;
    draw();
    save();
  },
  op(op) {
    applyOp(live, op);
    // Кто-то другой стёр выделенное: из выделения оно тоже уходит.
    if (picked) {
      picked = {
        strokes: picked.strokes.filter((x) => strokes.includes(x)),
        images: picked.images.filter((x) => images.includes(x)),
        cards: picked.cards.filter((x) => cards.includes(x)),
        shapes: picked.shapes.filter((x) => shapes.includes(x)),
      };
      if (!pickedCount()) clearPicked();
    }
    if (selected && ![...images, ...cards, ...shapes].includes(selected)) selected = null;
    draw();
    save();
  },
  state: showLink,
  laser(point: Laser) {
    remoteTrail.push({ x: point.x, y: point.y, t: performance.now(), start: point.start });
    animateLaser();
  },
});
const sendOp = link.send;

readTheme();
resize();
