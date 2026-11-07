import { deleteBoard } from './local';

/** Тема в дорожной карте: пройдена, идёт сейчас или впереди. */
export type TopicStatus = 'done' | 'now' | 'next';
/** room — секретный ключ доски на сервере: его знают только учитель и ученик по ссылке. */
export type Topic = { id: string; title: string; status: TopicStatus; room?: string };
/**
 * share — ключи дорожной карты на сервере: read уходит ученику в ссылке,
 * write остаётся только у учителя, им карту меняют.
 */
export type Student = { id: string; name: string; topics?: Topic[]; share?: { read: string; write: string } };
/** Что видит ученик по своей ссылке: имя и темы с ключами досок. */
export type Roadmap = { name: string; topics: { title: string; status: TopicStatus; room: string }[] };

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
    const topic: Topic = { id: crypto.randomUUID().slice(0, 8), title, status: 'next', room: newRoom() };
    s.topics = [...(s.topics ?? []), topic];
  });
}

/**
 * Секретный ключ доски: 16 случайных байт (22 знака). Адрес доски на сервере не угадать,
 * попасть на неё можно только по ссылке учителя.
 */
export function newRoom(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Ключ доски темы на сервере. У тем, созданных раньше, его ещё нет — придумываем при первом открытии. */
export function topicRoom(studentId: string, topicId: string): string | null {
  let room: string | null = null;
  updateStudent(studentId, (s) => {
    const topic = s.topics?.find((t) => t.id === topicId);
    if (topic) room = topic.room ??= newRoom();
  });
  return room;
}

/* ---------- переименование и удаление ---------- */

/** Ключ доски темы — тот же, что использует board.ts. */
export function boardKey(studentId: string, topicId: string): string {
  return `tiza:board:${studentId}:${topicId}`;
}

function removeBoard(studentId: string, topicId: string): void {
  deleteBoard(boardKey(studentId, topicId));
}

/** Меняет только имя: адрес ученика (andrey) остаётся прежним, ссылки не ломаются. */
export function renameStudent(id: string, name: string): void {
  updateStudent(id, (s) => (s.name = name));
}

/** Удаляет ученика вместе со всеми его темами и досками. */
export function deleteStudent(id: string): void {
  const students = loadStudents();
  const student = students.find((s) => s.id === id);
  for (const t of student?.topics ?? []) removeBoard(id, t.id);
  saveStudents(students.filter((s) => s.id !== id));
}

export function renameTopic(studentId: string, topicId: string, title: string): void {
  updateStudent(studentId, (s) => {
    const topic = s.topics?.find((t) => t.id === topicId);
    if (topic) topic.title = title;
  });
}

/** Удаляет тему из дорожной карты вместе с её доской. */
export function deleteTopic(studentId: string, topicId: string): void {
  updateStudent(studentId, (s) => {
    s.topics = (s.topics ?? []).filter((t) => t.id !== topicId);
  });
  removeBoard(studentId, topicId);
}

export function setTopicStatus(studentId: string, topicId: string, status: TopicStatus): void {
  updateStudent(studentId, (s) => {
    const topic = s.topics?.find((t) => t.id === topicId);
    if (topic) topic.status = status;
  });
}

/* ---------- ссылка ученика на дорожную карту ---------- */

/** Ключи карты ученика; при первом вызове придумывает их. */
export function studentShare(id: string): { read: string; write: string } | null {
  let share: Student['share'] | null = null;
  updateStudent(id, (s) => (share = s.share ??= { read: newRoom(), write: newRoom() }));
  return share;
}

/** Карта для ученика: без адресов и статусов учителя, только то, что ему нужно. */
export function roadmapOf(student: Student): Roadmap {
  return {
    name: student.name,
    topics: (student.topics ?? []).map((t) => ({
      title: t.title,
      status: t.status,
      room: t.room ?? topicRoom(student.id, t.id) ?? '',
    })),
  };
}
