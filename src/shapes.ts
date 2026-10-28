import type { Rect } from './images';

/** Фигуры из ящика на полке: основные и для математики. */
export type ShapeKind =
  | 'rect'
  | 'ellipse'
  | 'triangle'
  | 'line'
  | 'arrow'
  | 'axes'
  | 'numberline'
  | 'grid'
  | 'angle';

/**
 * Фигура на доске. x, y — точка, откуда начали тянуть; w, h — куда дотянули (могут быть
 * отрицательными: у линии и стрелки это направление). Цвет — код мела, как у линий.
 */
export type Shape = { id: string; kind: ShapeKind; color: string; x: number; y: number; w: number; h: number };

/** Шаг клеток и делений — как клетка тетради. */
const STEP = 24;

/** Прямоугольник фигуры с положительными шириной и высотой. */
export function boundsOf(s: Shape): Rect {
  return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
}

/** Размер по умолчанию, если фигуру не тянули, а просто кликнули. */
export function defaultSize(kind: ShapeKind): { w: number; h: number } {
  if (kind === 'line' || kind === 'arrow' || kind === 'numberline') return { w: 192, h: 0 };
  if (kind === 'axes' || kind === 'grid') return { w: 240, h: 192 };
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

/** Рисует фигуру текущим цветом и толщиной ctx (их ставит доска). */
export function drawShape(ctx: CanvasRenderingContext2D, s: Shape): void {
  const b = boundsOf(s);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  switch (s.kind) {
    case 'rect':
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      break;
    case 'ellipse':
      ctx.beginPath();
      ctx.ellipse(cx, cy, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'triangle':
      ctx.beginPath();
      ctx.moveTo(cx, b.y);
      ctx.lineTo(b.x + b.w, b.y + b.h);
      ctx.lineTo(b.x, b.y + b.h);
      ctx.closePath();
      ctx.stroke();
      break;
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
      // Вершина слева внизу, один луч вправо, второй — в правый верхний угол, дуга у вершины.
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
