/**
 * Подсказка при наведении: что это за кнопка и какая у неё клавиша.
 * Текст берётся из data-tip, клавиша — из data-key. Обычный title браузер показывает
 * поздно и мелко, поэтому подсказка своя: появляется быстро, над кнопкой.
 */

/** Сколько миллисекунд держать курсор, пока не появится первая подсказка. */
const DELAY = 300;
/** На Mac вместо Ctrl пишем ⌘ — так подписаны клавиши на клавиатуре. */
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

const tip = document.createElement('div');
tip.className = 'tip';
tip.setAttribute('role', 'tooltip');
tip.hidden = true;
document.body.append(tip);

let timer = 0;

function show(el: HTMLElement): void {
  tip.textContent = el.dataset.tip ?? '';
  if (el.dataset.key) {
    const key = document.createElement('kbd');
    key.textContent = MAC ? el.dataset.key.replace('Ctrl', '⌘') : el.dataset.key;
    tip.append(key);
  }
  tip.hidden = false;
  // Над кнопкой по центру, но не за краем окна; у верхнего края — под кнопкой.
  const r = el.getBoundingClientRect();
  const left = r.left + r.width / 2 - tip.offsetWidth / 2;
  const above = r.top - tip.offsetHeight - 10;
  tip.style.left = `${Math.min(Math.max(8, left), innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${above >= 8 ? above : r.bottom + 10}px`;
}

function hide(): void {
  clearTimeout(timer);
  tip.hidden = true;
}

document.addEventListener('pointerover', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-tip]');
  if (!el) return hide();
  clearTimeout(timer);
  // Если подсказка уже видна, соседняя кнопка показывает свою сразу, без ожидания.
  timer = window.setTimeout(() => show(el), tip.hidden ? DELAY : 0);
});
document.addEventListener('pointerout', (e) => {
  if (!e.relatedTarget) hide();
});
document.addEventListener('pointerdown', hide);
// С клавиатуры (Tab) подсказка тоже видна.
document.addEventListener('focusin', (e) => {
  const el = e.target as HTMLElement;
  if (el.dataset?.tip && el.matches(':focus-visible')) show(el);
});
document.addEventListener('focusout', hide);
