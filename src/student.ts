import { addRowActions } from './row-actions';
import {
  addTopic,
  deleteTopic,
  getStudent,
  renameTopic,
  setTopicStatus,
  studentShare,
  roadmapOf,
  type Topic,
  type TopicStatus,
} from './students';
import { hasServer, publishRoadmap, syncRoadmap, wakeServer } from './sync';
import { currentLogin, pull } from './account';
import './theme';

const studentId = new URLSearchParams(location.search).get('id') ?? '';
// Ученики есть только у вошедшего учителя: без входа - на главную, там спросят логин и пароль.
if (hasServer && !currentLogin()) location.replace('./');

const title = document.querySelector<HTMLHeadingElement>('#title')!;
const list = document.querySelector<HTMLOListElement>('#topics')!;
const empty = document.querySelector<HTMLParagraphElement>('#empty')!;
const form = document.querySelector<HTMLFormElement>('#add')!;
const input = document.querySelector<HTMLInputElement>('#topic')!;
const error = document.querySelector<HTMLParagraphElement>('#error')!;
const shareButton = document.querySelector<HTMLButtonElement>('#share')!;
const shareNotice = document.querySelector<HTMLParagraphElement>('#share-notice')!;

const LABEL: Record<TopicStatus, string> = { done: 'пройдено', now: 'сейчас', next: 'впереди' };
/** Порядок пунктов в списке статусов: как тема движется по дорожной карте. */
const ORDER: TopicStatus[] = ['next', 'now', 'done'];

/** Открытый список статусов: одновременно открыт только один. */
let openMenu: { menu: HTMLElement; button: HTMLButtonElement } | null = null;

function closeMenu(focusButton = false): void {
  if (!openMenu) return;
  openMenu.menu.remove();
  openMenu.button.setAttribute('aria-expanded', 'false');
  if (focusButton) openMenu.button.focus();
  openMenu = null;
}

/** Список из трёх статусов под кнопкой; текущий отмечен галочкой. */
function openStatusMenu(button: HTMLButtonElement, t: Topic): void {
  const menu = document.createElement('div');
  menu.className = 'status-menu';
  menu.setAttribute('role', 'menu');
  for (const status of ORDER) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = `status-option is-${status}`;
    option.setAttribute('role', 'menuitemradio');
    option.setAttribute('aria-checked', String(status === t.status));
    option.textContent = LABEL[status];
    option.addEventListener('click', () => {
      closeMenu();
      if (status !== t.status) setTopicStatus(studentId, t.id, status);
      render();
    });
    menu.append(option);
  }
  button.after(menu);
  button.setAttribute('aria-expanded', 'true');
  openMenu = { menu, button };
  menu.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
}

// Клик мимо списка или Esc закрывают его.
document.addEventListener('click', (e) => {
  if (openMenu && !openMenu.menu.contains(e.target as Node) && e.target !== openMenu.button) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (!openMenu) return;
  if (e.key === 'Escape') closeMenu(true);
  // Стрелки двигают выбор по пунктам списка.
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const options = [...openMenu.menu.querySelectorAll<HTMLButtonElement>('button')];
    const i = options.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    options[(i + step + options.length) % options.length].focus();
  }
});

function topicItem(t: Topic): HTMLLIElement {
  const status = document.createElement('button');
  status.className = `status is-${t.status}`;
  status.textContent = LABEL[t.status];
  status.title = 'Сменить статус';
  status.setAttribute('aria-haspopup', 'menu');
  status.setAttribute('aria-expanded', 'false');
  status.addEventListener('click', () => {
    const wasOpen = openMenu?.button === status;
    closeMenu();
    if (!wasOpen) openStatusMenu(status, t);
  });

  const wrap = document.createElement('div');
  wrap.className = 'status-wrap';
  wrap.append(status);

  const link = document.createElement('a');
  link.href = `board.html?student=${encodeURIComponent(studentId)}&topic=${encodeURIComponent(t.id)}`;
  link.textContent = t.title;

  const item = document.createElement('li');
  item.append(link, wrap);
  addRowActions(item, link, {
    rename: (name) => renameTopic(studentId, t.id, name),
    remove: () => deleteTopic(studentId, t.id),
    deleteQuestion: `Удалить тему «${t.title}» вместе с её доской? Вернуть не получится.`,
    refresh: render,
  });
  return item;
}

function render(): void {
  closeMenu();
  const student = getStudent(studentId);
  document.querySelector<HTMLElement>('#found')!.hidden = !student;
  document.querySelector<HTMLElement>('#missing')!.hidden = !!student;
  if (!student) return;

  title.textContent = student.name;
  document.title = `Tiza: ${student.name}`;
  const topics = student.topics ?? [];
  list.replaceChildren(...topics.map(topicItem));
  empty.hidden = topics.length > 0;
  // Темы и статусы меняются только здесь: сразу отправляем их ученику.
  syncRoadmap(student);
}

/* ---------- ссылка ученика на дорожную карту ---------- */

// Без сервера ученик не увидит ни карту, ни доски, поэтому и ссылка не нужна.
shareButton.hidden = !hasServer;
shareButton.addEventListener('click', async () => {
  const share = studentShare(studentId);
  const student = getStudent(studentId);
  if (!share || !student) return;
  shareNotice.hidden = false;
  shareNotice.textContent = 'Готовлю ссылку… Если сервер спал, это до минуты.';
  if (!(await publishRoadmap(share, roadmapOf(student)))) {
    shareNotice.textContent = 'Сервер не ответил. Попробуй ещё раз через минуту.';
    return;
  }
  const link = new URL('roadmap.html', location.href);
  link.search = new URLSearchParams({ key: share.read }).toString();
  try {
    await navigator.clipboard.writeText(link.href);
    shareNotice.textContent = 'Ссылка скопирована: отправь её ученику один раз. Новые темы он увидит сам.';
  } catch {
    shareNotice.textContent = `Скопируй ссылку для ученика: ${link.href}`;
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = input.value.trim();
  if (!name) {
    error.hidden = false;
    input.focus();
    return;
  }
  addTopic(studentId, name);
  input.value = '';
  render();
});

input.addEventListener('input', () => (error.hidden = true));

render();
// Темы могли поменяться в другом браузере: сверяемся с сервером и рисуем заново.
void pull().then((changed) => changed && render());
// Сервер засыпает без посетителей: будим его, пока выбираешь ученика и тему.
wakeServer();
