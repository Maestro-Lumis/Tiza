import { addRowActions } from './row-actions';
import {
  addTopic,
  deleteTopic,
  getStudent,
  renameTopic,
  setTopicStatus,
  type Topic,
  type TopicStatus,
} from './students';
import './theme';

const studentId = new URLSearchParams(location.search).get('id') ?? '';

const title = document.querySelector<HTMLHeadingElement>('#title')!;
const list = document.querySelector<HTMLOListElement>('#topics')!;
const empty = document.querySelector<HTMLParagraphElement>('#empty')!;
const form = document.querySelector<HTMLFormElement>('#add')!;
const input = document.querySelector<HTMLInputElement>('#topic')!;
const error = document.querySelector<HTMLParagraphElement>('#error')!;

const LABEL: Record<TopicStatus, string> = { done: 'пройдено', now: 'сейчас', next: 'впереди' };
/** Клик по статусу переключает его по кругу: впереди → сейчас → пройдено → впереди. */
const NEXT: Record<TopicStatus, TopicStatus> = { next: 'now', now: 'done', done: 'next' };

function topicItem(t: Topic): HTMLLIElement {
  const status = document.createElement('button');
  status.className = `status is-${t.status}`;
  status.textContent = LABEL[t.status];
  status.title = 'Сменить статус';
  status.addEventListener('click', () => {
    setTopicStatus(studentId, t.id, NEXT[t.status]);
    render();
  });

  const link = document.createElement('a');
  link.href = `/board.html?student=${encodeURIComponent(studentId)}&topic=${encodeURIComponent(t.id)}`;
  link.textContent = t.title;

  const item = document.createElement('li');
  item.append(link, status);
  addRowActions(item, link, {
    rename: (name) => renameTopic(studentId, t.id, name),
    remove: () => deleteTopic(studentId, t.id),
    deleteQuestion: `Удалить тему «${t.title}» вместе с её доской? Вернуть не получится.`,
    refresh: render,
  });
  return item;
}

function render(): void {
  const student = getStudent(studentId);
  document.querySelector<HTMLElement>('#found')!.hidden = !student;
  document.querySelector<HTMLElement>('#missing')!.hidden = !!student;
  if (!student) return;

  title.textContent = student.name;
  document.title = `Tiza: ${student.name}`;
  const topics = student.topics ?? [];
  list.replaceChildren(...topics.map(topicItem));
  empty.hidden = topics.length > 0;
}

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
