import { addStudent, loadStudents } from './students';

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
      link.href = `/student.html?id=${encodeURIComponent(s.id)}`;
      link.textContent = s.name;
      const item = document.createElement('li');
      item.append(link);
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

render();
