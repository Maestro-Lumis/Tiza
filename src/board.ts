import { backgroundOf, contains, imageElement, readImage, rectOf, type BoardImage, type Rect } from './images';
import { boardKey, getStudent, topicRoom } from './students';
import { boundsOf, canFill, defaultSize, drawShape, MAX_PARTS, MIN_PARTS, WIDTHS, type Shape, type ShapeKind } from './shapes';
import { readDocx, splitTasks } from './tasks';
import { applyOp, LISTS, type BoardData, type Item, type Laser, type ListName, type Live, type Op, type Wipe } from './ops';
import { chooseServer, chosenServer, connect, hasServer, probe, SERVERS, type LinkInfo, type LinkState } from './sync';
import { readBoard, writeBoard } from './local';
import { currentLogin, pull } from './account';
import {
  autoLayout,
  downloadNotebook,
  estimateKb,
  FORMATS,
  formatSize,
  ordered,
  QUALITIES,
  ratioOf,
  type Page,
  type PageFormat,
  type Quality,
} from './notebook';
import './theme';

type Point = { x: number; y: number };
/** w - толщина мела; у старых линий её нет, тогда обычная (3). */
type Stroke = { id: string; color: string; w?: number; points: Point[] };
type Tool = 'pen' | 'eraser' | 'pointer' | 'laser' | 'shape' | 'select' | 'text';
/** Карточка задания из Word. Высота считается по тексту при отрисовке. */
/** s - масштаб: карточку можно увеличить или уменьшить целиком, вместе с текстом. */
/** plain - надпись с доски: без листа и заголовка, цветом мела color. */
type Card = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  s?: number;
  title: string;
  text: string;
  plain?: boolean;
  color?: string;
  wipes?: Wipe[];
};
/** Что меняется, когда надпись переписали: текст и ширина. */
type Lettering = { text: string; w: number };
/** Место и размер предмета, у карточки ещё и масштаб: так их запоминает история. */
type Box = Rect & { s?: number; f?: PageFormat; n?: number };
/** То, что можно двигать: картинка, карточка, фигура или рамка листа тетради. */
type Movable = BoardImage | Card | Shape | Page;
/**
 * Одно действие для истории:
 * линии, картинки или карточки добавили / стёрли, либо что-то сдвинули или изменили размер.
 */
type Change =
  | { kind: 'add' | 'remove'; strokes: Stroke[]; images?: BoardImage[]; cards?: Card[]; shapes?: Shape[]; pages?: Page[] }
  | { kind: 'move'; image: Movable; from: Box; to: Box }
  // Несколько сдвигов разом, например два листа тетради поменялись местами.
  | { kind: 'moves'; moves: { image: Movable; from: Box; to: Box }[] }
  | { kind: 'erase'; removed: Stroke[]; added: Stroke[]; wipes: { item: Movable; wipe: Wipe }[] }
  // Сменили цвет, толщину, пунктир, заливку или доли фигуры.
  | { kind: 'style'; item: Shape; from: Look; to: Look }
  // Переписали надпись.
  | { kind: 'retext'; item: Card; from: Lettering; to: Lettering };
/** Как нарисована фигура целиком: цвет мела и всё остальное. */
type Look = { color: string; width: number; dash: boolean; fill: boolean; parts: number };

/** Радиус губки в пикселях экрана: такой, чтобы стереть одну букву. */
const ERASER_RADIUS = 8;
/** Толщина мела по умолчанию и пределы ползунка. */
const CHALK_WIDTH = 3;
const MIN_CHALK = 1;
const MAX_CHALK = 24;
/** Готовые толщины мела: тонкий, обычный, средний, толстый, очень толстый. */
const CHALK_SIZES = [1.5, 3, 6, 10, 16];

/** Губка задевает линию краем: у толстой линии край дальше от середины. */
function eraseRadius(s: Stroke): number {
  return ERASER_RADIUS / camera.zoom + Math.max(0, (s.w ?? CHALK_WIDTH) - CHALK_WIDTH) / 2;
}
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;
/** Размер уголка для изменения размера картинки - в пикселях экрана. */
const HANDLE = 12;
/** Меньше этой ширины картинку не сжать. */
const MIN_IMAGE = 24;
/** Карточки заданий: ширина по умолчанию, самая узкая, отступы и шрифт - в координатах доски. */
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
/** Надписи: размер букв, высота строки и отступ вокруг текста при масштабе 1; самая узкая надпись. */
const TEXT_SIZE = 24;
const TEXT_LINE = 32;
const TEXT_PAD = 6;
const MIN_TEXT = 40;
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
// Доска темы учителя без входа (закладка, чужой компьютер): сначала войти на главной.
// Ученик по своей ссылке входит без логина, его это не касается.
if (hasServer && !room && studentId && !currentLogin()) location.replace('./');
// Учитель открыл доску темы в браузере, где списка учеников ещё нет (закладка, другой компьютер):
// без списка не узнать ключ доски на сервере. Берём список с сервера и открываем доску заново.
if (!room && studentId && topicId && !getStudent(studentId) && (await pull())) location.reload();
/** Секретный ключ доски на сервере: у ученика он из ссылки, у учителя - из темы. */
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
 * Старые доски хранились просто списком линий - их тоже понимаем.
 */
async function load(): Promise<{ strokes: Stroke[]; images: BoardImage[]; cards: Card[]; shapes: Shape[]; pages: Page[] }> {
  const empty = { strokes: [], images: [], cards: [], shapes: [], pages: [] };
  if (isGuest) return empty; // доска ученика приходит с сервера
  try {
    const data = ((await readBoard(STORAGE_KEY)) ?? []) as { strokes?: unknown; images?: unknown; cards?: unknown; shapes?: unknown; pages?: unknown };
    const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []);
    // У старых линий не было id, а без него другая вкладка не поймёт, какую линию стёрли.
    const withIds = (v: unknown): Stroke[] => list<Stroke>(v).map((s) => ({ ...s, id: s.id ?? newId() }));
    if (Array.isArray(data)) return { ...empty, strokes: withIds(data) };
    return {
      strokes: withIds(data.strokes),
      images: list(data.images),
      cards: list(data.cards),
      shapes: list(data.shapes),
      pages: list(data.pages),
    };
  } catch {
    return empty;
  }
}

function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

const NO_SPACE = 'В браузере не хватает места: последние изменения не сохранятся. Удали лишние картинки.';

function save(): void {
  // Любое изменение доски могло задеть листы тетради: обновляем её список.
  renderNotebook();
  // У ученика доска живёт на сервере: в его браузере копию не держим.
  if (isGuest) return;
  writeBoard(STORAGE_KEY, { strokes, images, cards, shapes, pages }).then(
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
/** Рамки листов тетради. Видны, только пока открыта тетрадь, и в PDF не рисуются. */
const pages: Page[] = board.pages;
/** Какую фигуру рисуем из ящика и фигура, которую тянем прямо сейчас. */
let shapeKind: ShapeKind = 'rect';
let draft: Shape | null = null;
/** Линия, которую рисуем прямо сейчас. */
let current: Stroke | null = null;
/** Сколько точек текущей линии уже ушло другим и ждёт ли отправки следующий кадр. */
let liveSent = 0;
let liveTimer: ReturnType<typeof setTimeout> | undefined;
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
/** Открыта ли тетрадь: только тогда на доске видны рамки листов. */
let notebookOpen = false;
/** Рамка выделения, которую тянем сейчас, и всё, что попало в выделенный участок. */
let marquee: { start: Point; end: Point } | null = null;
/**
 * Поле ввода лежит поверх доски ровно там, где будет надпись, и того же размера букв.
 * fresh - новая надпись, её ещё нет на доске; from - какой она была до правки.
 * fixed - ширину надписи раньше сузили вручную: текст переносится по ней, а не растягивает строку.
 */
let editing: { card: Card; fresh: boolean; fixed: boolean; from: Lettering } | null = null;
/** Куда кликнули инструментом «Текст»: поле откроется, когда кнопку отпустят. */
let textAt: Point | null = null;
let picked: { strokes: Stroke[]; images: BoardImage[]; cards: Card[]; shapes: Shape[] } | null = null;
/**
 * След лазерной указки: точки доски со временем появления.
 * Он ничего не рисует на доске и не сохраняется - только показывает, куда смотреть.
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
  ctx.lineWidth = s.w ?? CHALK_WIDTH;
  ctx.beginPath();
  ctx.moveTo(s.points[0].x, s.points[0].y);
  for (const p of s.points) ctx.lineTo(p.x, p.y);
  ctx.stroke();
}

/* ---------- цвета темы ---------- */

/**
 * Цвет линии хранится кодом мела (#25231f - графит и т. д.),
 * а рисуется цветом текущей темы: в тёмной теме графит становится белым мелом.
 */
/** Все цвета мела: код (так цвет хранится на доске), переменная темы и название. */
const COLORS = [
  { code: '#25231f', css: '--chalk-ink', name: 'Основной' },
  { code: '#ae4f29', css: '--chalk-red', name: 'Терракота' },
  { code: '#33589e', css: '--chalk-blue', name: 'Синий' },
  { code: '#c0392b', css: '--chalk-scarlet', name: 'Красный' },
  { code: '#2f7d4f', css: '--chalk-green', name: 'Зелёный' },
  { code: '#a8800e', css: '--chalk-yellow', name: 'Жёлтый' },
  { code: '#6b3fa0', css: '--chalk-purple', name: 'Фиолетовый' },
  { code: '#b83f78', css: '--chalk-pink', name: 'Розовый' },
  { code: '#1f7f86', css: '--chalk-teal', name: 'Бирюзовый' },
  { code: '#7d776b', css: '--chalk-gray', name: 'Серый' },
];
const CHALK_VARS: Record<string, string> = Object.fromEntries(COLORS.map((c) => [c.code, c.css]));
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

/** Уголок для изменения размера - правый нижний угол картинки или карточки. */
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
 * Раскладывает текст карточки. Строки с табуляцией - это строки таблицы из Word:
 * подряд идущие такие строки рисуем одной таблицей с сеткой.
 */
function layoutCard(c: Card): CardLayout {
  const layout: CardLayout = { h: 0, texts: [], grid: [] };
  if (c.plain) {
    // Строку сдвигаем на половину просвета: так буквы стоят там же, где в поле ввода.
    ctx.font = `${TEXT_SIZE}px ${FONT}`;
    let y = c.y + TEXT_PAD + (TEXT_LINE - TEXT_SIZE) / 2;
    for (const text of wrapText(c.text, c.w - TEXT_PAD * 2)) {
      layout.texts.push({ x: c.x + TEXT_PAD, y, text, font: ctx.font });
      y += TEXT_LINE;
    }
    layout.h = layout.texts.length * TEXT_LINE + TEXT_PAD * 2;
    return layout;
  }
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

/** Таблица: ширина столбцов по самому длинному тексту, а если не влезает - сжимаем и переносим. */
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
  if (isPage(m)) return { ...rectOf(m), f: m.f, n: m.n };
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
    // У надписи листа нет: только буквы.
    if (local.plain) return;
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
  if (c.plain) {
    ctx.fillStyle = chalkColors[c.color ?? ''] ?? c.color ?? inkColor;
    ctx.textBaseline = 'top';
    for (const t of layout.texts) {
      ctx.font = t.font;
      ctx.fillText(t.text, t.x, t.y);
    }
    return;
  }
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

/** Всё, что задевает рамка: линию - любой её точкой, предмет - любым краем. */
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
  drawRemote();
  if (notebookOpen) drawPages();

  if (selected && !isPage(selected)) drawSelection(selected);
  drawPicked();
  if (tool === 'eraser' && eraserRing) drawEraserRing(eraserRing);
  drawLaser();
  updateLedge();
  updateShapeBar();
  updatePeer();
  if (editing) placeEditor();
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
    // Надпись, которую сейчас пишут, видна в поле ввода, а не на доске.
    if (c === editing?.card) continue;
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

/* ---------- живое рисование ---------- */
// Пока рисуешь линию, тянешь фигуру или двигаешь предмет, другой человек видит это сразу:
// раз в LIVE_EVERY мс уходят новые точки линии, фигура целиком или новое место предмета.

/** Сколько миллисекунд держать чужую незаконченную линию без новых точек (вдруг связь оборвалась). */
const LIVE_LIFE = 30000;
/** Как часто отправлять живое рисование: около 30 раз в секунду, глазу хватает. */
const LIVE_EVERY = 30;
const remoteStrokes = new Map<string, { stroke: Stroke; t: number }>();
const remoteShapes = new Map<string, { shape: Shape; t: number }>();
let remoteFrame = 0;

function sendLiveSoon(): void {
  liveTimer ??= setTimeout(flushLive, LIVE_EVERY);
}

/** Отправляет то, что изменилось с прошлой отправки. */
function flushLive(): void {
  liveTimer = undefined;
  if (current) {
    if (current.points.length <= liveSent) return;
    link.live({ type: 'live', kind: 'stroke', id: current.id, color: current.color, w: current.w, from: liveSent, points: current.points.slice(liveSent) });
    liveSent = current.points.length;
  } else if (draft) {
    link.live({ type: 'live', kind: 'shape', shape: { ...draft } });
  } else if (dragging && selected) {
    link.live({ type: 'live', kind: 'move', list: listOf(selected), id: selected.id, rect: boxSnapshot(selected) });
  }
}

/** Чужие живые изменения приходят часто: перерисовываем не чаще раза в кадр. */
function drawSoon(): void {
  if (!remoteFrame) remoteFrame = requestAnimationFrame(() => {
    remoteFrame = 0;
    draw();
  });
}

function receiveLive(msg: Live): void {
  const now = performance.now();
  if (msg.kind === 'stroke') {
    // Готовая линия уже пришла: опоздавший кусок не нужен.
    if (strokes.some((s) => s.id === msg.id)) return;
    let entry = remoteStrokes.get(msg.id);
    if (!entry) remoteStrokes.set(msg.id, (entry = { stroke: { id: msg.id, color: msg.color, ...(msg.w ? { w: msg.w } : {}), points: [] }, t: now }));
    entry.stroke.points.length = Math.min(entry.stroke.points.length, msg.from);
    entry.stroke.points.push(...msg.points);
    entry.t = now;
  } else if (msg.kind === 'shape') {
    if (shapes.some((s) => s.id === msg.shape.id)) return;
    remoteShapes.set(msg.shape.id, { shape: msg.shape as unknown as Shape, t: now });
  } else if (msg.kind === 'move') {
    // Этот предмет сейчас тянем мы сами: своё движение главнее.
    if (dragging && selected?.id === msg.id) return;
    const item = (live[msg.list] as unknown as Movable[] | undefined)?.find((i) => i.id === msg.id);
    if (item) Object.assign(item, msg.rect);
  } else if (msg.kind === 'cursor') {
    return receiveCursor(msg);
  }
  drawSoon();
}

/* ---------- где сейчас другой человек ---------- */
// Указатель ученика у учителя (и учителя у ученика): видно, куда он смотрит и что рисует.
// Если он за краем экрана, у края висит метка со стрелкой; клик по ней - перейти к нему.

const peerEl = document.querySelector<HTMLButtonElement>('#peer')!;
const peerName = peerEl.querySelector<HTMLSpanElement>('.peer-name')!;
const myRole = isGuest ? 'student' : 'teacher';
/** Как часто отправлять, где моя мышь, и через сколько без движения чужой указатель бледнеет. */
const CURSOR_EVERY = 60;
const PEER_IDLE = 8000;
/** Отступ метки от края экрана; сверху заголовок, снизу полка - их не закрываем. */
const EDGE = 12;
const EDGE_TOP = 60;
const EDGE_BOTTOM = 110;

type Peer = { x: number; y: number; role: 'teacher' | 'student'; away: boolean; t: number };
let peer: Peer | null = null;
let cursorAt: Point | null = null;
let cursorAway = false;
let cursorTimer: ReturnType<typeof setTimeout> | undefined;

function sendCursorSoon(): void {
  cursorTimer ??= setTimeout(() => {
    cursorTimer = undefined;
    if (cursorAt) link.live({ type: 'live', kind: 'cursor', role: myRole, x: cursorAt.x, y: cursorAt.y, ...(cursorAway ? { away: true } : {}) });
  }, CURSOR_EVERY);
}

function receiveCursor(msg: Extract<Live, { kind: 'cursor' }>): void {
  // Своя же вторая вкладка - не «другой человек».
  if (msg.role === myRole) return;
  peer = { x: msg.x, y: msg.y, role: msg.role, away: !!msg.away, t: performance.now() };
  updatePeer();
}

/** Учитель видит имя ученика, ученик - «Учитель». */
function peerLabel(role: Peer['role']): string {
  if (role === 'teacher') return 'Учитель';
  return (studentId && getStudent(studentId)?.name) || 'Ученик';
}

function updatePeer(): void {
  if (!peer) {
    peerEl.hidden = true;
    return;
  }
  peerEl.hidden = false;
  peerEl.dataset.role = peer.role;
  peerName.textContent = peerLabel(peer.role);
  peerEl.classList.toggle('is-idle', peer.away || performance.now() - peer.t > PEER_IDLE);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const sx = camera.x + peer.x * camera.zoom;
  const sy = camera.y + peer.y * camera.zoom;
  const inside = sx >= 0 && sx <= w && sy >= EDGE_TOP / 2 && sy <= h - EDGE_BOTTOM / 2;
  peerEl.classList.toggle('is-edge', !inside);
  if (inside) {
    peerEl.style.left = `${sx}px`;
    peerEl.style.top = `${sy}px`;
    peerEl.style.setProperty('--turn', '0deg');
    peerEl.removeAttribute('data-tip');
    peerEl.removeAttribute('aria-label');
    peerEl.tabIndex = -1;
    return;
  }
  // За краем: метка у края на линии от центра экрана к нему, стрелка смотрит в его сторону.
  // Метку держим целиком на экране: считаем по её собственному размеру.
  const halfW = peerEl.offsetWidth / 2;
  const halfH = peerEl.offsetHeight / 2;
  const ex = Math.min(Math.max(sx, EDGE + halfW), w - EDGE - halfW);
  const ey = Math.min(Math.max(sy, EDGE_TOP + halfH), h - EDGE_BOTTOM - halfH);
  // Стрелка курсора остриём смотрит влево-вверх (-135°): доворачиваем её на нужный угол.
  const turn = (Math.atan2(sy - ey, sx - ex) * 180) / Math.PI + 135;
  peerEl.style.left = `${ex}px`;
  peerEl.style.top = `${ey}px`;
  peerEl.style.setProperty('--turn', `${turn}deg`);
  peerEl.dataset.tip = `Перейти туда, где ${peer.role === 'teacher' ? 'учитель' : 'ученик'}`;
  peerEl.setAttribute('aria-label', `${peerLabel(peer.role)} за краем экрана. Перейти к нему`);
  peerEl.tabIndex = 0;
}

/** Переносит экран так, чтобы указатель другого был посередине. */
function goToPeer(): void {
  if (!peer) return;
  camera.x = canvas.clientWidth / 2 - peer.x * camera.zoom;
  camera.y = canvas.clientHeight / 2 - peer.y * camera.zoom;
  draw();
}

peerEl.addEventListener('click', goToPeer);
// Указатель бледнеет, когда его долго не двигают: проверяем раз в секунду.
setInterval(updatePeer, 1000);

/** Пришло готовое изменение: черновики с теми же id больше не нужны. */
function forgetLive(ids: string[]): void {
  for (const id of ids) {
    remoteStrokes.delete(id);
    remoteShapes.delete(id);
  }
}

/** Чужие незаконченные линии и фигуры поверх доски. */
function drawRemote(): void {
  const now = performance.now();
  for (const [id, e] of remoteStrokes) if (now - e.t > LIVE_LIFE) remoteStrokes.delete(id);
  for (const [id, e] of remoteShapes) if (now - e.t > LIVE_LIFE) remoteShapes.delete(id);
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const { shape } of remoteShapes.values()) {
    ctx.strokeStyle = ctx.fillStyle = chalkColors[shape.color] ?? shape.color;
    drawShape(ctx, shape);
  }
  for (const { stroke } of remoteStrokes.values()) if (stroke.points.length) drawStroke(stroke);
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

/** Масштаб от центра экрана - для кнопок на полке. */
function zoomCenter(factor: number): void {
  zoomAt(factor, { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });
}

/** Исходное положение доски и масштаб 100%. */
function resetView(): void {
  Object.assign(camera, { x: 0, y: 0, zoom: 1 });
  draw();
}

/** Курсор подсказывает, что сейчас произойдёт; at - точка доски под мышью (для указки). */
/**
 * Курсор лазера - светящаяся точка цвета следа, а не крестик: сразу видно, что это указка.
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
  else if (tool === 'text') canvas.style.cursor = 'text';
  else if (dragging?.mode === 'resize' || (at && selected && contains(handleRect(selected), at))) canvas.style.cursor = 'nwse-resize';
  // Указка - лапка: схватить можно и предмет, и саму доску.
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
  if (change.kind === 'style' || change.kind === 'retext') {
    Object.assign(change.item, reverse ? change.from : change.to);
    return;
  }
  if (change.kind === 'move') {
    Object.assign(change.image, reverse ? change.from : change.to);
    return;
  }
  if (change.kind === 'moves') {
    for (const m of change.moves) Object.assign(m.image, reverse ? m.from : m.to);
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
  for (const pg of change.pages ?? []) {
    if (add) pages.push(pg);
    else removeFrom(pages, pg);
    if (!add && selected === pg) selected = null;
  }
}

function listOf(m: Movable): ListName {
  return isPage(m) ? 'pages' : isShape(m) ? 'shapes' : isCard(m) ? 'cards' : 'images';
}

/** То же действие в виде изменений для сервера: другие вкладки найдут всё по id. */
function opsOf(change: Change, reverse = false): Op[] {
  if (change.kind === 'style') {
    return [{ type: 'style', list: 'shapes', id: change.item.id, style: reverse ? change.from : change.to }];
  }
  if (change.kind === 'retext') {
    return [{ type: 'style', list: 'cards', id: change.item.id, style: reverse ? change.from : change.to }];
  }
  if (change.kind === 'move') {
    const m = change.image;
    return [{ type: 'move', list: listOf(m), id: m.id, rect: reverse ? change.from : change.to }];
  }
  if (change.kind === 'moves') {
    return change.moves.map((m) => ({ type: 'move', list: listOf(m.image), id: m.image.id, rect: reverse ? m.from : m.to }));
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
  const r = eraseRadius(s);
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
  const r = eraseRadius(s);
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
  return runs.filter((points) => points.length > 1).map((points) => ({ id: newId(), color: s.color, ...(s.w ? { w: s.w } : {}), points }));
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

/** Верхняя фигура, карточка или картинка под точкой доски - в том порядке, как они лежат. */
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
const isPage = (m: Movable): m is Page => 'n' in m && 'f' in m;

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
  if (isPage(item)) {
    removeFrom(pages, item);
    record({ kind: 'remove', strokes: [], pages: [item] });
  } else if (isShape(item)) {
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
 * карточки - светлыми листами. После этого возвращаем цвета текущей темы.
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

/* ---------- листы тетради на доске ---------- */

/** Самая маленькая рамка листа, в пикселях экрана. */
const MIN_PAGE = 40;
/** Размер номера листа на рамке, в пикселях экрана. */
const BADGE = 22;


/** Номер листа по порядку: 1, 2, 3… - даже если внутренние номера с пропусками. */
function pageNumber(page: Page): number {
  return ordered(pages).indexOf(page) + 1;
}

/** Номер в углу рамки: за него, как и за край, рамку можно схватить. */
function badgeRect(page: Page): Rect {
  const size = BADGE / camera.zoom;
  return { x: page.x - size / 2, y: page.y - size / 2, w: size, h: size };
}

/** Рамки листов поверх доски: пунктир, номер, формат и уголок для размера. */
function drawPages(): void {
  const z = camera.zoom;
  for (const page of ordered(pages)) {
    const active = page === selected;
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = (active ? 2.5 : 1.5) / z;
    ctx.setLineDash(active ? [] : [8 / z, 6 / z]);
    ctx.strokeRect(page.x, page.y, page.w, page.h);
    ctx.setLineDash([]);

    const b = badgeRect(page);
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.w, b.h, 5 / z);
    ctx.fill();
    ctx.fillStyle = paperColor;
    ctx.font = `600 ${13 / z}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(pageNumber(page)), b.x + b.w / 2, b.y + b.h / 2 + 0.5 / z);
    ctx.textAlign = 'left';
    ctx.fillStyle = accentColor;
    ctx.font = `${12 / z}px ${FONT}`;
    ctx.fillText(FORMATS[page.f].label, b.x + b.w + 6 / z, b.y + b.h / 2);

    const h = handleRect(page);
    ctx.fillRect(h.x, h.y, h.w, h.h);
  }
}

/** За что схватили рамку листа: уголок - размер, номер или край - перенос. */
function pageGrip(p: Point): { page: Page; mode: 'move' | 'resize' } | null {
  const near = 8 / camera.zoom;
  const list = ordered(pages).reverse();
  for (const page of list) if (contains(handleRect(page), p)) return { page, mode: 'resize' };
  for (const page of list) {
    if (contains(badgeRect(page), p)) return { page, mode: 'move' };
    const outer = { x: page.x - near, y: page.y - near, w: page.w + near * 2, h: page.h + near * 2 };
    const inner = { x: page.x + near, y: page.y + near, w: page.w - near * 2, h: page.h - near * 2 };
    if (contains(outer, p) && !contains(inner, p)) return { page, mode: 'move' };
  }
  return null;
}

/** Номер для нового листа: после всех. */
function nextNumber(): number {
  return pages.reduce((max, pg) => Math.max(max, pg.n), 0) + 1;
}

function addPages(rects: Rect[], f: PageFormat): void {
  if (!rects.length) return;
  let n = nextNumber();
  const added = rects.map((r) => ({ id: newId(), ...r, f, n: n++ }));
  pages.push(...added);
  record({ kind: 'add', strokes: [], pages: added });
  draw();
  save();
}

/** Лист на то, что сейчас видно: в свободной части экрана, мимо панели тетради и полки. */
function addPageFromView(f: PageFormat): void {
  const panelWidth = notebookPanel.offsetWidth + 24;
  const top = toBoard({ x: 24, y: 64 });
  const bottom = toBoard({ x: canvas.clientWidth - panelWidth, y: canvas.clientHeight - 110 });
  const area = { x: top.x, y: top.y, w: bottom.x - top.x, h: bottom.y - top.y };
  const ratio = ratioOf(f);
  if (ratio === null) return addPages([area], f);
  // Форматный лист вписываем в видимую часть по центру.
  const w = Math.min(area.w, area.h / ratio);
  const h = w * ratio;
  addPages([{ x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h }], f);
}

/** Раскладывает всё, что есть на доске, по свободным рамкам. */
function autoPages(): void {
  const rects = autoLayout(itemBoxes());
  if (!rects.length) return showNotice('Доска пустая: раскладывать пока нечего.');
  addPages(rects, 'free');
  showNotice(`Добавлено листов: ${rects.length}. Поправь рамки, если нужно, и скачай PDF.`);
}

/** Меняет формат листа: ширина остаётся, высота подстраивается под пропорции. */
function setPageFormat(page: Page, f: PageFormat): void {
  const from = boxSnapshot(page);
  const ratio = ratioOf(f);
  page.f = f;
  if (ratio !== null) page.h = page.w * ratio;
  record({ kind: 'move', image: page, from, to: boxSnapshot(page) });
  draw();
  save();
}

/** Меняет лист местами с соседним: dir = -1 выше, 1 ниже. */
function shiftPage(page: Page, dir: number): void {
  const list = ordered(pages);
  const other = list[list.indexOf(page) + dir];
  if (!other) return;
  const a = boxSnapshot(page);
  const b = boxSnapshot(other);
  [page.n, other.n] = [other.n, page.n];
  record({
    kind: 'moves',
    moves: [
      { image: page, from: a, to: boxSnapshot(page) },
      { image: other, from: b, to: boxSnapshot(other) },
    ],
  });
  draw();
  save();
}

function removePage(page: Page): void {
  removeFrom(pages, page);
  if (selected === page) selected = null;
  record({ kind: 'remove', strokes: [], pages: [page] });
  draw();
  save();
}

/** Показывает лист целиком в свободной части экрана. */
function showPage(page: Page): void {
  const width = canvas.clientWidth - notebookPanel.offsetWidth - 48;
  const height = canvas.clientHeight - 64 - 110;
  camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(width / page.w, height / page.h)));
  camera.x = 24 + (width - page.w * camera.zoom) / 2 - page.x * camera.zoom;
  camera.y = 64 + (height - page.h * camera.zoom) / 2 - page.y * camera.zoom;
  selected = page;
  draw();
}

/* ---------- панель тетради ---------- */

const notebookButton = document.querySelector<HTMLButtonElement>('#notebook')!;
const notebookPanel = document.querySelector<HTMLElement>('#notebook-panel')!;
const pageList = document.querySelector<HTMLOListElement>('#page-list')!;
const pagesEmpty = document.querySelector<HTMLParagraphElement>('#pages-empty')!;
const newFormat = document.querySelector<HTMLSelectElement>('#new-format')!;
const qualitySelect = document.querySelector<HTMLSelectElement>('#quality')!;
const estimate = document.querySelector<HTMLSpanElement>('#estimate')!;
const downloadButton = document.querySelector<HTMLButtonElement>('#download-pdf')!;

function formatOptions(select: HTMLSelectElement, current: PageFormat): void {
  select.replaceChildren(
    ...(Object.keys(FORMATS) as PageFormat[]).map((f) => new Option(FORMATS[f].label, f, false, f === current)),
  );
}
formatOptions(newFormat, 'a4');
qualitySelect.replaceChildren(
  ...(Object.keys(QUALITIES) as Quality[]).map((q) => new Option(QUALITIES[q].label, q, false, q === 'normal')),
);

/** Есть ли в рамке картинка: такой лист весит больше и сжимается как фото. */
function hasPicture(page: Page): boolean {
  return images.some((i) => overlaps(i, page));
}

function updateEstimate(): void {
  const kb = estimateKb(pages, qualitySelect.value as Quality, hasPicture);
  estimate.textContent = pages.length ? `примерно ${formatSize(kb)}` : '';
}

function iconButton(label: string, text: string, onClick: () => void, off = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'page-action';
  b.textContent = text;
  b.setAttribute('aria-label', label);
  b.dataset.tip = label;
  b.disabled = off;
  b.addEventListener('click', onClick);
  return b;
}

/** Список листов в панели: номер, формат, порядок, удаление. */
function renderNotebook(): void {
  if (!notebookOpen) return;
  const list = ordered(pages);
  pagesEmpty.hidden = list.length > 0;
  downloadButton.disabled = !list.length;
  pageList.replaceChildren(
    ...list.map((page, i) => {
      const item = document.createElement('li');
      item.className = 'page-row';
      item.classList.toggle('is-active', page === selected);

      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'page-number';
      show.textContent = String(i + 1);
      show.setAttribute('aria-label', `Показать лист ${i + 1}`);
      show.dataset.tip = 'Показать лист на доске';
      show.addEventListener('click', () => showPage(page));

      const format = document.createElement('select');
      format.className = 'page-format';
      format.setAttribute('aria-label', `Формат листа ${i + 1}`);
      formatOptions(format, page.f);
      format.addEventListener('change', () => setPageFormat(page, format.value as PageFormat));

      item.append(
        show,
        format,
        iconButton('Поднять лист выше', '↑', () => shiftPage(page, -1), i === 0),
        iconButton('Опустить лист ниже', '↓', () => shiftPage(page, 1), i === list.length - 1),
        iconButton('Убрать лист', '×', () => removePage(page)),
      );
      return item;
    }),
  );
  updateEstimate();
}

function toggleNotebook(open = !notebookOpen): void {
  notebookOpen = open;
  notebookPanel.hidden = !open;
  notebookButton.setAttribute('aria-expanded', String(open));
  if (!open && selected && isPage(selected)) selected = null;
  renderNotebook();
  draw();
}

document.querySelector('#close-notebook')!.addEventListener('click', () => toggleNotebook(false));
document.querySelector('#add-page')!.addEventListener('click', () => addPageFromView(newFormat.value as PageFormat));
document.querySelector('#auto-pages')!.addEventListener('click', autoPages);
qualitySelect.addEventListener('change', updateEstimate);
downloadButton.addEventListener('click', () => void downloadPdf());

let downloading = false;

async function downloadPdf(): Promise<void> {
  if (downloading || !pages.length) return;
  downloading = true;
  downloadButton.textContent = 'Собираю…';
  try {
    await imagesReady();
    const title = document.querySelector('#topic-title')?.textContent?.trim() || 'Доска';
    const day = new Date().toISOString().slice(0, 10);
    await downloadNotebook({
      pages,
      paint: paintForPrint,
      hasPicture,
      quality: qualitySelect.value as Quality,
      title,
      // В имени файла не должно быть знаков, которые запрещены в Windows.
      fileName: `${title.replace(/[\\/:*?"<>|]/g, '-')} - ${day}.pdf`,
    });
    showNotice(`Тетрадь скачана: ${pages.length} ${pages.length === 1 ? 'лист' : pages.length < 5 ? 'листа' : 'листов'}.`);
  } catch {
    showNotice('Не получилось собрать PDF. Попробуй ещё раз или выбери качество полегче.');
  } finally {
    downloading = false;
    downloadButton.textContent = 'Скачать PDF';
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
  // На полке приподнимается ящик; цвет фигуры - последний выбранный мел.
  for (const b of palette.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === boxButton));
  for (const b of shapesBox.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === button));
  draw();
  toggleBox(false);
  updateCursor();
}

boxButton.addEventListener('click', () => {
  toggleColors(false);
  toggleBox();
});

/* ---------- все цвета мела ---------- */
// На полке три основных мелка и четвёртый - последний выбранный из палитры.

const colorPanel = document.querySelector<HTMLDivElement>('#color-panel')!;
const colorsButton = document.querySelector<HTMLButtonElement>('#colors')!;
const extraChalk = document.querySelector<HTMLButtonElement>('#chalk-extra')!;
const EXTRA_KEY = 'tiza:extra-chalk';
const RECENT_KEY = 'tiza:recent-colors';
/** Сколько недавних своих цветов помнить. */
const RECENT_MAX = 8;
/** Цвет мела: из набора (подстраивается под тему) или свой из палитры (рисуется как есть). */
type ChalkColor = { code: string; css?: string; name: string };

/** Цвет в HSL переводим в код #rrggbb: так он хранится на доске. */
function hslHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const part = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${part(0)}${part(8)}${part(4)}`;
}

/** Палитра - коробка мелков: 12 тонов по кругу, от бледного к тёмному, и ряд серых. У каждого своё название. */
const HUES = [0, 20, 38, 52, 80, 130, 160, 185, 205, 230, 265, 310];
const HUE_NAMES = ['красный', 'оранжевый', 'охристый', 'жёлтый', 'салатовый', 'зелёный', 'изумрудный', 'бирюзовый', 'голубой', 'синий', 'фиолетовый', 'малиновый'];
const SHADES: [number, string][] = [
  [80, 'Бледно-'],
  [65, 'Светло-'],
  [50, ''],
  [36, 'Тёмно-'],
];
const GRAYS: [number, string][] = [
  [100, 'Белый'],
  [91, 'Жемчужный'],
  [82, 'Серебристый'],
  [73, 'Светло-серый'],
  [64, 'Пепельный'],
  [55, 'Серый'],
  [46, 'Тёмно-серый'],
  [37, 'Графитовый'],
  [28, 'Асфальтовый'],
  [19, 'Угольный'],
  [10, 'Сажа'],
  [0, 'Чёрный'],
];
const capital = (text: string) => text[0].toUpperCase() + text.slice(1);
const PALETTE: { code: string; name: string }[] = [
  ...SHADES.flatMap(([l, prefix]) =>
    HUES.map((h, i) => ({ code: hslHex(h, l > 70 ? 75 : 65, l), name: capital(prefix + HUE_NAMES[i]) })),
  ),
  ...GRAYS.map(([l, name]) => ({ code: hslHex(0, 0, l), name })),
];

/** Название цвета: из коробки, из набора мелков или просто «свой цвет». */
function colorName(code: string): string {
  return PALETTE.find((c) => c.code === code)?.name ?? COLORS.find((c) => c.code === code)?.name ?? 'Свой цвет';
}

function readRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function rememberRecent(code: string): void {
  try {
    const list = [code, ...readRecent().filter((c) => c !== code)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Хранилище недоступно: недавние не запомнятся.
  }
}

/**
 * С какого цвета открыть системное окно выбора: с того, что видно на доске.
 * Код основного мела почти чёрный, а на тёмной доске он рисуется белым - начинать
 * с кода значило бы открыть тёмное колесо с яркостью около 15%.
 */
function pickerStart(code: string): string {
  const shown = (chalkColors[code] ?? code).trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(shown) ? shown : '#2f7d4f';
}

/** Свой цвет по коду: из набора, если совпал, иначе как есть. */
function colorOf(code: string): ChalkColor {
  return COLORS.find((c) => c.code === code) ?? { code, name: colorName(code) };
}

function toggleColors(open = colorPanel.hidden): void {
  if (open) {
    toggleBox(false);
    renderColors();
  }
  colorPanel.hidden = !open;
  colorsButton.setAttribute('aria-expanded', String(open));
}

/** Четвёртый мелок на полке становится этим цветом. */
function setExtraChalk(c: ChalkColor): void {
  extraChalk.dataset.color = c.code;
  extraChalk.style.setProperty('--chalk', c.css ? `var(${c.css})` : c.code);
  const name = c.name.toLowerCase();
  extraChalk.setAttribute('aria-label', `Мел, ${name} (4)`);
  extraChalk.dataset.tip = `Мел: ${name}`;
}

function pickColor(c: ChalkColor): void {
  const main = [...palette.querySelectorAll<HTMLButtonElement>('.chalk:not(#chalk-extra)')].find((b) => b.dataset.color === c.code);
  if (!main) {
    setExtraChalk(c);
    try {
      localStorage.setItem(EXTRA_KEY, c.code);
    } catch {
      // Хранилище недоступно: цвет на полке до перезагрузки.
    }
  }
  if (!c.css) rememberRecent(c.code);
  select(main ?? extraChalk);
  toggleColors(false);
}

function colorLabel(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'color-label';
  p.textContent = text;
  return p;
}

/** Мелок в коробке: круглая палочка цвета code со стёртым кончиком. Наведёшь - сверху его название. */
function swatch(code: string): HTMLButtonElement {
  const name = colorName(code);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'color-swatch';
  b.style.setProperty('--c', code);
  b.setAttribute('aria-label', name);
  b.setAttribute('aria-pressed', String(tool === 'pen' && color === code));
  b.addEventListener('click', () => pickColor({ code, name }));
  const show = () => (colorPanel.querySelector('.color-name')!.textContent = name);
  b.addEventListener('pointerenter', show);
  b.addEventListener('focus', show);
  return b;
}

/* ---------- толщина мела ---------- */

const WIDTH_KEY = 'tiza:chalk-width';
let chalkWidth = (() => {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    return w >= MIN_CHALK && w <= MAX_CHALK ? w : CHALK_WIDTH;
  } catch {
    return CHALK_WIDTH;
  }
})();

/** Мелки на полке толще или тоньше вместе с выбранной толщиной: её видно, не открывая палитру. */
function showChalkWidth(): void {
  palette.style.setProperty('--chalk-size', `${Math.round(10 + Math.min(chalkWidth, 16) * 0.75)}px`);
  for (const b of colorPanel.querySelectorAll<HTMLButtonElement>('.size-option')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.size) === chalkWidth));
  }
  const range = colorPanel.querySelector<HTMLInputElement>('.size-range');
  if (range) range.value = String(chalkWidth);
  const value = colorPanel.querySelector('.size-value');
  if (value) value.textContent = String(chalkWidth).replace('.', ',');
}

function setChalkWidth(w: number): void {
  chalkWidth = Math.min(MAX_CHALK, Math.max(MIN_CHALK, Math.round(w * 2) / 2));
  try {
    localStorage.setItem(WIDTH_KEY, String(chalkWidth));
  } catch {
    // Хранилище недоступно: толщина до перезагрузки.
  }
  showChalkWidth();
}

/** Пять готовых толщин кружками и ползунок для точной. */
function sizeControls(): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'size-row';
  const names = ['Тонкий', 'Обычный', 'Средний', 'Толстый', 'Очень толстый'];
  for (const [i, size] of CHALK_SIZES.entries()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'size-option';
    b.dataset.size = String(size);
    b.dataset.tip = names[i];
    b.setAttribute('aria-label', `${names[i]} мел`);
    b.style.setProperty('--dot', `${Math.max(3, size * 1.4)}px`);
    b.addEventListener('click', () => setChalkWidth(size));
    row.append(b);
  }
  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'size-range';
  range.min = String(MIN_CHALK);
  range.max = String(MAX_CHALK);
  range.step = '0.5';
  range.setAttribute('aria-label', 'Толщина мела');
  range.addEventListener('input', () => setChalkWidth(Number(range.value)));
  const value = document.createElement('span');
  value.className = 'size-value';
  row.append(range, value);
  return row;
}

function renderColors(): void {
  const chalks = document.createElement('div');
  chalks.className = 'color-chalks';
  chalks.append(
    ...COLORS.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'color-option';
      b.style.setProperty('--chalk', `var(${c.css})`);
      b.setAttribute('aria-pressed', String(tool === 'pen' && color === c.code));
      b.textContent = c.name;
      b.addEventListener('click', () => pickColor(c));
      return b;
    }),
  );
  // Коробка мелков; над ней название мелка под мышью, а пока мышь не на мелке - текущего цвета.
  const current = () => (tool === 'pen' ? colorName(color) : '');
  const nameLine = document.createElement('p');
  nameLine.className = 'color-name';
  nameLine.setAttribute('aria-live', 'polite');
  nameLine.textContent = current();
  const grid = document.createElement('div');
  grid.className = 'color-grid';
  grid.append(...PALETTE.map((c) => swatch(c.code)));
  grid.addEventListener('pointerleave', () => (nameLine.textContent = current()));

  // Свой цвет: системное окно выбора любого цвета. Пока его подбирают, мелок на полке
  // меняется сразу, а палитру не закрываем и не перестраиваем: иначе браузер закроет
  // и системное окно цветов.
  const custom = document.createElement('label');
  custom.className = 'color-custom';
  const input = document.createElement('input');
  input.type = 'color';
  input.value = pickerStart(color);
  const useCustom = () => {
    setExtraChalk(colorOf(input.value));
    if (tool !== 'pen' || color !== input.value) select(extraChalk);
  };
  input.addEventListener('input', useCustom);
  input.addEventListener('change', () => {
    useCustom();
    rememberRecent(input.value);
    try {
      localStorage.setItem(EXTRA_KEY, input.value);
    } catch {
      // Хранилище недоступно: цвет на полке до перезагрузки.
    }
  });
  custom.append(input, 'Свой цвет…');

  const recent = readRecent();
  const parts: HTMLElement[] = [
    colorLabel('Толщина мела - клавиши [ и ]'),
    sizeControls(),
    colorLabel('Мелки - сами подстраиваются под светлую и тёмную тему'),
    chalks,
    colorLabel('Коробка мелков'),
    nameLine,
    grid,
  ];
  if (recent.length) {
    const row = document.createElement('div');
    row.className = 'color-recent';
    row.append(...recent.map(swatch));
    parts.push(colorLabel('Недавние'), row);
  }
  parts.push(custom);
  colorPanel.replaceChildren(...parts);
  showChalkWidth();
}

showChalkWidth();

try {
  const saved = localStorage.getItem(EXTRA_KEY);
  if (saved && /^#[0-9a-f]{6}$/i.test(saved)) setExtraChalk(colorOf(saved));
} catch {
  // Хранилище недоступно: на полке зелёный.
}

/* ---------- как нарисована фигура ---------- */

/** Как рисовать новые фигуры. Цвет не тут: он всегда как у выбранного мела. */
const LOOK_KEY = 'tiza:shape-look';
const shapeLook: Omit<Look, 'color'> = (() => {
  const base = { width: 3, dash: false, fill: false, parts: 4 };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(LOOK_KEY) ?? '{}') };
  } catch {
    return base;
  }
})();

function lookOf(s: Shape): Look {
  return { color: s.color, width: s.width ?? 3, dash: !!s.dash, fill: !!s.fill, parts: s.parts ?? 4 };
}

const WIDTH_NAMES = ['Тонкая линия', 'Обычная линия', 'Толстая линия'];

function styleButton(tip: string, pressed: boolean, svg: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'style-button';
  b.setAttribute('aria-pressed', String(pressed));
  b.setAttribute('aria-label', tip);
  b.dataset.tip = tip;
  b.innerHTML = svg;
  b.addEventListener('click', onClick);
  return b;
}

function styleGroup(...children: HTMLElement[]): HTMLDivElement {
  const g = document.createElement('div');
  g.className = 'style-group';
  g.append(...children);
  return g;
}

/**
 * Кнопки свойств фигуры: цвет (только у выделенной), толщина, пунктир, заливка, доли.
 * kind - какая фигура: у незамкнутых нет заливки, доли есть только у круга долей.
 */
function renderStyle(
  host: HTMLElement,
  look: Look | Omit<Look, 'color'>,
  kind: ShapeKind | null,
  change: (patch: Partial<Look>) => void,
  preview: (patch: Partial<Look>) => void = change,
): void {
  const groups: HTMLElement[] = [];
  if ('color' in look) {
    const swatches = COLORS.map((c) => {
      const b = styleButton(c.name, c.code === look.color, '', () => change({ color: c.code }));
      b.classList.add('style-swatch');
      b.style.setProperty('--chalk', `var(${c.css})`);
      return b;
    });
    // Свой цвет из палитры: показываем его рядом, а кружок-радуга открывает выбор любого цвета.
    if (!COLORS.some((c) => c.code === look.color)) {
      const own = styleButton('Свой цвет', true, '', () => {});
      own.classList.add('style-swatch');
      own.style.setProperty('--chalk', look.color);
      swatches.push(own);
    }
    const any = document.createElement('label');
    any.className = 'style-button style-any';
    any.dataset.tip = 'Любой цвет';
    const input = document.createElement('input');
    input.type = 'color';
    input.setAttribute('aria-label', 'Любой цвет');
    input.value = pickerStart(look.color);
    // Пока подбирают цвет, фигура красится сразу, а в историю попадает одно изменение - в конце.
    input.addEventListener('input', () => preview({ color: input.value }));
    input.addEventListener('change', () => {
      rememberRecent(input.value);
      change({ color: input.value });
    });
    any.append(input);
    groups.push(styleGroup(...swatches, any));
  }
  groups.push(
    styleGroup(
      ...WIDTHS.map((w, i) =>
        styleButton(WIDTH_NAMES[i], look.width === w, `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16" style="stroke-width:${1 + i * 1.6}" /></svg>`, () => change({ width: w })),
      ),
    ),
  );
  const toggles = [
    styleButton('Пунктир', look.dash, '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4M10 12h4M17 12h4" /></svg>', () => change({ dash: !look.dash })),
  ];
  if (!kind || canFill(kind)) {
    toggles.push(
      styleButton(
        kind === 'fraction' ? 'Закрасить одну долю' : 'Заливка',
        look.fill,
        '<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="filled" x="5" y="5" width="14" height="14" rx="2" /></svg>',
        () => change({ fill: !look.fill }),
      ),
    );
  }
  groups.push(styleGroup(...toggles));
  if (!kind || kind === 'fraction') {
    const count = document.createElement('span');
    count.className = 'style-count';
    count.textContent = String(look.parts);
    count.dataset.tip = 'На сколько долей поделён круг';
    const step = (d: number) => () => change({ parts: Math.min(MAX_PARTS, Math.max(MIN_PARTS, look.parts + d)) });
    groups.push(
      styleGroup(
        styleButton('Меньше долей', false, '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" /></svg>', step(-1)),
        count,
        styleButton('Больше долей', false, '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M12 6v12" /></svg>', step(1)),
      ),
    );
  }
  host.replaceChildren(...groups);
}

/** Свойства новых фигур в ящике. */
const shapeDefaults = document.querySelector<HTMLDivElement>('#shape-defaults')!;
function renderDefaults(): void {
  renderStyle(shapeDefaults, shapeLook, null, (patch) => {
    Object.assign(shapeLook, patch);
    try {
      localStorage.setItem(LOOK_KEY, JSON.stringify(shapeLook));
    } catch {
      // Хранилище недоступно: выбор действует до перезагрузки.
    }
    renderDefaults();
  });
}
renderDefaults();

/** Свойства выделенной фигуры: панель над ней. */
const shapeBar = document.querySelector<HTMLDivElement>('#shape-bar')!;
/** Для какой фигуры и в каком виде панель уже построена: не перестраиваем её на каждом кадре. */
let barKey = '';

function restyle(shape: Shape, patch: Partial<Look>, from = lookOf(shape)): void {
  const to = { ...from, ...patch };
  Object.assign(shape, to);
  record({ kind: 'style', item: shape, from, to });
  draw();
  save();
}

/** Показывает панель над выделенной фигурой, пока её не тянут. */
function updateShapeBar(): void {
  const shape = selected && isShape(selected) && !dragging && tool === 'pointer' ? selected : null;
  shapeBar.hidden = !shape;
  if (!shape) {
    barKey = '';
    return;
  }
  const key = `${shape.id}:${JSON.stringify(lookOf(shape))}`;
  // Открыто системное окно цветов: панель не перестраиваем, иначе оно закроется.
  const picking = (document.activeElement as HTMLInputElement | null)?.type === 'color' && shapeBar.contains(document.activeElement);
  if (key !== barKey && !picking) {
    barKey = key;
    const base = lookOf(shape);
    renderStyle(
      shapeBar,
      base,
      shape.kind,
      (patch) => restyle(shape, patch, base),
      (patch) => {
        Object.assign(shape, patch);
        draw();
      },
    );
    // Окно цветов закрыли: обновляем панель, чтобы она показала новый цвет.
    shapeBar.querySelector('input[type=color]')?.addEventListener('blur', () => setTimeout(updateShapeBar));
  }
  // Над фигурой по центру; не помещается сверху - под ней; не выходит за края окна.
  const b = boundsOf(shape);
  const left = camera.x + (b.x + b.w / 2) * camera.zoom - shapeBar.offsetWidth / 2;
  const top = camera.y + b.y * camera.zoom - shapeBar.offsetHeight - 14;
  const below = camera.y + (b.y + b.h) * camera.zoom + 14;
  shapeBar.style.left = `${Math.max(8, Math.min(innerWidth - shapeBar.offsetWidth - 8, left))}px`;
  shapeBar.style.top = `${top > 8 ? top : Math.min(below, innerHeight - shapeBar.offsetHeight - 120)}px`;
}
shapesBox.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-shape]');
  if (button) chooseShape(button);
});

/* ---------- надписи ---------- */

const editor = document.createElement('textarea');
editor.className = 'text-editor';
editor.hidden = true;
editor.rows = 1;
editor.setAttribute('aria-label', 'Надпись на доске');
document.body.append(editor);

/** Ширина надписи в одну строку на абзац, при масштабе 1. */
function naturalWidth(text: string): number {
  ctx.font = `${TEXT_SIZE}px ${FONT}`;
  const widest = Math.max(TEXT_SIZE, ...text.split('\n').map((line) => ctx.measureText(line).width));
  return Math.ceil(widest) + TEXT_PAD * 2 + 2;
}

/** Верхняя надпись под точкой доски. */
function textAtPoint(p: Point): Card | null {
  for (let i = cards.length - 1; i >= 0; i--) if (cards[i].plain && contains(cards[i], p)) return cards[i];
  return null;
}

/** Новая надпись там, где кликнули, текущим мелом. Буквы на экране одного размера при любом масштабе. */
function newText(p: Point): Card {
  const s = Math.min(MAX_CARD_SCALE, Math.max(MIN_CARD_SCALE, 1 / camera.zoom));
  return {
    id: newId(),
    x: p.x - TEXT_PAD * s,
    y: p.y - (TEXT_PAD + TEXT_LINE / 2) * s,
    w: 0,
    h: 0,
    s,
    title: '',
    text: '',
    plain: true,
    color,
  };
}

function openEditor(card: Card, fresh: boolean): void {
  if (editing) closeEditor();
  const s = card.s ?? 1;
  editing = {
    card,
    fresh,
    fixed: !fresh && card.w / s < naturalWidth(card.text) - 1,
    from: { text: card.text, w: card.w },
  };
  selected = null;
  editor.value = card.text;
  editor.hidden = false;
  placeEditor();
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
  draw();
}

/** Ставит поле ввода на место надписи: за доской следит при сдвиге и масштабе. */
function placeEditor(): void {
  if (!editing) return;
  const c = editing.card;
  const k = (c.s ?? 1) * camera.zoom;
  const r = canvas.getBoundingClientRect();
  const width = editing.fixed ? c.w / (c.s ?? 1) : naturalWidth(editor.value) + TEXT_SIZE;
  Object.assign(editor.style, {
    left: `${r.left + c.x * camera.zoom + camera.x}px`,
    top: `${r.top + c.y * camera.zoom + camera.y}px`,
    width: `${width * k}px`,
    padding: `${TEXT_PAD * k}px`,
    fontSize: `${TEXT_SIZE * k}px`,
    lineHeight: `${TEXT_LINE * k}px`,
    color: chalkColors[c.color ?? ''] ?? c.color ?? inkColor,
    whiteSpace: editing.fixed ? 'pre-wrap' : 'pre',
  });
  editor.style.height = '0';
  editor.style.height = `${editor.scrollHeight}px`;
}

/** Дописали: новая надпись встаёт на доску, правка уходит в историю, пустая надпись пропадает. */
function closeEditor(): void {
  if (!editing) return;
  const { card, fresh, fixed, from } = editing;
  editing = null;
  editor.hidden = true;
  editor.blur();
  const text = editor.value.replace(/\s+$/, '');
  const w = fixed ? card.w : naturalWidth(text) * (card.s ?? 1);
  if (fresh) {
    if (text.trim()) {
      Object.assign(card, { text, w });
      cards.push(card);
      record({ kind: 'add', strokes: [], cards: [card] });
      save();
    }
  } else if (!cards.includes(card)) {
    // Пока писали, надпись убрали с другой стороны: править уже нечего.
  } else if (!text.trim()) {
    removeFrom(cards, card);
    record({ kind: 'remove', strokes: [], cards: [card] });
    save();
  } else if (text !== from.text || w !== from.w) {
    const to = { text, w };
    Object.assign(card, to);
    record({ kind: 'retext', item: card, from, to });
    save();
  }
  draw();
}

editor.addEventListener('input', placeEditor);
editor.addEventListener('blur', () => closeEditor());
editor.addEventListener('keydown', (e) => {
  // Пока пишут, буквы не переключают инструменты доски, а Ctrl/⌘ + Z отменяет набранное в самом поле.
  e.stopPropagation();
  // Esc или Ctrl/⌘ + Enter - готово; просто Enter - новая строка.
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
    e.preventDefault();
    closeEditor();
  }
});

// Двойной клик указкой по надписи - переписать её.
canvas.addEventListener('dblclick', (e) => {
  if (tool !== 'pointer') return;
  const hit = textAtPoint(pointOf(e));
  if (hit) openEditor(hit, false);
});

/* ---------- мышь, палец, стилус ---------- */

canvas.addEventListener('pointerdown', (e) => {
  const p = pointOf(e);
  toggleBox(false);
  toggleColors(false);
  // Клик мимо поля ввода дописывает надпись; инструментом «Текст» этот клик больше ничего не делает.
  if (editing) {
    closeEditor();
    if (tool === 'text' && e.button === 0) return;
  }
  // Правая кнопка мыши - лазер, каким бы инструментом ни рисовали: зажал и показываешь.
  if (e.button === 2) {
    e.preventDefault();
    // На полке на это время горит лазер, а отпустил кнопку - вернётся то, что было.
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
  // Средняя кнопка мыши или зажатый пробел - двигаем доску.
  if (e.button === 1 || spaceHeld) {
    e.preventDefault();
    panning = screenPoint(e);
    updateCursor();
    return;
  }
  // Пока открыта тетрадь, рамку листа можно схватить любым инструментом: за край, номер или уголок.
  if (notebookOpen && e.button === 0) {
    const grip = pageGrip(p);
    if (grip) {
      selected = grip.page;
      dragging = { mode: grip.mode, start: p, from: boxSnapshot(grip.page) };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Указатель уже отпущен.
      }
      canvas.style.cursor = grip.mode === 'resize' ? 'nwse-resize' : 'grabbing';
      draw();
      return;
    }
    if (selected && isPage(selected)) selected = null;
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
      // Указатель уже отпущен - тогда и захватывать нечего.
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
    draft = {
      id: crypto.randomUUID().slice(0, 8),
      kind: shapeKind,
      color,
      x: p.x,
      y: p.y,
      w: 0,
      h: 0,
      width: shapeLook.width,
      dash: shapeLook.dash,
      fill: shapeLook.fill && canFill(shapeKind),
      ...(shapeKind === 'fraction' ? { parts: shapeLook.parts } : {}),
    };
    return;
  }
  if (tool === 'text') {
    // Поле ввода открываем, когда кнопку отпустят: иначе фокус сразу уйдёт обратно на доску.
    textAt = p;
    return;
  }
  if (tool === 'eraser') {
    erased = { removed: [], added: [], wipes: new Map() };
    eraserLast = null;
    eraseTo(p);
    return;
  }
  current = { id: newId(), color, ...(chalkWidth !== CHALK_WIDTH ? { w: chalkWidth } : {}), points: [p] };
  liveSent = 0;
  sendLiveSoon();
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
    } else if (isPage(selected)) {
      const ratio = ratioOf(selected.f);
      const min = MIN_PAGE / camera.zoom;
      if (ratio === null) {
        // Свободная рамка: ширина и высота меняются отдельно.
        selected.w = Math.max(min, from.w + dx);
        selected.h = Math.max(min, from.h + dy);
      } else {
        // У формата пропорции листа держатся сами.
        const w = Math.max(min, from.w + Math.max(dx, dy / ratio));
        selected.w = w;
        selected.h = w * ratio;
      }
    } else if (isShape(selected)) {
      // У фигуры уголок - это её второй конец: тянем его куда угодно.
      selected.w = from.w + dx;
      selected.h = from.h + dy;
    } else if (isCard(selected)) {
      const s0 = from.s ?? 1;
      if (e.shiftKey) {
        // С Shift меняется только ширина: текст переносится по-новому, высота подстроится.
        selected.w = Math.max((selected.plain ? MIN_TEXT : MIN_CARD) * s0, from.w + dx);
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
    sendLiveSoon();
    return draw();
  }
  // Над рамкой листа курсор подсказывает, что её можно двигать или растягивать.
  if (notebookOpen && !current && !erased && !draft && !marquee) {
    const grip = pageGrip(pointOf(e));
    if (grip) {
      canvas.style.cursor = grip.mode === 'resize' ? 'nwse-resize' : 'move';
      return;
    }
    updateCursor();
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
    sendLiveSoon();
    return draw();
  }
  if (!current) return;
  current.points.push(pointOf(e));
  sendLiveSoon();
  draw();
});

function finish(): void {
  // Живой кадр, не успевший уйти, уже не нужен: сейчас уйдёт готовое изменение.
  clearTimeout(liveTimer);
  liveTimer = undefined;
  const wiped = erased && (erased.removed.length > 0 || erased.wipes.size > 0);
  let changed = current !== null || !!wiped;
  if (current) record({ kind: 'add', strokes: [current] });
  if (erased && wiped) {
    const wipes = [...erased.wipes].map(([item, wipe]) => ({ item, wipe }));
    record({ kind: 'erase', removed: erased.removed, added: erased.added, wipes });
  }
  if (draft) {
    // Просто кликнули, не растягивая, - ставим фигуру обычного размера.
    if (Math.abs(draft.w) < 4 && Math.abs(draft.h) < 4) Object.assign(draft, defaultSize(draft.kind));
    shapes.push(draft);
    record({ kind: 'add', strokes: [], shapes: [draft] });
    draft = null;
    changed = true;
  }
  if (dragging && selected) {
    const to = boxSnapshot(selected);
    const from = dragging.from;
    if (to.x !== from.x || to.y !== from.y || to.w !== from.w || to.h !== from.h || to.s !== from.s || to.f !== from.f) {
      record({ kind: 'move', image: selected, from, to });
      changed = true;
    }
  }
  if (marquee) {
    picked = pickIn(rectBetween(marquee.start, marquee.end));
    marquee = null;
    const n = pickedCount();
    if (!n) picked = null;
    showNotice(n ? `Выделено: ${n}. Delete - удалить, Esc - снять выделение.` : '');
    draw();
  }
  if (textAt) {
    const hit = textAtPoint(textAt);
    openEditor(hit ?? newText(textAt), !hit);
    textAt = null;
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
  // Фигуру отпустили: над ней снова появляется панель свойств.
  updateShapeBar();
  if (changed) save();
}

// Где моя мышь на доске - другому, даже когда ничего не рисую.
canvas.addEventListener('pointermove', (e) => {
  cursorAt = pointOf(e);
  cursorAway = false;
  sendCursorSoon();
});

canvas.addEventListener('pointerleave', () => {
  cursorAway = true;
  sendCursorSoon();
  eraserRing = null;
  if (tool === 'eraser') draw();
});
canvas.addEventListener('pointerup', finish);
// Правая кнопка занята лазером: меню браузера над доской не нужно.
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointercancel', finish);

/** Колесо или два пальца на тачпаде двигают доску; с Ctrl/⌘ (или щипок) - масштаб. */
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
  if (button.id === 'notebook') return toggleNotebook();
  // Ящик открывается своим обработчиком и сам не меняет инструмент.
  if (button.id === 'shapes-box') return;
  if (button.id === 'colors') return toggleColors();
  select(button);
});

undoButton.addEventListener('click', undo);
redoButton.addEventListener('click', redo);
document.querySelector('#zoom-in')!.addEventListener('click', () => zoomCenter(1.25));
document.querySelector('#zoom-out')!.addEventListener('click', () => zoomCenter(1 / 1.25));
zoomButton.addEventListener('click', resetView);

/* ---------- клавиатура ---------- */

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !linkPanel.hidden) {
    toggleLinkPanel(false);
    linkStatus.focus();
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();

  // Ctrl/⌘ + Z - отменить, с Shift - вернуть; Ctrl + Y - тоже вернуть.
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
  // Ctrl/⌘ + 0 - вернуть доску на место и масштаб 100%.
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
  if (e.key === 'Escape' && !colorPanel.hidden) {
    toggleColors(false);
    colorsButton.focus();
    return;
  }
  if (e.key === 'Escape' && !shapesBox.hidden) {
    toggleBox(false);
    return;
  }
  if (e.key === 'Escape' && notebookOpen && !selected) {
    toggleNotebook(false);
    return;
  }
  if (e.key === 'Escape' && selected) {
    selected = null;
    draw();
    return;
  }

  // [ и ] - мел тоньше и толще, по готовым толщинам.
  if (e.key === '[' || e.key === 'х' || e.key === ']' || e.key === 'ъ') {
    const up = e.key === ']' || e.key === 'ъ';
    const next = up ? CHALK_SIZES.find((w) => w > chalkWidth) : [...CHALK_SIZES].reverse().find((w) => w < chalkWidth);
    setChalkWidth(next ?? (up ? MAX_CHALK : MIN_CHALK));
    return;
  }
  if (key === 'l' || key === 'д') select(palette.querySelector<HTMLButtonElement>('[data-tool="laser"]')!);
  // 1, 2, 3 - мелки по порядку, 4 - цвет из палитры; E - губка; V - указка; L - лазер; S - выделение.
  const chalk = palette.querySelectorAll<HTMLButtonElement>('[data-color]')[Number(e.key) - 1];
  if (chalk) select(chalk);
  if (key === 'e' || key === 'у') select(palette.querySelector<HTMLButtonElement>('[data-tool="eraser"]')!);
  if (key === 'v' || key === 'м') select(palette.querySelector<HTMLButtonElement>('[data-tool="pointer"]')!);
  if (key === 's' || key === 'ы') select(palette.querySelector<HTMLButtonElement>('[data-tool="select"]')!);
  if (key === 't' || key === 'е') select(palette.querySelector<HTMLButtonElement>('[data-tool="text"]')!);
});

window.addEventListener('keyup', (e) => {
  if (e.code !== 'Space') return;
  spaceHeld = false;
  updateCursor();
});

window.addEventListener('resize', resize);
// Сменили тему кнопкой или в системе - перекрашиваем доску сразу, без перезагрузки.
window.addEventListener('themechange', () => {
  readTheme();
  draw();
});

/* ---------- связь с сервером ---------- */

/** Те же массивы, что рисует доска: изменения с сервера меняют их на месте. */
const live = { strokes, images, cards, shapes, pages } as unknown as BoardData;

/** Значок связи вверху: виден, только когда у сайта есть сервер. */
const linkStatus = document.querySelector<HTMLButtonElement>('#link-status')!;
const LINK_TEXT: Record<LinkState, [string, string]> = {
  connecting: ['подключение…', 'Сервер просыпается, это бывает до минуты. Пока ученик не видит твоих изменений.'],
  online: ['на связи', 'Ученик видит изменения на доске сразу.'],
  offline: ['нет связи', 'Связь с сервером пропала, пробую снова. Пока ученик не видит твоих изменений.'],
  missing: ['доска не найдена', 'Ссылка неверная или устарела. Попроси у учителя новую.'],
  waiting: ['ждём учителя', 'Учитель ещё не открывал эту доску. Она появится, как только он её откроет.'],
};

let linkState: LinkState = 'connecting';
let linkInfo: LinkInfo = { server: null, rtt: null, others: null };

/** Кто на другом конце: учителю интересен ученик, ученику - учитель. */
function otherHere(): boolean | null {
  const others = linkInfo.others;
  if (!others) return null;
  return (isGuest ? others.teacher : others.student) > 0;
}

function showLink(state: LinkState): void {
  linkState = state;
  linkStatus.hidden = false;
  linkStatus.dataset.state = state;
  const here = state === 'online' && otherHere();
  linkStatus.textContent = here ? `${LINK_TEXT[state][0]}, ${isGuest ? 'учитель' : 'ученик'} здесь` : LINK_TEXT[state][0];
  linkStatus.dataset.tip = `${LINK_TEXT[state][1]} Нажми - подробнее о связи.`;
  if (!linkPanel.hidden) renderLinkPanel();
}

/* ---------- окошко связи ---------- */

const linkPanel = document.querySelector<HTMLDivElement>('#link-panel')!;
const linkPeer = document.querySelector<HTMLParagraphElement>('#link-peer')!;
const serverList = document.querySelector<HTMLUListElement>('#server-list')!;
const serverChoice = document.querySelector<HTMLDivElement>('#server-choice')!;
/** Задержка до каждого сервера, мс: null - не ответил, undefined - ещё меряем. */
const latency = new Map<string, number | null>();
let probeTimer: ReturnType<typeof setInterval> | undefined;

function renderLinkPanel(): void {
  const here = otherHere();
  const who = isGuest ? 'Учитель' : 'Ученик';
  linkPeer.dataset.here = String(here === true);
  linkPeer.textContent =
    linkState !== 'online' ? 'Нет связи с сервером: кто на доске, пока не видно.'
    : here === null ? 'Сервер не сообщает, кто на доске: его пора обновить.'
    : here ? `${who} на доске и видит изменения сразу.`
    : `${who} сейчас не на доске${SERVERS.length > 1 ? ' или подключён к другому серверу' : ''}.`;

  serverList.replaceChildren(
    ...SERVERS.map((server) => {
      const current = linkInfo.server?.name === server.name && linkState === 'online';
      // У текущего сервера задержку знаем по ping, у остальных - по пробному запросу.
      const ms = current ? (linkInfo.rtt ?? latency.get(server.name)) : latency.get(server.name);
      const item = document.createElement('li');
      item.className = 'server';
      item.dataset.state = ms === null ? 'down' : ms === undefined ? 'unknown' : 'up';
      const name = document.createElement('span');
      name.className = 'server-name';
      name.textContent = server.name;
      const detail = document.createElement('span');
      detail.className = 'server-detail';
      detail.textContent = [current ? 'сейчас' : '', ms === null ? 'не отвечает' : ms === undefined ? 'меряю…' : `${ms} мс`]
        .filter(Boolean)
        .join(', ');
      item.append(name, detail);
      return item;
    }),
  );

  // Выбирать есть из чего, только когда серверов больше одного.
  serverChoice.hidden = SERVERS.length < 2;
  if (serverChoice.hidden) return;
  const chosen = chosenServer();
  serverChoice.replaceChildren(
    ...[null, ...SERVERS.map((x) => x.name)].map((name) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'server-option';
      option.setAttribute('role', 'radio');
      option.setAttribute('aria-checked', String(name === chosen));
      option.textContent = name ?? 'Авто';
      option.dataset.tip = name ? `Всегда идти к серверу «${name}», пока он отвечает` : 'Первый сервер, который отвечает. Так учитель и ученик оказываются на одном';
      option.addEventListener('click', () => {
        if (name === chosen) return;
        chooseServer(name);
        link.reconnect();
        renderLinkPanel();
      });
      return option;
    }),
  );
}

async function measureServers(): Promise<void> {
  await Promise.all(
    SERVERS.map(async (server) => {
      latency.set(server.name, await probe(server));
    }),
  );
  if (!linkPanel.hidden) renderLinkPanel();
}

function toggleLinkPanel(open = linkPanel.hidden): void {
  linkPanel.hidden = !open;
  linkStatus.setAttribute('aria-expanded', String(open));
  clearInterval(probeTimer);
  if (!open) return;
  latency.clear();
  renderLinkPanel();
  void measureServers();
  probeTimer = setInterval(measureServers, 10000);
}

linkStatus.addEventListener('click', () => toggleLinkPanel());
document.addEventListener('pointerdown', (e) => {
  if (!linkPanel.hidden && !linkPanel.contains(e.target as Node) && !linkStatus.contains(e.target as Node)) toggleLinkPanel(false);
});

const link = connect(serverRoom, isGuest ? 'student' : 'teacher', {
  local: () => (isGuest ? null : live),
  init(board) {
    for (const list of LISTS) {
      // Что уже есть во вкладке, обновляем на месте: на эти предметы ссылается история отмен,
      // и после переподключения отменять можно то, что сделано до обрыва связи.
      const mine = new Map(live[list].map((i) => [i.id, i]));
      const next = (board[list] ?? []).map((item) => {
        const own = mine.get(item.id);
        if (!own) return item;
        Object.assign(own, item);
        own.wipes = item.wipes;
        return own;
      });
      live[list].splice(0, live[list].length, ...next);
    }
    if (selected && ![...images, ...cards, ...shapes, ...pages].includes(selected)) selected = null;
    draw();
    save();
  },
  op(op) {
    applyOp(live, op);
    if (op.type === 'add') forgetLive(op.items.map((i) => i.id));
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
    if (selected && ![...images, ...cards, ...shapes, ...pages].includes(selected)) selected = null;
    draw();
    save();
  },
  state: showLink,
  info(info) {
    linkInfo = info;
    // Другой ушёл с доски или связь пропала: его указатель больше не показываем.
    if (!info.others || (isGuest ? info.others.teacher : info.others.student) === 0) {
      peer = null;
      updatePeer();
    }
    showLink(linkState);
  },
  live: receiveLive,
  laser(point: Laser) {
    remoteTrail.push({ x: point.x, y: point.y, t: performance.now(), start: point.start });
    animateLaser();
  },
});
const sendOp = link.send;

readTheme();
resize();
