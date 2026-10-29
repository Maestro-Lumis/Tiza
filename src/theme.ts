/**
 * Тема сайта: светлая (бумага) или тёмная (школьная доска).
 * Пока кнопку не нажимали, тема берётся из системы. Выбор запоминается в браузере.
 */
import './tooltip';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'tiza:theme';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

const SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>';
const MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" /></svg>';

function saved(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/** Какая тема видна сейчас: выбранная кнопкой или системная. */
export function currentTheme(): Theme {
  return saved() ?? (systemDark.matches ? 'dark' : 'light');
}

/** Ставит иконку: в светлой теме луна (переключить на тёмную), в тёмной — солнце. */
function updateButtons(): void {
  const dark = currentTheme() === 'dark';
  for (const button of document.querySelectorAll<HTMLButtonElement>('.theme-toggle')) {
    button.innerHTML = dark ? SUN : MOON;
    const label = dark ? 'Светлая тема' : 'Тёмная тема: школьная доска';
    button.setAttribute('aria-label', label);
    button.dataset.tip = label;
  }
}

function apply(): void {
  const theme = saved();
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  updateButtons();
  // Доска слушает это событие, чтобы перекрасить холст.
  window.dispatchEvent(new Event('themechange'));
}

function toggle(): void {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Не запомнится после перезагрузки, но переключится сейчас.
  }
  document.documentElement.dataset.theme = next;
  updateButtons();
  window.dispatchEvent(new Event('themechange'));
}

document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.theme-toggle')) toggle();
});
systemDark.addEventListener('change', apply);

apply();
