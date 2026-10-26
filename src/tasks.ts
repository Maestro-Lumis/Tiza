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
  for (const line of raw.split('\n').map((l) => l.trim())) {
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
 */
export async function readDocx(file: File): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return value;
}
