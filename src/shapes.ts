import type { Rect } from './images';
import type { Wipe } from './ops';

/** Фигуры из ящика на полке: основные и для математики. */
export type ShapeKind =
  | 'rect'
  | 'ellipse'
  | 'triangle'
  | 'right-triangle'
  | 'line'
  | 'arrow'
  | 'axes'
  | 'numberline'
  | 'grid'
  | 'angle'
  | 'trapezoid'
  | 'parallelogram'
  | 'rhombus'
  | 'circle'
  | 'fraction'
  | 'protractor'
  | 'cube'
  | 'cylinder'
  | 'cone'
  | 'pyramid';

/**
 * Как нарисована фигура: толщина линии, пунктир, заливка и (у круга долей) на сколько частей
 * он поделён. У старых фигур этих полей нет - тогда обычная сплошная линия без заливки.
 */
export type ShapeStyle = { width?: number; dash?: boolean; fill?: boolean; parts?: number };

/** Толщины линии: тонкая, обычная, толстая. */
export const WIDTHS = [2, 3, 6];
/** На сколько долей можно поделить круг. */
export const MIN_PARTS = 2;
export const MAX_PARTS = 12;

/**
 * Фигура на доске. x, y - точка, откуда начали тянуть; w, h - куда дотянули (могут быть
 * отрицательными: у линии и стрелки это направление). Цвет - код мела, как у линий.
 */
export type Shape = ShapeStyle & { id: string; kind: ShapeKind; color: string; x: number; y: number; w: number; h: number; wipes?: Wipe[] };

/** У каких фигур есть что заливать: замкнутый контур. */
const FILLABLE = new Set<ShapeKind>([
  'rect', 'ellipse', 'triangle', 'right-triangle', 'trapezoid', 'parallelogram', 'rhombus', 'circle', 'fraction', 'protractor',
]);

export function canFill(kind: ShapeKind): boolean {
  return FILLABLE.has(kind);
}

/** Шаг клеток и делений - как клетка тетради. */
const STEP = 24;

/** Прямоугольник фигуры с положительными шириной и высотой. */
export function boundsOf(s: Shape): Rect {
  return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
}

/** Размер по умолчанию, если фигуру не тянули, а просто кликнули. */
export function defaultSize(kind: ShapeKind): { w: number; h: number } {
  if (kind === 'line' || kind === 'arrow' || kind === 'numberline') return { w: 192, h: 0 };
  if (kind === 'axes' || kind === 'grid') return { w: 240, h: 192 };
  if (kind === 'protractor') return { w: 240, h: 120 };
  if (kind === 'circle' || kind === 'fraction' || kind === 'cube' || kind === 'cylinder' || kind === 'cone' || kind === 'pyramid') {
    return { w: 160, h: 160 };
  }
  return { w: 160, h: 120 };
}

function arrowHead(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const len = 14;
  ctx.beginPath();
  ctx.moveTo(x2 - len * Math.cos(a - 0.45), y2 - len * Math.sin(a - 0.45));
  ctx.lineTo(x2, y2);
  ctx.lineTo(x2 - len * Math.cos(a + 0.45), y2 - len * Math.sin(a + 0.45));
  ctx.stroke();
}

function arrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  arrowHead(ctx, x1, y1, x2, y2);
}

/** Насколько прозрачна заливка: сквозь неё видно клетку и надписи. */
const FILL_ALPHA = 0.2;

/** Замкнутый контур: при заливке сначала закрашиваем, потом обводим. */
function outline(ctx: CanvasRenderingContext2D, s: Shape, path: () => void): void {
  ctx.beginPath();
  path();
  if (s.fill) {
    ctx.globalAlpha = FILL_ALPHA;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.stroke();
}

function polygon(ctx: CanvasRenderingContext2D, s: Shape, points: [number, number][]): void {
  outline(ctx, s, () => {
    ctx.moveTo(...points[0]);
    for (const p of points.slice(1)) ctx.lineTo(...p);
    ctx.closePath();
  });
}

/** Невидимые рёбра объёмных фигур - пунктиром, как в учебнике. */
function hidden(ctx: CanvasRenderingContext2D, draw: () => void): void {
  const dash = ctx.getLineDash();
  const w = ctx.lineWidth;
  ctx.setLineDash(dash.length ? dash : [w * 2, w * 2]);
  ctx.beginPath();
  draw();
  ctx.stroke();
  ctx.setLineDash(dash);
}

function line(ctx: CanvasRenderingContext2D, points: [number, number][]): void {
  ctx.beginPath();
  ctx.moveTo(...points[0]);
  for (const p of points.slice(1)) ctx.lineTo(...p);
  ctx.stroke();
}

/**
 * Рисует фигуру. Цвет ставит доска (strokeStyle и fillStyle), толщину, пунктир и заливку
 * фигура берёт свои. Состояние ctx после рисования возвращается как было.
 */
export function drawShape(ctx: CanvasRenderingContext2D, s: Shape): void {
  ctx.save();
  const w = s.width ?? 3;
  ctx.lineWidth = w;
  ctx.setLineDash(s.dash ? [w * 3, w * 2.5] : []);
  paint(ctx, s);
  ctx.restore();
}

function paint(ctx: CanvasRenderingContext2D, s: Shape): void {
  const b = boundsOf(s);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const right = b.x + b.w;
  const bottom = b.y + b.h;
  switch (s.kind) {
    case 'rect':
      outline(ctx, s, () => ctx.rect(b.x, b.y, b.w, b.h));
      break;
    case 'ellipse':
      outline(ctx, s, () => ctx.ellipse(cx, cy, b.w / 2, b.h / 2, 0, 0, Math.PI * 2));
      break;
    case 'triangle':
      polygon(ctx, s, [[cx, b.y], [right, bottom], [b.x, bottom]]);
      break;
    case 'trapezoid':
      polygon(ctx, s, [[b.x + b.w * 0.25, b.y], [b.x + b.w * 0.75, b.y], [right, bottom], [b.x, bottom]]);
      break;
    case 'parallelogram':
      polygon(ctx, s, [[b.x + b.w * 0.25, b.y], [right, b.y], [b.x + b.w * 0.75, bottom], [b.x, bottom]]);
      break;
    case 'rhombus':
      polygon(ctx, s, [[cx, b.y], [right, cy], [cx, bottom], [b.x, cy]]);
      break;
    case 'circle': {
      // Окружность с центром и радиусом: точка в центре, радиус вправо, подпись r.
      const r = Math.min(b.w, b.h) / 2;
      outline(ctx, s, () => ctx.arc(cx, cy, r, 0, Math.PI * 2));
      line(ctx, [[cx, cy], [cx + r, cy]]);
      ctx.beginPath();
      ctx.arc(cx, cy, ctx.lineWidth + 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = 'italic 16px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('r', cx + r / 2, cy - 4);
      break;
    }
    case 'fraction': {
      // Круг долей: поделён на равные части, с заливкой закрашена одна доля.
      const r = Math.min(b.w, b.h) / 2;
      const parts = Math.min(MAX_PARTS, Math.max(MIN_PARTS, s.parts ?? 4));
      const step = (Math.PI * 2) / parts;
      const start = -Math.PI / 2;
      if (s.fill) {
        ctx.globalAlpha = FILL_ALPHA * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, start, start + step);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      for (let i = 0; i < parts; i++) {
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + r * Math.cos(start + i * step), cy + r * Math.sin(start + i * step));
      }
      ctx.stroke();
      break;
    }
    case 'protractor': {
      // Транспортир: полукруг с делениями через 10°, подписи через 30°.
      const r = Math.min(b.w / 2, b.h);
      const oy = bottom;
      outline(ctx, s, () => {
        ctx.arc(cx, oy, r, Math.PI, 0);
        ctx.closePath();
      });
      ctx.save();
      ctx.setLineDash([]);
      ctx.lineWidth = Math.max(1, ctx.lineWidth / 2);
      ctx.beginPath();
      for (let deg = 10; deg < 180; deg += 10) {
        const a = Math.PI + (deg * Math.PI) / 180;
        const len = deg % 30 === 0 ? 14 : 8;
        ctx.moveTo(cx + r * Math.cos(a), oy + r * Math.sin(a));
        ctx.lineTo(cx + (r - len) * Math.cos(a), oy + (r - len) * Math.sin(a));
      }
      ctx.stroke();
      ctx.restore();
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (r > 60) {
        for (let deg = 0; deg <= 180; deg += 30) {
          const a = Math.PI + (deg * Math.PI) / 180;
          ctx.fillText(String(deg), cx + (r - 26) * Math.cos(a), oy - 4 + (r - 26) * Math.sin(a));
        }
      }
      ctx.beginPath();
      ctx.arc(cx, oy, 3, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'cube': {
      // Передняя грань, задняя сдвинута вверх-вправо; невидимые рёбра пунктиром.
      const d = Math.min(b.w, b.h) * 0.3;
      const fx = b.x;
      const fy = b.y + d;
      const fw = b.w - d;
      const fh = b.h - d;
      ctx.beginPath();
      ctx.rect(fx, fy, fw, fh);
      ctx.stroke();
      line(ctx, [[fx, fy], [fx + d, b.y], [right, b.y], [right, b.y + fh], [fx + fw, fy + fh]]);
      line(ctx, [[fx + fw, fy], [right, b.y]]);
      hidden(ctx, () => {
        ctx.moveTo(fx + d, b.y);
        ctx.lineTo(fx + d, b.y + fh);
        ctx.lineTo(right, b.y + fh);
        ctx.moveTo(fx + d, b.y + fh);
        ctx.lineTo(fx, fy + fh);
      });
      break;
    }
    case 'cylinder': {
      const ry = Math.min(b.h * 0.12, b.w * 0.25);
      const rx = b.w / 2;
      ctx.beginPath();
      ctx.ellipse(cx, b.y + ry, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      line(ctx, [[b.x, b.y + ry], [b.x, bottom - ry]]);
      line(ctx, [[right, b.y + ry], [right, bottom - ry]]);
      ctx.beginPath();
      ctx.ellipse(cx, bottom - ry, rx, ry, 0, 0, Math.PI);
      ctx.stroke();
      hidden(ctx, () => ctx.ellipse(cx, bottom - ry, rx, ry, 0, Math.PI, Math.PI * 2));
      break;
    }
    case 'cone': {
      const ry = Math.min(b.h * 0.12, b.w * 0.25);
      const rx = b.w / 2;
      line(ctx, [[b.x, bottom - ry], [cx, b.y], [right, bottom - ry]]);
      ctx.beginPath();
      ctx.ellipse(cx, bottom - ry, rx, ry, 0, 0, Math.PI);
      ctx.stroke();
      hidden(ctx, () => ctx.ellipse(cx, bottom - ry, rx, ry, 0, Math.PI, Math.PI * 2));
      break;
    }
    case 'pyramid': {
      // Четырёхугольная пирамида: основание - параллелограмм, дальние рёбра пунктиром.
      const depth = b.h * 0.25;
      const a: [number, number] = [b.x, bottom];
      const bb: [number, number] = [b.x + b.w * 0.7, bottom];
      const c: [number, number] = [right, bottom - depth];
      const d: [number, number] = [b.x + b.w * 0.3, bottom - depth];
      const top: [number, number] = [b.x + b.w * 0.5, b.y];
      line(ctx, [a, bb, c]);
      line(ctx, [a, top, bb]);
      line(ctx, [top, c]);
      hidden(ctx, () => {
        ctx.moveTo(...c);
        ctx.lineTo(...d);
        ctx.lineTo(...a);
        ctx.moveTo(...d);
        ctx.lineTo(...top);
      });
      break;
    }
    case 'right-triangle': {
      // Прямой угол там, откуда начали тянуть по вертикали: тянешь в любую сторону - треугольник поворачивается.
      const vx = s.x;
      const vy = s.y + s.h;
      polygon(ctx, s, [[vx, s.y], [vx, vy], [s.x + s.w, vy]]);
      // Квадратик - знак прямого угла, внутри треугольника.
      const m = Math.min(16, b.w / 4, b.h / 4);
      const dx = Math.sign(s.w) * m;
      const dy = -Math.sign(s.h) * m;
      ctx.beginPath();
      ctx.moveTo(vx, vy + dy);
      ctx.lineTo(vx + dx, vy + dy);
      ctx.lineTo(vx + dx, vy);
      ctx.stroke();
      break;
    }
    case 'line':
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + s.w, s.y + s.h);
      ctx.stroke();
      break;
    case 'arrow':
      arrow(ctx, s.x, s.y, s.x + s.w, s.y + s.h);
      break;
    case 'axes': {
      // Оси через середину прямоугольника, деления каждые 24, подписи x и y у стрелок.
      arrow(ctx, b.x, cy, b.x + b.w, cy);
      arrow(ctx, cx, b.y + b.h, cx, b.y);
      ctx.beginPath();
      for (let x = cx + STEP; x < b.x + b.w - STEP / 2; x += STEP) ctx.moveTo(x, cy - 4), ctx.lineTo(x, cy + 4);
      for (let x = cx - STEP; x > b.x + STEP / 2; x -= STEP) ctx.moveTo(x, cy - 4), ctx.lineTo(x, cy + 4);
      for (let y = cy + STEP; y < b.y + b.h - STEP / 2; y += STEP) ctx.moveTo(cx - 4, y), ctx.lineTo(cx + 4, y);
      for (let y = cy - STEP; y > b.y + STEP / 2; y -= STEP) ctx.moveTo(cx - 4, y), ctx.lineTo(cx + 4, y);
      ctx.stroke();
      ctx.font = 'italic 16px Georgia, serif';
      ctx.textBaseline = 'top';
      ctx.fillText('x', b.x + b.w - 10, cy + 8);
      ctx.fillText('y', cx + 8, b.y - 2);
      break;
    }
    case 'numberline': {
      // Прямая со стрелкой вправо, ноль посередине, числа под делениями.
      const y = s.h === 0 ? s.y : cy;
      arrow(ctx, b.x, y, b.x + b.w, y);
      ctx.font = '13px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';
      ctx.beginPath();
      const steps = Math.floor((b.w / 2 - 16) / 32);
      for (let n = -steps; n <= steps; n++) {
        const x = cx + n * 32;
        ctx.moveTo(x, y - 6);
        ctx.lineTo(x, y + 6);
        ctx.fillText(String(n), x, y + 10);
      }
      ctx.stroke();
      ctx.textAlign = 'start';
      break;
    }
    case 'grid': {
      // Клетчатое поле: тонкие линии внутри и рамка.
      const lw = ctx.lineWidth;
      ctx.lineWidth = lw / 3;
      ctx.beginPath();
      for (let x = b.x + STEP; x < b.x + b.w; x += STEP) ctx.moveTo(x, b.y), ctx.lineTo(x, b.y + b.h);
      for (let y = b.y + STEP; y < b.y + b.h; y += STEP) ctx.moveTo(b.x, y), ctx.lineTo(b.x + b.w, y);
      ctx.stroke();
      ctx.lineWidth = lw;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      break;
    }
    case 'angle': {
      // Вершина слева внизу, один луч вправо, второй - в правый верхний угол, дуга у вершины.
      const vx = b.x;
      const vy = b.y + b.h;
      const a = Math.atan2(-b.h, b.w);
      ctx.beginPath();
      ctx.moveTo(vx + b.w, vy);
      ctx.lineTo(vx, vy);
      ctx.lineTo(vx + b.w, b.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(vx, vy, Math.min(32, b.w / 3), a, 0);
      ctx.stroke();
      break;
    }
  }
}
