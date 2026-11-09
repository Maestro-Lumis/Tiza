import type { Rect } from './images';
import type { Wipe } from './ops';

/**
 * Тетрадь: листы - это рамки на доске. Что внутри рамки, то и попадает на страницу PDF,
 * по порядку номеров. Каждая страница - картинка: рукописные формулы и рисунки выглядят
 * ровно как на доске, а русские буквы не зависят от шрифтов внутри PDF.
 */

/** Формат листа. У свободной рамки пропорции любые, у остальных держатся сами. */
export type PageFormat = 'free' | 'a4' | 'a4-land' | 'a5' | 'wide' | 'square';

/**
 * Рамка листа на доске: f - формат, n - номер по порядку (может быть дробным).
 * Губка рамку не трогает, wipes здесь только для общего вида предметов доски.
 */
export type Page = Rect & { id: string; f: PageFormat; n: number; wipes?: Wipe[] };

/** Название, размер страницы PDF в миллиметрах (у свободной - только ширина). */
export const FORMATS: Record<PageFormat, { label: string; w: number; h?: number }> = {
  free: { label: 'Свободная', w: 210 },
  a4: { label: 'A4 книжный', w: 210, h: 297 },
  'a4-land': { label: 'A4 альбомный', w: 297, h: 210 },
  a5: { label: 'A5', w: 148, h: 210 },
  wide: { label: '16:9, как экран', w: 297, h: 167 },
  square: { label: 'Квадрат', w: 210, h: 210 },
};

/** Высота к ширине для форматных рамок; у свободной null. */
export function ratioOf(f: PageFormat): number | null {
  const size = FORMATS[f];
  return size.h ? size.h / size.w : null;
}

/** Качество: пикселей на миллиметр и сколько примерно весит лист. */
export type Quality = 'light' | 'normal' | 'print';
export const QUALITIES: Record<Quality, { label: string; pxPerMm: number }> = {
  light: { label: 'Лёгкое - для телефона и мессенджеров', pxPerMm: 4 },
  normal: { label: 'Обычное - для экрана и печати', pxPerMm: 8 },
  print: { label: 'Для печати - самое чёткое', pxPerMm: 12 },
};

/** Поле страницы вокруг содержимого рамки, мм. */
const MARGIN = 8;
/** Самая большая сторона страницы в пикселях: больше браузер может не нарисовать. */
const MAX_SIDE = 12000;
/** Самая длинная свободная страница, мм: дальше лист уже не напечатать. */
const MAX_FREE_HEIGHT = 1200;
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Размер страницы PDF для рамки, мм. Свободная рамка: ширина как у A4, высота по рамке. */
export function pageSize(p: Page): { w: number; h: number } {
  const size = FORMATS[p.f];
  if (size.h) return { w: size.w, h: size.h };
  // Широкую свободную рамку кладём на ширину альбомного листа.
  const w = p.w > p.h ? 297 : 210;
  return { w, h: Math.min(MAX_FREE_HEIGHT, Math.max(40, (w - MARGIN * 2) * (p.h / p.w) + MARGIN * 2)) };
}

/** Листы по порядку номеров. */
export function ordered(pages: Page[]): Page[] {
  return [...pages].sort((a, b) => a.n - b.n);
}

/**
 * Примерный вес PDF в килобайтах. Листы с линиями и текстом сжимаются хорошо,
 * а с фотографиями и скриншотами весят в разы больше.
 */
export function estimateKb(pages: Page[], quality: Quality, hasPicture: (p: Page) => boolean): number {
  const ppm = QUALITIES[quality].pxPerMm;
  let bytes = 0;
  for (const p of pages) {
    const { w, h } = pageSize(p);
    const px = w * ppm * h * ppm;
    bytes += px * (hasPicture(p) ? 0.25 : 0.01);
  }
  return Math.max(10, Math.round(bytes / 1024));
}

/** «340 КБ» или «2,4 МБ». */
export function formatSize(kb: number): string {
  return kb < 1000 ? `${Math.round(kb / 10) * 10 || 10} КБ` : `${(kb / 1024).toFixed(1).replace('.', ',')} МБ`;
}

/** Что нужно тетради от доски для скачивания. */
export type NotebookSource = {
  pages: Page[];
  /** Рисует доску в печатных цветах. Преобразование координат уже настроено. */
  paint: (ctx: CanvasRenderingContext2D) => void;
  hasPicture: (p: Page) => boolean;
  quality: Quality;
  title: string;
  fileName: string;
};

/** Собирает PDF из рамок по порядку и отдаёт браузеру на скачивание. */
export async function downloadNotebook(source: NotebookSource): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const list = ordered(source.pages);
  let pdf: InstanceType<typeof jsPDF> | null = null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  list.forEach((page, i) => {
    const size = pageSize(page);
    // Очень длинный лист рисуем реже, чтобы браузер его потянул.
    const ppm = Math.min(QUALITIES[source.quality].pxPerMm, MAX_SIDE / Math.max(size.w, size.h));
    canvas.width = Math.round(size.w * ppm);
    canvas.height = Math.round(size.h * ppm);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Рамка вписывается в поля страницы целиком и по центру.
    const innerW = (size.w - MARGIN * 2) * ppm;
    const innerH = (size.h - MARGIN * 2) * ppm;
    const k = Math.min(innerW / page.w, innerH / page.h);
    const left = MARGIN * ppm + (innerW - page.w * k) / 2;
    const top = MARGIN * ppm + (innerH - page.h * k) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, page.w * k, page.h * k);
    ctx.clip();
    ctx.setTransform(k, 0, 0, k, left - page.x * k, top - page.y * k);
    source.paint(ctx);
    ctx.restore();

    // Номер страницы в нижнем поле.
    ctx.fillStyle = '#6b6559';
    ctx.font = `${2.6 * ppm}px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(`${i + 1} / ${list.length}`, (size.w - MARGIN) * ppm, (size.h - MARGIN / 3) * ppm);
    ctx.textAlign = 'left';

    const orientation = size.w > size.h ? 'landscape' : 'portrait';
    if (!pdf) pdf = new jsPDF({ orientation, unit: 'mm', format: [size.w, size.h] });
    else pdf.addPage([size.w, size.h], orientation);
    // Фотографии лучше сжимает JPEG, линии и текст - PNG: они остаются чёткими.
    const photo = source.hasPicture(page);
    const data = photo ? canvas.toDataURL('image/jpeg', 0.9) : canvas.toDataURL('image/png');
    pdf.addImage(data, photo ? 'JPEG' : 'PNG', 0, 0, size.w, size.h, undefined, 'FAST');
  });
  if (!pdf) return;
  const doc = pdf as InstanceType<typeof jsPDF>;
  doc.setProperties({ title: source.title });
  doc.save(source.fileName);
}

/* ---------- разложить доску на листы самому ---------- */

/** Поле вокруг содержимого, в единицах доски. */
const PAD = 16;

/**
 * Делит доску по высоте на куски. Режем там, где ничего нет: между карточками,
 * рисунками и линиями, а пустые промежутки между кусками пропускаем.
 * Если предмет выше куска, режем по краю: иначе его не вместить.
 */
function slice(boxes: Rect[], top: number, bottom: number, height: number): [number, number][] {
  const spans = boxes.map((b) => [b.y - PAD, b.y + b.h + PAD] as const);
  const free = (y: number) => spans.every(([a, b]) => y <= a || y >= b);
  const result: [number, number][] = [];
  let y = top;
  while (y < bottom - 1) {
    const limit = y + height;
    if (limit >= bottom) {
      result.push([y, bottom]);
      break;
    }
    // Лучший разрез - самый нижний свободный край предмета, но не выше половины куска.
    const cut =
      spans
        .flat()
        .filter((c) => c > y + height * 0.4 && c <= limit && free(c))
        .sort((a, b) => b - a)[0] ?? limit;
    result.push([y, cut]);
    // Следующий кусок начинается с ближайшего предмета ниже разреза, без пустоты сверху.
    const crossing = spans.some(([a, b]) => a < cut && b > cut);
    const below = spans.filter(([a]) => a >= cut).map(([a]) => a);
    y = crossing || !below.length ? cut : Math.min(...below);
  }
  return result;
}

/**
 * Рамки, которые покрывают всё на доске. Ширина у всех одна - по самому широкому месту,
 * высота куска как у листа A4 той же ширины. Рамки свободные: пустоты по краям не будет,
 * а формат каждой можно сменить в тетради.
 */
export function autoLayout(boxes: Rect[]): Rect[] {
  if (!boxes.length) return [];
  const x1 = Math.min(...boxes.map((b) => b.x)) - PAD;
  const x2 = Math.max(...boxes.map((b) => b.x + b.w)) + PAD;
  const y1 = Math.min(...boxes.map((b) => b.y)) - PAD;
  const y2 = Math.max(...boxes.map((b) => b.y + b.h)) + PAD;
  const w = x2 - x1;
  return slice(boxes, y1, y2, w * (297 / 210)).map(([a, b]) => ({ x: x1, y: a, w, h: b - a }));
}
