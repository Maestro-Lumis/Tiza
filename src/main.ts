type Point = { x: number; y: number };
type Stroke = { color: string; points: Point[] };

const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;
const palette = document.querySelector<HTMLDivElement>('#palette')!;

/** Все нарисованные линии. */
const strokes: Stroke[] = [];
/** Линия, которую рисуем прямо сейчас. */
let current: Stroke | null = null;
/** Цвет мела, выбранный на палитре. */
let color = palette.querySelector<HTMLButtonElement>('[aria-pressed="true"]')!.dataset.color!;

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

function setColor(button: HTMLButtonElement): void {
  color = button.dataset.color!;
  // @ts-ignore
  for (const b of palette.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b === button));
  }
}

canvas.addEventListener('pointerdown', (e) => {
  current = { color, points: [pointOf(e)] };
  strokes.push(current);
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  if (!current) return;
  current.points.push(pointOf(e));
  draw();
});

canvas.addEventListener('pointerup', () => (current = null));
canvas.addEventListener('pointercancel', () => (current = null));

palette.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest('button');
  if (button) setColor(button);
});

/** Клавиши 1, 2, 3 выбирают мел по порядку на палитре. */
window.addEventListener('keydown', (e) => {
  const button = palette.querySelectorAll('button')[Number(e.key) - 1];
  if (button) setColor(button);
});

window.addEventListener('resize', resize);
resize();
