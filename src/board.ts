import { contains, imageElement, readImage, rectOf, type BoardImage, type Rect } from './images';
import { boardKey, getStudent } from './students';
import { readDocx, splitTasks } from './tasks';
import './theme';

type Point = { x: number; y: number };
type Stroke = { color: string; points: Point[] };
type Tool = 'pen' | 'eraser' | 'pointer';
/** Карточка задания из Word. Высота считается по тексту при отрисовке. */
type Card = { id: string; x: number; y: number; w: number; h: number; title: string; text: string };
/** То, что указка умеет двигать: картинка или карточка. */
type Movable = BoardImage | Card;
/**
 * Одно действие для истории:
 * линии, картинки или карточки добавили / стёрли, либо что-то сдвинули или изменили размер.
 */
type Change =
  | { kind: 'add' | 'remove'; strokes: Stroke[]; images?: BoardImage[]; cards?: Card[] }
  | { kind: 'move'; image: Movable; from: Rect; to: Rect };

const ERASER_RADIUS = 12;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;
/** Размер уголка для изменения размера картинки — в пикселях экрана. */
const HANDLE = 12;
/** Меньше этой ширины картинку не сжать. */
const MIN_IMAGE = 24;
/** Карточки заданий: ширина по умолчанию, самая узкая, отступы и шрифт — в координатах доски. */
const CARD_WIDTH = 420;
const MIN_CARD = 200;
const CARD_PAD = 16;
const CARD_GAP = 24;
const CARD_LINE = 26;
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
/** Чья это доска и какой темы: board.html?student=andrey&topic=… */
const params = new URLSearchParams(location.search);
const studentId = params.get('student');
const topicId = params.get('topic');
/**
 * Ключ, под которым доска лежит в хранилище браузера: у каждой темы свой.
 * Без ученика и темы открывается старая общая доска.
 */
const STORAGE_KEY = studentId && topicId ? boardKey(studentId, topicId) : 'tiza:board';

const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;
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
  const student = studentId ? getStudent(studentId) : undefined;
  const topic = student?.topics?.find((t) => t.id === topicId);
  if (!student) return; // общая доска: ссылка ведёт к списку учеников, как в разметке
  back.href = `/student.html?id=${encodeURIComponent(student.id)}`;
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

/* ---------- сохранение в браузере ---------- */

/**
 * Достаёт сохранённую доску; если её нет или данные испорчены, доска пустая.
 * Старые доски хранились просто списком линий — их тоже понимаем.
 */
function load(): { strokes: Stroke[]; images: BoardImage[]; cards: Card[] } {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (Array.isArray(data)) return { strokes: data, images: [], cards: [] };
    const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []);
    return { strokes: list(data.strokes), images: list(data.images), cards: list(data.cards) };
  } catch {
    return { strokes: [], images: [], cards: [] };
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ strokes, images, cards }));
    showNotice('');
  } catch {
    // Чаще всего кончилось место: картинки занимают много. Рисовать можно, но не сохранится.
    showNotice('В браузере не хватает места: последние изменения не сохранятся. Удали лишние картинки.');
  }
}

const board = load();
/** Все нарисованные линии. */
const strokes: Stroke[] = board.strokes;
/** Картинки на доске; они лежат под линиями, чтобы по скриншоту можно было рисовать. */
const images: BoardImage[] = board.images;
/** Карточки заданий из Word; лежат над картинками и под линиями. */
const cards: Card[] = board.cards;
/** Линия, которую рисуем прямо сейчас. */
let current: Stroke | null = null;
/** Линии, стёртые текущим движением губки. */
let erased: Stroke[] | null = null;
/** Цвет мела, выбранный на палитре. */
let color = palette.querySelector<HTMLButtonElement>('[aria-pressed="true"]')!.dataset.color!;
let tool: Tool = 'pen';

/** Выбранная указкой картинка или карточка. */
let selected: Movable | null = null;
/** Что делаем с картинкой, пока зажата кнопка мыши: двигаем или меняем размер. */
let dragging: { mode: 'move' | 'resize'; start: Point; from: Rect } | null = null;

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

/** Рисует карточку задания и заодно запоминает её высоту по количеству строк. */
function drawCard(c: Card): void {
  ctx.font = `18px ${FONT}`;
  const lines = wrapText(c.text, c.w - CARD_PAD * 2);
  c.h = CARD_PAD * 2 + 22 + lines.length * CARD_LINE;

  ctx.fillStyle = cardColor;
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(c.x, c.y, c.w, c.h, 10);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = accentColor;
  ctx.font = `600 14px ${FONT}`;
  ctx.textBaseline = 'top';
  ctx.fillText(c.title, c.x + CARD_PAD, c.y + CARD_PAD);

  ctx.fillStyle = inkColor;
  ctx.font = `18px ${FONT}`;
  lines.forEach((line, n) => ctx.fillText(line, c.x + CARD_PAD, c.y + CARD_PAD + 26 + n * CARD_LINE));
}

function drawSelection(i: Movable): void {
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2 / camera.zoom;
  ctx.strokeRect(i.x, i.y, i.w, i.h);
  const h = handleRect(i);
  ctx.fillStyle = accentColor;
  ctx.fillRect(h.x, h.y, h.w, h.h);
}

function draw(): void {
  // Фон заливаем в координатах экрана, всё остальное рисуем в координатах доски.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = paperColor;
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, dpr * camera.x, dpr * camera.y);

  for (const i of images) {
    const img = imageElement(i, draw);
    if (img) ctx.drawImage(img, i.x, i.y, i.w, i.h);
  }
  for (const c of cards) drawCard(c);

  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) drawStroke(s);

  if (selected) drawSelection(selected);
  updateLedge();
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
function updateCursor(at?: Point): void {
  if (panning) canvas.style.cursor = 'grabbing';
  else if (spaceHeld) canvas.style.cursor = 'grab';
  else if (tool === 'eraser') canvas.style.cursor = 'cell';
  else if (tool === 'pen') canvas.style.cursor = 'crosshair';
  else if (dragging?.mode === 'resize' || (at && selected && contains(handleRect(selected), at))) canvas.style.cursor = 'nwse-resize';
  else if (dragging || (at && imageAt(at))) canvas.style.cursor = 'move';
  else canvas.style.cursor = 'default';
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
  for (const c of change.cards ?? []) {
    if (add) cards.push(c);
    else removeFrom(cards, c);
    if (!add && selected === c) selected = null;
  }
}

function record(change: Change): void {
  undoStack.push(change);
  redoStack.length = 0;
  updateLedge();
}

function undo(): void {
  const change = undoStack.pop();
  if (!change) return;
  apply(change, true);
  redoStack.push(change);
  draw();
  save();
}

function redo(): void {
  const change = redoStack.pop();
  if (!change) return;
  apply(change);
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

/** Стирает целиком все линии, которых касается губка. Картинки губка не трогает. */
function eraseAt(p: Point): void {
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (touches(strokes[i], p)) erased!.push(...strokes.splice(i, 1));
  }
  draw();
}

/* ---------- картинки ---------- */

/** Верхняя карточка или картинка под точкой доски (карточки лежат выше картинок). */
function imageAt(p: Point): Movable | null {
  for (let i = cards.length - 1; i >= 0; i--) if (contains(cards[i], p)) return cards[i];
  for (let i = images.length - 1; i >= 0; i--) if (contains(images[i], p)) return images[i];
  return null;
}

const isCard = (m: Movable): m is Card => 'title' in m;

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
  if (isCard(item)) {
    removeFrom(cards, item);
    record({ kind: 'remove', strokes: [], cards: [item] });
  } else {
    removeFrom(images, item);
    record({ kind: 'remove', strokes: [], images: [item] });
  }
  draw();
  save();
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
      showNotice('В документе не нашлось заданий. Каждое должно начинаться с «Задание 1», «Упражнение 2» или «№ 3».');
      return;
    }
    const start = toBoard({ x: 40, y: 72 });
    const added: Card[] = [];
    let y = start.y;
    for (const t of tasks) {
      const card: Card = { id: crypto.randomUUID().slice(0, 8), x: start.x, y, w: CARD_WIDTH, h: 0, title: t.title, text: t.text };
      // Высоту узнаём, «нарисовав» карточку: она нужна, чтобы следующая встала ниже.
      ctx.font = `18px ${FONT}`;
      card.h = CARD_PAD * 2 + 22 + wrapText(card.text, CARD_WIDTH - CARD_PAD * 2).length * CARD_LINE;
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
  updateCursor();
  draw();
  // @ts-ignore
  for (const b of palette.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b === button));
  }
}

/* ---------- мышь, палец, стилус ---------- */

canvas.addEventListener('pointerdown', (e) => {
  const p = pointOf(e);
  // Средняя кнопка мыши или зажатый пробел — двигаем доску.
  if (e.button === 1 || spaceHeld) {
    e.preventDefault();
    panning = screenPoint(e);
    updateCursor();
    return;
  }
  if (tool === 'pointer') {
    if (selected && contains(handleRect(selected), p)) {
      dragging = { mode: 'resize', start: p, from: rectOf(selected) };
    } else {
      selected = imageAt(p);
      // Мимо картинок указка двигает саму доску.
      if (selected) dragging = { mode: 'move', start: p, from: rectOf(selected) };
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
  if (tool === 'eraser') {
    erased = [];
    eraseAt(p);
    return;
  }
  current = { color, points: [p] };
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
  if (dragging && selected) {
    const p = pointOf(e);
    const dx = p.x - dragging.start.x;
    const dy = p.y - dragging.start.y;
    const from = dragging.from;
    if (dragging.mode === 'move') {
      selected.x = from.x + dx;
      selected.y = from.y + dy;
    } else if (isCard(selected)) {
      // У карточки меняется только ширина, текст сам переносится, высота подстроится.
      selected.w = Math.max(MIN_CARD, from.w + dx);
    } else {
      // Пропорции сохраняются, чтобы скриншот не растягивался.
      const w = Math.max(MIN_IMAGE, from.w + Math.max(dx, (dy * from.w) / from.h));
      selected.w = w;
      selected.h = (w * from.h) / from.w;
    }
    return draw();
  }
  if (tool === 'pointer') return updateCursor(pointOf(e));
  if (erased) return eraseAt(pointOf(e));
  if (!current) return;
  current.points.push(pointOf(e));
  draw();
});

function finish(): void {
  let changed = current !== null || !!erased?.length;
  if (current) record({ kind: 'add', strokes: [current] });
  if (erased?.length) record({ kind: 'remove', strokes: erased });
  if (dragging && selected) {
    const to = rectOf(selected);
    const from = dragging.from;
    if (to.x !== from.x || to.y !== from.y || to.w !== from.w) {
      record({ kind: 'move', image: selected, from, to });
      changed = true;
    }
  }
  current = null;
  erased = null;
  panning = null;
  dragging = null;
  updateCursor();
  if (changed) save();
}

canvas.addEventListener('pointerup', finish);
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

  // Delete или Backspace убирают выбранную картинку, Esc снимает выбор.
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
    e.preventDefault();
    deleteSelected();
    return;
  }
  if (e.key === 'Escape' && selected) {
    selected = null;
    draw();
    return;
  }

  // 1, 2, 3 — мелки по порядку; E — губка; V — указка.
  const chalk = palette.querySelectorAll<HTMLButtonElement>('[data-color]')[Number(e.key) - 1];
  if (chalk) select(chalk);
  if (key === 'e' || key === 'у') select(palette.querySelector<HTMLButtonElement>('[data-tool="eraser"]')!);
  if (key === 'v' || key === 'м') select(palette.querySelector<HTMLButtonElement>('[data-tool="pointer"]')!);
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

readTheme();
resize();
