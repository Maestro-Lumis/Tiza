/**
 * Кнопки «переименовать» и «удалить» для строки списка (ученика или темы)
 * и редактирование названия прямо в строке.
 */

const PENCIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5l3.8-.9L19 7.9a1.9 1.9 0 000-2.7l-.2-.2a1.9 1.9 0 00-2.7 0L5.4 15.7z" /></svg>';
const TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>';

function iconButton(svg: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-action';
  button.innerHTML = svg;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.addEventListener('click', onClick);
  return button;
}

/**
 * Заменяет ссылку в строке полем ввода. Enter или клик мимо — сохранить, Esc — отменить.
 * Пустое название не сохраняется.
 */
function editInline(link: HTMLAnchorElement, save: (value: string) => void, done: () => void): void {
  const input = document.createElement('input');
  input.className = 'row-edit';
  input.value = link.textContent ?? '';
  input.setAttribute('aria-label', 'Новое название');
  link.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = (keep: boolean) => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (keep && value) save(value);
    done();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

/**
 * Добавляет в строку кнопки. После любого изменения вызывается refresh, чтобы перерисовать список.
 * deleteQuestion — текст подтверждения, например «Удалить Андрея вместе с темами и досками?».
 */
export function addRowActions(
  item: HTMLLIElement,
  link: HTMLAnchorElement,
  opts: { rename: (value: string) => void; remove: () => void; deleteQuestion: string; refresh: () => void },
): void {
  const actions = document.createElement('span');
  actions.className = 'row-actions';
  actions.append(
    iconButton(PENCIL, 'Переименовать', () => editInline(link, opts.rename, opts.refresh)),
    iconButton(TRASH, 'Удалить', () => {
      if (!confirm(opts.deleteQuestion)) return;
      opts.remove();
      opts.refresh();
    }),
  );
  item.append(actions);
}
