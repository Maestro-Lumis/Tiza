type Point = { x: number; y: number };

const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;

/** Все нарисованные линии. Каждая линия — список точек. */
const strokes: Point[][] = [];
/** Линия, которую рисуем прямо сейчас. */
let current: Point[] | null = null;

/** Подгоняет холст под размер окна с учётом плотности пикселей экрана. */
function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function drawStroke(points: Point[]): void {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const p of points) ctx.lineTo(p.x, p.y);
  ctx.stroke();
}

function draw(): void {
  ctx.fillStyle = '#f6f1e5';
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  ctx.strokeStyle = '#25231f';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) drawStroke(s);
}

function pointOf(e: PointerEvent): Point {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener('pointerdown', (e) => {
  current = [pointOf(e)];
  strokes.push(current);
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  if (!current) return;
  current.push(pointOf(e));
  draw();
});

canvas.addEventListener('pointerup', () => (current = null));
canvas.addEventListener('pointercancel', () => (current = null));

window.addEventListener('resize', resize);
resize();
