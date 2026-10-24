import { getStudent } from './students';
import './theme';

type Point = { x: number; y: number };
type Stroke = { color: string; points: Point[] };
type Tool = 'pen' | 'eraser';
/** Одно действие для истории: линии добавили или стёрли. */
type Change = { kind: 'add' | 'remove'; strokes: Stroke[] };

const ERASER_RADIUS = 12;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;
/** Чья это доска и какой темы: board.html?student=andrey&topic=… */
const params = new URLSearchParams(location.search);
const studentId = params.get('student');
const topicId = params.get('topic');
/**
 * Ключ, под которым доска лежит в хранилище браузера: у каждой темы свой.
 * Без ученика и темы открывается старая общая доска.
 */
const STORAGE_KEY = studentId && topicId ? `tiza:board:${studentId}:${topicId}` : 'tiza:board';

const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;
const palette = document.querySelector<HTMLDivElement>('#palette')!;
const undoButton = document.querySelector<HTMLButtonElement>('#undo')!;
const redoButton = document.querySelector<HTMLButtonElement>('#redo')!;
const zoomButton = document.querySelector<HTMLButtonElement>('#zoom-reset')!;

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

/* ---------- сохранение в браузере ---------- */

/** Достаёт сохранённые линии; если их нет или данные испорчены, доска пустая. */
function load(): Stroke[] {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(strokes));
  } catch {
    // Хранилище недоступно (приватный режим, нет места): рисовать можно и без сохранения.
  }
}

/** Все нарисованные линии. */
const strokes: Stroke[] = load();
/** Линия, которую рисуем прямо сейчас. */
let current: Stroke | null = null;
/** Линии, стёртые текущим движением губки. */
let erased: Stroke[] | null = null;
/** Цвет мела, выбранный на палитре. */
let color = palette.querySelector<HTMLButtonElement>('[aria-pressed="true"]')!.dataset.color!;
let tool: Tool = 'pen';

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

/** Берёт цвета из CSS текущей темы (светлой или тёмной). */
function readTheme(): void {
  const css = getComputedStyle(document.documentElement);
  paperColor = css.getPropertyValue('--paper').trim();
  for (const [code, name] of Object.entries(CHALK_VARS)) {
    chalkColors[code] = css.getPropertyValue(name).trim();
  }
}

function draw(): void {
  // Фон заливаем в координатах экрана, линии рисуем в координатах доски.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = paperColor;
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, dpr * camera.x, dpr * camera.y);

  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) drawStroke(s);
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

/** Та же точка в координатах доски, с учётом сдвига и масштаба. */
function pointOf(e: MouseEvent): Point {
  const s = screenPoint(e);
  return { x: (s.x - camera.x) / camera.zoom, y: (s.y - camera.y) / camera.zoom };
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

function updateCursor(): void {
  if (panning) canvas.style.cursor = 'grabbing';
  else if (spaceHeld) canvas.style.cursor = 'grab';
  else canvas.style.cursor = tool === 'eraser' ? 'cell' : 'crosshair';
}

/* ---------- история: отмена и возврат ---------- */

/** Применяет действие к доске; reverse = true делает обратное (для отмены). */
function apply(change: Change, reverse = false): void {
  const add = (change.kind === 'add') !== reverse;
  for (const s of change.strokes) {
    if (add) strokes.push(s);
    else strokes.splice(strokes.indexOf(s), 1);
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

/** Стирает целиком все линии, которых касается губка. */
function eraseAt(p: Point): void {
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (touches(strokes[i], p)) erased!.push(...strokes.splice(i, 1));
  }
  draw();
}

/* ---------- палитра ---------- */

function select(button: HTMLButtonElement): void {
  tool = button.dataset.tool === 'eraser' ? 'eraser' : 'pen';
  if (tool === 'pen') color = button.dataset.color!;
  updateCursor();
  // @ts-ignore
  for (const b of palette.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b === button));
  }
}

/* ---------- мышь, палец, стилус ---------- */

canvas.addEventListener('pointerdown', (e) => {
  // Средняя кнопка мыши или зажатый пробел — двигаем доску.
  if (e.button === 1 || spaceHeld) {
    e.preventDefault();
    panning = screenPoint(e);
    updateCursor();
    return;
  }
  if (tool === 'eraser') {
    erased = [];
    eraseAt(pointOf(e));
    return;
  }
  current = { color, points: [pointOf(e)] };
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
  if (erased) return eraseAt(pointOf(e));
  if (!current) return;
  current.points.push(pointOf(e));
  draw();
});

function finish(): void {
  const changed = current !== null || !!erased?.length;
  if (current) record({ kind: 'add', strokes: [current] });
  if (erased?.length) record({ kind: 'remove', strokes: erased });
  current = null;
  erased = null;
  panning = null;
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

palette.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest('button');
  if (button) select(button);
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

  // 1, 2, 3 — мелки по порядку; E — губка.
  const chalk = palette.querySelectorAll<HTMLButtonElement>('[data-color]')[Number(e.key) - 1];
  if (chalk) select(chalk);
  if (key === 'e' || key === 'у') select(palette.querySelector<HTMLButtonElement>('[data-tool="eraser"]')!);
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
