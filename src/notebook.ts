import type { Rect } from './images';

/**
 * Тетрадь: доска раскладывается по листам A4 и скачивается одним PDF.
 * Каждый лист — картинка: так рукописные формулы и рисунки выглядят ровно как на доске,
 * а русские буквы в заголовке не зависят от шрифтов внутри PDF.
 */

/** Что нужно тетради от доски. */
export type NotebookSource = {
  /** Прямоугольники всего, что лежит на доске: по ним ищем, где можно разрезать лист. */
  boxes: Rect[];
  /** Рисует участок доски в печатных цветах. Преобразование координат уже настроено. */
  paint: (ctx: CanvasRenderingContext2D) => void;
  title: string;
  subtitle: string;
  fileName: string;
};

/** Размер листа A4 в миллиметрах. */
const A4 = { w: 210, h: 297 };
const MARGIN = 12;
const HEADER = 16;
const FOOTER = 10;
/** Пикселей на миллиметр: около 200 точек на дюйм, чётко при печати и не слишком тяжело. */
const PX_PER_MM = 8;
/**
 * Самый крупный масштаб: миллиметров на единицу доски. Примерно как на экране,
 * чтобы маленькая доска не растягивалась на весь лист.
 */
const MAX_SCALE = 0.3;
/** Поле вокруг содержимого доски, в её единицах. */
const PAD = 12;
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Общий прямоугольник для всех предметов. */
function union(boxes: Rect[]): Rect {
  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w));
  const y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x1 - PAD, y: y1 - PAD, w: x2 - x1 + PAD * 2, h: y2 - y1 + PAD * 2 };
}

/**
 * Делит доску по высоте на куски размером с лист. Режем там, где ничего нет:
 * между карточками, рисунками и линиями, а пустые промежутки между листами пропускаем.
 * Если предмет выше листа, режем по краю листа: иначе его не вместить.
 */
export function slicePages(boxes: Rect[], top: number, bottom: number, pageHeight: number): [number, number][] {
  const spans = boxes.map((b) => [b.y - PAD, b.y + b.h + PAD] as const);
  const free = (y: number) => spans.every(([a, b]) => y <= a || y >= b);
  const pages: [number, number][] = [];
  let y = top;
  while (y < bottom - 1) {
    const limit = y + pageHeight;
    if (limit >= bottom) {
      pages.push([y, bottom]);
      break;
    }
    // Лучший разрез — самый нижний свободный край предмета, но не выше половины листа.
    const candidates = spans
      .flat()
      .filter((c) => c > y + pageHeight * 0.4 && c <= limit && free(c))
      .sort((a, b) => b - a);
    const cut = candidates[0] ?? limit;
    pages.push([y, cut]);
    // Следующий лист начинается с ближайшего предмета ниже разреза, без пустоты сверху.
    const crossing = spans.some(([a, b]) => a < cut && b > cut);
    const below = spans.filter(([a]) => a >= cut).map(([a]) => a);
    y = crossing || !below.length ? cut : Math.min(...below);
  }
  return pages;
}

/** Цвета печатного листа: всегда светлая бумага, как в светлой теме. */
const INK = '#25231f';
const MUTED = '#6b6559';
const ACCENT = '#ae4f29';

function drawHeader(ctx: CanvasRenderingContext2D, source: NotebookSource, width: number): void {
  const mm = PX_PER_MM;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK;
  ctx.font = `600 ${5.2 * mm}px ${FONT}`;
  ctx.fillText(source.title, MARGIN * mm, (MARGIN + 5) * mm, (width - MARGIN * 2 - 20) * mm);
  ctx.fillStyle = MUTED;
  ctx.font = `${3.4 * mm}px ${FONT}`;
  ctx.fillText(source.subtitle, MARGIN * mm, (MARGIN + 10.5) * mm);
  ctx.fillStyle = ACCENT;
  ctx.font = `600 ${3.4 * mm}px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText('Tiza', (width - MARGIN) * mm, (MARGIN + 5) * mm);
  ctx.textAlign = 'left';
}

function drawFooter(ctx: CanvasRenderingContext2D, page: number, total: number, width: number, height: number): void {
  const mm = PX_PER_MM;
  ctx.fillStyle = MUTED;
  ctx.font = `${3 * mm}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(`${page} / ${total}`, (width / 2) * mm, (height - MARGIN + 2) * mm);
  ctx.textAlign = 'left';
}

/** Собирает PDF и отдаёт его браузеру на скачивание. Возвращает число листов. */
export async function downloadNotebook(source: NotebookSource): Promise<number> {
  const area = union(source.boxes);
  // Широкую доску удобнее читать на альбомном листе.
  const landscape = area.w > area.h;
  const page = landscape ? { w: A4.h, h: A4.w } : A4;
  const printW = page.w - MARGIN * 2;
  const printH = page.h - MARGIN - HEADER - FOOTER - MARGIN;
  const scale = Math.min(printW / area.w, MAX_SCALE);
  const slices = slicePages(source.boxes, area.y, area.y + area.h, printH / scale);

  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(page.w * PX_PER_MM);
  canvas.height = Math.round(page.h * PX_PER_MM);
  const ctx = canvas.getContext('2d')!;
  const k = scale * PX_PER_MM;
  const left = MARGIN * PX_PER_MM;
  const top = (MARGIN + HEADER) * PX_PER_MM;

  slices.forEach(([y1, y2], i) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawHeader(ctx, source, page.w);
    drawFooter(ctx, i + 1, slices.length, page.w, page.h);

    ctx.save();
    // Обрезаем по куску: то, что разрезано краем листа, не залезает на поля.
    ctx.beginPath();
    ctx.rect(left, top, area.w * k, (y2 - y1) * k);
    ctx.clip();
    ctx.setTransform(k, 0, 0, k, left - area.x * k, top - y1 * k);
    source.paint(ctx);
    ctx.restore();

    if (i > 0) pdf.addPage();
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, page.w, page.h, undefined, 'FAST');
  });
  pdf.save(source.fileName);
  return slices.length;
}
