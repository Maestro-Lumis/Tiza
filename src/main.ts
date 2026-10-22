type Point = { x: number; y: number };
type Stroke = { color: string; points: Point[] };
type Tool = 'pen' | 'eraser';
/** Одно действие для истории: линии добавили или стёрли. */
type Change = { kind: 'add' | 'remove'; strokes: Stroke[] };

const ERASER_RADIUS = 12;

const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;
const palette = document.querySelector<HTMLDivElement>('#palette')!;

/** Все нарисованные линии. */
const strokes: Stroke[] = [];
/** Линия, которую рисуем прямо сейчас. */
let current: Stroke | null = null;
/** Линии, стёртые текущим движением губки. */
let erased: Stroke[] | null = null;
/** Цвет мела, выбранный на палитре. */
let color = palette.querySelector<HTMLButtonElement>('[aria-pressed="true"]')!.dataset.color!;
let tool: Tool = 'pen';

const undoStack: Change[] = [];
const redoStack: Change[] = [];

/** Подгоняет холст под размер окна с учётом плотности пикселей экрана. */
function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function drawStroke(s: Stroke): void {
  ctx.strokeStyle = s.color;
  ctx.beginPath();
  ctx.moveTo(s.points[0].x, s.points[0].y);
  for (const p of s.points) ctx.lineTo(p.x, p.y);
  ctx.stroke();
}

function draw(): void {
  ctx.fillStyle = '#f6f1e5';
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) drawStroke(s);
}

function pointOf(e: PointerEvent): Point {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
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
}

function undo(): void {
  const change = undoStack.pop();
  if (!change) return;
  apply(change, true);
  redoStack.push(change);
  draw();
}

function redo(): void {
  const change = redoStack.pop();
  if (!change) return;
  apply(change);
  undoStack.push(change);
  draw();
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
  if (s.points.length === 1) return Math.hypot(p.x - s.points[0].x, p.y - s.points[0].y) < ERASER_RADIUS;
  for (let i = 1; i < s.points.length; i++) {
    if (distToSegment(p, s.points[i - 1], s.points[i]) < ERASER_RADIUS) return true;
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
  canvas.style.cursor = tool === 'eraser' ? 'cell' : 'crosshair';
  // @ts-ignore
  for (const b of palette.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b === button));
  }
}

/* ---------- мышь, палец, стилус ---------- */

canvas.addEventListener('pointerdown', (e) => {
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
  if (erased) return eraseAt(pointOf(e));
  if (!current) return;
  current.points.push(pointOf(e));
  draw();
});

function finish(): void {
  if (current) record({ kind: 'add', strokes: [current] });
  if (erased?.length) record({ kind: 'remove', strokes: erased });
  current = null;
  erased = null;
}

canvas.addEventListener('pointerup', finish);
canvas.addEventListener('pointercancel', finish);

palette.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest('button');
  if (button) select(button);
});

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
  if (mod || e.altKey) return;

  // 1, 2, 3 — мелки по порядку; E — губка.
  const chalk = palette.querySelectorAll<HTMLButtonElement>('[data-color]')[Number(e.key) - 1];
  if (chalk) select(chalk);
  if (key === 'e' || key === 'у') select(palette.querySelector<HTMLButtonElement>('[data-tool="eraser"]')!);
});

window.addEventListener('resize', resize);
resize();
