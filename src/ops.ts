/**
 * Изменения доски, которые летят через сервер к другим вкладкам и ученику.
 * Этот файл общий для браузера и сервера, поэтому в нём нет импортов.
 */

/** Всё на доске имеет id, по нему вкладки понимают, о чём речь. */
export type Item = { id: string; wipes?: Wipe[] };
/**
 * След губки на предмете. Точки и радиус - в долях размера предмета,
 * поэтому стёртое остаётся на месте, когда предмет двигают или растягивают.
 */
export type Wipe = { id: string; r: number; points: { x: number; y: number }[] };
/** pages - рамки листов тетради: что внутри рамки, то и попадёт на страницу PDF. */
export type ListName = 'strokes' | 'images' | 'cards' | 'shapes' | 'pages';
export type BoardData = Record<ListName, Item[]>;

export type Op =
  | { type: 'add'; list: ListName; items: Item[] }
  | { type: 'remove'; list: ListName; ids: string[] }
  // s - масштаб карточки задания; f и n - формат и номер листа тетради.
  | { type: 'move'; list: ListName; id: string; rect: { x: number; y: number; w: number; h: number; s?: number; f?: string; n?: number } }
  // Как нарисован предмет: у фигуры цвет, толщина линии, пунктир, заливка, число долей.
  | { type: 'style'; list: ListName; id: string; style: Record<string, string | number | boolean> }
  | { type: 'wipe'; list: ListName; id: string; wipe: Wipe }
  | { type: 'unwipe'; list: ListName; id: string; wipeId: string };

/**
 * След лазерной указки: летит к остальным сразу и нигде не сохраняется.
 * start - первая точка нового движения, с прошлым следом её не соединяем.
 */
export type Laser = { type: 'laser'; x: number; y: number; start?: boolean };

/**
 * Живое рисование: то, что человек делает прямо сейчас, пока не отпустил мышь.
 * Летит к остальным сразу и не сохраняется: когда он отпустит мышь, придёт обычное изменение.
 * stroke - новые точки линии начиная с номера from; shape - растягиваемая фигура целиком;
 * move - предмет, который двигают или растягивают.
 */
export type Live =
  | { type: 'live'; kind: 'stroke'; id: string; color: string; w?: number; from: number; points: { x: number; y: number }[] }
  | { type: 'live'; kind: 'shape'; shape: Item & { x: number; y: number; w: number; h: number } }
  | { type: 'live'; kind: 'move'; list: ListName; id: string; rect: { x: number; y: number; w: number; h: number; s?: number } }
  // Где сейчас мышь учителя или ученика на доске; away - мышь ушла с доски.
  | { type: 'live'; kind: 'cursor'; role: 'teacher' | 'student'; x: number; y: number; away?: boolean };

export const LISTS: ListName[] = ['strokes', 'images', 'cards', 'shapes', 'pages'];

export function emptyBoard(): BoardData {
  return { strokes: [], images: [], cards: [], shapes: [], pages: [] };
}

/** Применяет изменение к доске. Повторное применение того же изменения ничего не ломает:
 * изменения, сделанные без связи, могут дойти до сервера дважды. */
export function applyOp(board: BoardData, op: Op): void {
  // В досках, сохранённых до появления тетради, списка листов ещё нет.
  const list = (board[op.list] ??= []);
  if (op.type === 'add') {
    for (const item of op.items) if (!list.some((i) => i.id === item.id)) list.push(item);
  } else if (op.type === 'remove') {
    // Меняем тот же массив, а не создаём новый: доска в браузере держит ссылки на эти массивы.
    for (let i = list.length - 1; i >= 0; i--) if (op.ids.includes(list[i].id)) list.splice(i, 1);
  } else {
    const item = list.find((i) => i.id === op.id);
    if (!item) return;
    if (op.type === 'move') Object.assign(item, op.rect);
    else if (op.type === 'style') Object.assign(item, op.style);
    else if (op.type === 'wipe') {
      item.wipes ??= [];
      if (!item.wipes.some((w) => w.id === op.wipe.id)) item.wipes.push(op.wipe);
    }
    else item.wipes = item.wipes?.filter((w) => w.id !== op.wipeId);
  }
}
