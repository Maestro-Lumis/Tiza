/** Тема в дорожной карте: пройдена, идёт сейчас или впереди. */
export type TopicStatus = 'done' | 'now' | 'next';
export type Topic = { id: string; title: string; status: TopicStatus };
export type Student = { id: string; name: string; topics?: Topic[] };

/** Ключ, под которым список учеников лежит в хранилище браузера. */
const STORAGE_KEY = 'tiza:students';

export function loadStudents(): Student[] {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveStudents(students: Student[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(students));
  } catch {
    // Хранилище недоступно: изменения видны до перезагрузки страницы.
  }
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Имя для адреса страницы: «Андрей» → andrey. */
function slug(name: string): string {
  const latin = [...name.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join('');
  return latin.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'student';
}

/** Добавляет ученика; если такой адрес уже занят, дописывает номер: andrey-2. */
export function addStudent(name: string): Student {
  const students = loadStudents();
  const base = slug(name);
  let id = base;
  for (let n = 2; students.some((s) => s.id === id); n++) id = `${base}-${n}`;
  const student = { id, name, topics: [] };
  saveStudents([...students, student]);
  return student;
}

export function getStudent(id: string): Student | undefined {
  return loadStudents().find((s) => s.id === id);
}

/** Меняет одного ученика и сохраняет весь список. */
function updateStudent(id: string, change: (s: Student) => void): void {
  const students = loadStudents();
  const student = students.find((s) => s.id === id);
  if (!student) return;
  change(student);
  saveStudents(students);
}

/** Новая тема встаёт в конец дорожной карты со статусом «впереди». */
export function addTopic(studentId: string, title: string): void {
  updateStudent(studentId, (s) => {
    const topic: Topic = { id: crypto.randomUUID().slice(0, 8), title, status: 'next' };
    s.topics = [...(s.topics ?? []), topic];
  });
}

export function setTopicStatus(studentId: string, topicId: string, status: TopicStatus): void {
  updateStudent(studentId, (s) => {
    const topic = s.topics?.find((t) => t.id === topicId);
    if (topic) topic.status = status;
  });
}
