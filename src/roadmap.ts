import { fetchRoadmap, hasServer } from './sync';
import type { Roadmap, TopicStatus } from './students';
import './theme';

/** Ключ карты из ссылки учителя: roadmap.html?key=… */
const key = new URLSearchParams(location.search).get('key') ?? '';

const title = document.querySelector<HTMLHeadingElement>('#title')!;
const list = document.querySelector<HTMLOListElement>('#topics')!;
const message = document.querySelector<HTMLParagraphElement>('#message')!;

const LABEL: Record<TopicStatus, string> = { done: 'пройдено', now: 'сейчас', next: 'впереди' };
/** Сколько ждать перед новой попыткой, если сервер не ответил (он мог спать). */
const RETRY = 5000;

function show(text: string): void {
  message.textContent = text;
  message.hidden = !text;
}

function render(map: Roadmap): void {
  title.textContent = map.name;
  document.title = `Tiza: ${map.name}`;
  list.replaceChildren(
    ...map.topics.map((t) => {
      const link = document.createElement('a');
      // Доска знает, куда вернуться: обратно к этой карте.
      link.href = `board.html?${new URLSearchParams({ room: t.room, title: t.title, map: key })}`;
      link.textContent = t.title;
      const status = document.createElement('span');
      status.className = `status is-static is-${t.status}`;
      status.textContent = LABEL[t.status];
      const item = document.createElement('li');
      item.append(link, status);
      return item;
    }),
  );
  show(map.topics.length ? '' : 'Тем пока нет. Учитель добавит их, и они появятся здесь.');
}

async function load(): Promise<void> {
  const map = await fetchRoadmap(key);
  if (map === 'missing') return show('Ссылка неверная или устарела. Попроси у учителя новую.');
  if (!map) {
    show('Сервер пока не отвечает, пробую снова…');
    setTimeout(load, RETRY);
    return;
  }
  render(map);
}

if (!hasServer) show('Сайт пока не подключён к серверу, поэтому темы здесь не появятся.');
else void load();
