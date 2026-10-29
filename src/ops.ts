/**
 * Изменения доски, которые летят через сервер к другим вкладкам и ученику.
 * Этот файл общий для браузера и сервера, поэтому в нём нет импортов.
 */

/** Всё на доске имеет id, по нему вкладки понимают, о чём речь. */
export type Item = { id: string };
export type ListName = 'strokes' | 'images' | 'cards' | 'shapes';
export type BoardData = Record<ListName, Item[]>;

export type Op =
  | { type: 'add'; list: ListName; items: Item[] }
  | { type: 'remove'; list: ListName; ids: string[] }
  | { type: 'move'; list: ListName; id: string; rect: { x: number; y: number; w: number; h: number } };

export const LISTS: ListName[] = ['strokes', 'images', 'cards', 'shapes'];

export function emptyBoard(): BoardData {
  return { strokes: [], images: [], cards: [], shapes: [] };
}

/** Применяет изменение к доске. Повторное добавление того же id ничего не ломает. */
export function applyOp(board: BoardData, op: Op): void {
  const list = board[op.list];
  if (op.type === 'add') {
    for (const item of op.items) if (!list.some((i) => i.id === item.id)) list.push(item);
  } else if (op.type === 'remove') {
    // Меняем тот же массив, а не создаём новый: доска в браузере держит ссылки на эти массивы.
    for (let i = list.length - 1; i >= 0; i--) if (op.ids.includes(list[i].id)) list.splice(i, 1);
  } else {
    const item = list.find((i) => i.id === op.id);
    if (item) Object.assign(item, op.rect);
  }
}
