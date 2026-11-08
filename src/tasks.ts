/** Задание из документа: «Задание 3» и его текст. */
export type Task = { title: string; text: string };

/**
 * Начало нового задания: «Задание 1», «Задание №2», «Упражнение 3а», «Задача 4», «№ 214».
 * После номера может стоять точка, скобка или двоеточие.
 */
const MARKER = /^\s*((?:задани[ея]|упражнени[ея]|задач[аи])\s*№?\s*\d+[а-яa-z]?|№\s*\d+[а-яa-z]?)\s*[.):]?\s*/i;

/**
 * Пункт верхнего нумерованного списка: «1. Решите…» или «2) Найдите…».
 * Вложенные пункты начинаются с отступа, поэтому сюда не попадают.
 */
const LIST_ITEM = /^(\d+)[.)]\s+/;

/** Пробелы по краям строки. Отступ вложенных пунктов (широкий пробел) не трогаем. */
const EDGE_SPACES = /^[ \u00a0]+|[ \u00a0]+$/g;

/**
 * Делит текст документа на задания по меткам в начале абзаца.
 * Всё, что стоит до первой метки (например, «Вариант 1»), пропускается.
 * Если меток «Задание 1», «№ 3» в документе нет, заданиями становятся пункты
 * верхнего нумерованного списка, а вложенные пункты остаются внутри своего задания.
 */
export function splitTasks(raw: string): Task[] {
  // Обрезаем только пробелы: табуляции по краям — это пустые ячейки таблицы.
  const lines = raw.split('\n').map((l) => l.replace(EDGE_SPACES, '')).filter(Boolean);
  const byMarker = lines.some((l) => MARKER.test(l));
  const tasks: Task[] = [];
  let current: Task | null = null;
  for (const line of lines) {
    let title = '';
    let rest = '';
    if (byMarker) {
      const m = line.match(MARKER);
      if (m) {
        // «задание 2» → «Задание 2»: заголовок карточки всегда с большой буквы.
        const t = m[1].replace(/\s+/g, ' ');
        title = t[0].toUpperCase() + t.slice(1);
        rest = line.slice(m[0].length);
      }
    } else {
      const m = line.match(LIST_ITEM);
      if (m) {
        title = `Задание ${m[1]}`;
        rest = line.slice(m[0].length);
      }
    }
    if (title) {
      current = { title, text: rest };
      tasks.push(current);
    } else if (current) {
      current.text += (current.text ? '\n' : '') + line;
    }
  }
  return tasks;
}

/** Отступ вложенного пункта: широкие пробелы не съедаются при обрезке строк. */
const INDENT = '\u2003';
const CYRILLIC = 'абвгдежзиклмнопрстуфхцчшщэюя';
const LATIN = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Номер пункта так, как он обычно выглядит в задании: «1.» на первом уровне,
 * «а)» на втором (латинские буквы, если пункт на латинице), «1)» глубже.
 */
function itemMark(kind: string, depth: number, index: number, text: string): string {
  if (kind === 'UL') return '•';
  if (depth === 0) return `${index + 1}.`;
  if (depth === 1) {
    const letters = /[а-яё]/i.test(text) ? CYRILLIC : LATIN;
    return `${letters[index % letters.length]})`;
  }
  return `${index + 1})`;
}

/** Текст пункта без вложенных в него списков: их выводим отдельными строками. */
function ownText(item: Element): string {
  const copy = item.cloneNode(true) as Element;
  copy.querySelectorAll('ol, ul').forEach((list) => list.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Строки списка с номерами; вложенные пункты сдвинуты отступом. */
function listLines(list: Element, depth: number, lines: string[]): void {
  // Список в Word может начинаться не с единицы: «start» хранит первый номер.
  const start = Number(list.getAttribute('start') ?? 1) - 1;
  [...list.children]
    .filter((el) => el.tagName === 'LI')
    .forEach((item, i) => {
      const text = ownText(item);
      if (text) lines.push(`${INDENT.repeat(depth * 2)}${itemMark(list.tagName, depth, start + i, text)} ${text}`);
      for (const inner of item.children) {
        if (inner.tagName === 'OL' || inner.tagName === 'UL') listLines(inner, depth + 1, lines);
      }
    });
}

/**
 * Достаёт текст из файла Word (.docx). Библиотеку mammoth грузим только когда она нужна,
 * чтобы доска открывалась быстро.
 * Каждый абзац — своя строка. Строка таблицы — тоже одна строка, ячейки в ней разделены
 * табуляцией: по ней карточка поймёт, что это таблица, и нарисует её сеткой.
 * Пункты списков получают номера «1.», «а)», как в документе.
 */
export async function readDocx(file: File): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  const body = new DOMParser().parseFromString(value, 'text/html').body;
  const lines: string[] = [];
  const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  for (const el of body.children) {
    if (el.tagName === 'TABLE') {
      for (const row of el.querySelectorAll('tr')) {
        // В ячейке может быть несколько абзацев — склеиваем их через пробел.
        const cells = [...row.children].map((cell) => [...cell.querySelectorAll('p')].map(text).join(' ') || text(cell));
        lines.push(cells.join('\t'));
      }
    } else if (el.tagName === 'UL' || el.tagName === 'OL') {
      listLines(el, 0, lines);
    } else {
      lines.push(text(el));
    }
  }
  return lines.join('\n');
}
