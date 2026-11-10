import { addRowActions } from './row-actions';
import { addStudent, deleteStudent, getStudent, loadStudents, renameStudent } from './students';
import { hasServer, syncRoadmap, wakeServer } from './sync';
import { loginLink, onSaveState, pull, takeKeyFromLink, type SaveState } from './account';
import './theme';

const list = document.querySelector<HTMLUListElement>('#students')!;
const empty = document.querySelector<HTMLParagraphElement>('#empty')!;
const form = document.querySelector<HTMLFormElement>('#add')!;
const input = document.querySelector<HTMLInputElement>('#name')!;
const error = document.querySelector<HTMLParagraphElement>('#error')!;

/** Рисует список: у каждого ученика ссылка на его дорожную карту. */
function render(): void {
  const students = loadStudents();
  list.replaceChildren(
    ...students.map((s) => {
      const link = document.createElement('a');
      link.href = `student.html?id=${encodeURIComponent(s.id)}`;
      link.textContent = s.name;
      const item = document.createElement('li');
      item.append(link);
      addRowActions(item, link, {
        rename: (name) => {
          renameStudent(s.id, name);
          syncRoadmap(getStudent(s.id));
        },
        remove: () => deleteStudent(s.id),
        deleteQuestion: `Удалить ученика «${s.name}» вместе со всеми темами и досками? Вернуть не получится.`,
        refresh: render,
      });
      return item;
    }),
  );
  empty.hidden = students.length > 0;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = input.value.trim();
  if (!name) {
    error.hidden = false;
    input.focus();
    return;
  }
  addStudent(name);
  input.value = '';
  render();
});

input.addEventListener('input', () => (error.hidden = true));

/* ---------- сохранение на сервере и вход с другого браузера ---------- */

const account = document.querySelector<HTMLElement>('#account')!;
const loginButton = document.querySelector<HTMLButtonElement>('#login-link')!;
const loginNotice = document.querySelector<HTMLParagraphElement>('#login-notice')!;
const saveState = document.querySelector<HTMLParagraphElement>('#save-state')!;

const SAVE_TEXT: Record<SaveState, string> = {
  saved: 'Список сохранён на сервере.',
  saving: 'Сохраняю на сервере… Если сервер спал, это до минуты.',
  offline: 'Сервер не отвечает: изменения пока только в этом браузере. Отправлю, когда он ответит.',
  local: '',
};

account.hidden = !hasServer;
onSaveState((state) => {
  saveState.textContent = SAVE_TEXT[state];
  saveState.dataset.state = state;
});

loginButton.addEventListener('click', async () => {
  loginNotice.hidden = false;
  const link = loginLink();
  try {
    await navigator.clipboard.writeText(link);
    loginNotice.textContent = 'Ссылка скопирована. Открой её в другом браузере - там появятся все ученики.';
  } catch {
    loginNotice.textContent = `Скопируй ссылку входа: ${link}`;
  }
});

takeKeyFromLink();
render();
// Ссылку входа открыли во вкладке, где сайт уже открыт: страница не перезагружается.
window.addEventListener('hashchange', () => {
  if (takeKeyFromLink()) void pull().then(render);
});
// Список мог поменяться в другом браузере: сверяемся с сервером и рисуем заново.
void pull().then((changed) => changed && render());
// Сервер засыпает без посетителей: будим его, пока выбираешь ученика и тему.
wakeServer();
