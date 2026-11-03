/** Задание из документа: «Задание 3» и его текст. */
export type Task = { title: string; text: string };

/**
 * Начало нового задания: «Задание 1», «Задание №2», «Упражнение 3а», «Задача 4», «№ 214».
 * После номера может стоять точка, скобка или двоеточие.
 */
const MARKER = /^\s*((?:задани[ея]|упражнени[ея]|задач[аи])\s*№?\s*\d+[а-яa-z]?|№\s*\d+[а-яa-z]?)\s*[.):]?\s*/i;

/**
 * Делит текст документа на задания по меткам в начале абзаца.
 * Всё, что стоит до первой метки (например, «Вариант 1»), пропускается.
 */
export function splitTasks(raw: string): Task[] {
  const tasks: Task[] = [];
  let current: Task | null = null;
  // Обрезаем только пробелы: табуляции по краям — это пустые ячейки таблицы.
  for (const line of raw.split('\n').map((l) => l.replace(/^[  ]+|[  ]+$/g, ''))) {
    if (!line) continue;
    const m = line.match(MARKER);
    if (m) {
      // «задание 2» → «Задание 2»: заголовок карточки всегда с большой буквы.
      const title = m[1].replace(/\s+/g, ' ');
      current = { title: title[0].toUpperCase() + title.slice(1), text: line.slice(m[0].length) };
      tasks.push(current);
    } else if (current) {
      current.text += (current.text ? '\n' : '') + line;
    }
  }
  return tasks;
}

/**
 * Достаёт текст из файла Word (.docx). Библиотеку mammoth грузим только когда она нужна,
 * чтобы доска открывалась быстро.
 * Каждый абзац — своя строка. Строка таблицы — тоже одна строка, ячейки в ней разделены
 * табуляцией: по ней карточка поймёт, что это таблица, и нарисует её сеткой.
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
      for (const item of el.querySelectorAll('li')) lines.push(text(item));
    } else {
      lines.push(text(el));
    }
  }
  return lines.join('\n');
}
