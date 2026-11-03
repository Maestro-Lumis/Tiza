import type { Wipe } from './ops';

/** Картинка на доске: скриншот или файл. Координаты и размер — в координатах доски. */
export type BoardImage = { id: string; src: string; x: number; y: number; w: number; h: number; wipes?: Wipe[] };
export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Большие скриншоты уменьшаем до 1600 px по длинной стороне:
 * доска хранится в браузере, а там мало места (около 5 МБ на сайт).
 */
const MAX_SIDE = 1600;

/** Читает файл картинки, при необходимости уменьшает и возвращает её как строку data:… с размерами. */
export function readImage(file: Blob): Promise<{ src: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * k);
      const h = Math.round(img.naturalHeight * k);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      // WebP заметно легче PNG при том же качестве; если браузер его не умеет, вернётся PNG.
      resolve({ src: canvas.toDataURL('image/webp', 0.9), w, h });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Не получилось прочитать картинку'));
    };
    img.src = url;
  });
}

const loaded = new Map<string, HTMLImageElement>();

/**
 * Готовая к отрисовке картинка. Пока она грузится, возвращает null,
 * а когда загрузится — вызывает onReady, чтобы перерисовать доску.
 */
export function imageElement(item: BoardImage, onReady: () => void): HTMLImageElement | null {
  let img = loaded.get(item.id);
  if (!img) {
    img = new Image();
    img.onload = onReady;
    img.src = item.src;
    loaded.set(item.id, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

export function contains(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export const rectOf = (i: Rect): Rect => ({ x: i.x, y: i.y, w: i.w, h: i.h });

const backgrounds = new Map<string, string>();

/**
 * Цвет фона картинки: самый частый цвет по её краю (у скриншота это обычно белый лист).
 * Им губка закрашивает стёртое на картинке. Считается один раз на картинку.
 */
export function backgroundOf(id: string, img: HTMLImageElement): string {
  const known = backgrounds.get(id);
  if (known) return known;
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d', { willReadFrequently: true })!;
  c.drawImage(img, 0, 0, size, size);
  const data = c.getImageData(0, 0, size, size).data;
  // По каждой группе похожих оттенков: сколько точек и сумма их цветов.
  const groups = new Map<string, number[]>();
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = Math.floor(i / size);
    if (x > 0 && x < size - 1 && y > 0 && y < size - 1) continue;
    // Похожие оттенки считаем одним цветом, чтобы шум и сглаживание не мешали.
    const key = [0, 1, 2].map((k) => Math.round(data[i * 4 + k] / 16)).join(',');
    const g = groups.get(key) ?? [0, 0, 0, 0];
    for (let k = 0; k < 3; k++) g[k] += data[i * 4 + k];
    g[3]++;
    groups.set(key, g);
  }
  // Самая большая группа, а цвет — среднее её точек, чтобы заплатка совпала с фоном.
  const top = [...groups.values()].sort((a, b) => b[3] - a[3])[0];
  const color = top ? `rgb(${top.slice(0, 3).map((v) => Math.round(v / top[3])).join(',')})` : '#fff';
  backgrounds.set(id, color);
  return color;
}
