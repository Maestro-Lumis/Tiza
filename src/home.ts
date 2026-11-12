import { addRowActions } from './row-actions';
import { addStudent, deleteStudent, getStudent, loadStudents, renameStudent } from './students';
import { hasServer, syncRoadmap, wakeServer } from './sync';
import { changePassword, currentLogin, login, loginFree, logout, onSaveState, pull, recover, register, type SaveState } from './account';
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

/* ---------- сохранение на сервере ---------- */

const account = document.querySelector<HTMLElement>('#account')!;
const saveState = document.querySelector<HTMLParagraphElement>('#save-state')!;

const SAVE_TEXT: Record<SaveState, string> = {
  saved: 'Список сохранён на сервере.',
  saving: 'Сохраняю на сервере… Если сервер спал, это до минуты.',
  offline: 'Сервер не отвечает: изменения пока только в этом браузере. Отправлю, когда он ответит.',
  local: '',
};

onSaveState((state) => {
  saveState.textContent = SAVE_TEXT[state];
  saveState.dataset.state = state;
});

/* ---------- вход, регистрация, восстановление ---------- */

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const app = $<HTMLDivElement>('#app');
const auth = $<HTMLElement>('#auth');
const authNote = $<HTMLParagraphElement>('#auth-note');
const tabLogin = $<HTMLButtonElement>('#tab-login');
const tabRegister = $<HTMLButtonElement>('#tab-register');
const loginForm = $<HTMLFormElement>('#login-form');
const registerForm = $<HTMLFormElement>('#register-form');
const recoverForm = $<HTMLFormElement>('#recover-form');
const recoveryBox = $<HTMLElement>('#recovery');
const heading = $<HTMLHeadingElement>('h1');

type Mode = 'login' | 'register' | 'recover';

function showMode(mode: Mode): void {
  auth.hidden = false;
  app.hidden = true;
  recoveryBox.hidden = true;
  loginForm.hidden = mode !== 'login';
  registerForm.hidden = mode !== 'register';
  recoverForm.hidden = mode !== 'recover';
  tabLogin.setAttribute('aria-selected', String(mode === 'login'));
  tabRegister.setAttribute('aria-selected', String(mode === 'register'));
  heading.textContent = { login: 'Вход', register: 'Регистрация', recover: 'Новый пароль' }[mode];
  const form = { login: loginForm, register: registerForm, recover: recoverForm }[mode];
  form.querySelector('input')?.focus();
}

function showApp(): void {
  heading.textContent = 'Мои ученики';
  auth.hidden = true;
  recoveryBox.hidden = true;
  app.hidden = false;
  account.hidden = !hasServer;
  $('#account-login').textContent = currentLogin() ?? '';
  render();
}

/** Ошибка под формой; пустая строка её прячет. */
function formError(form: HTMLFormElement, text: string): void {
  const p = form.querySelector<HTMLParagraphElement>('.error')!;
  p.textContent = text;
  p.hidden = !text;
}

/** Пока ждём сервер, кнопка неактивна и говорит, что происходит. */
async function busy<T>(form: HTMLFormElement, work: () => Promise<T>): Promise<T> {
  const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const text = button.textContent;
  button.disabled = true;
  button.textContent = 'Подождите…';
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.textContent = text;
  }
}

const value = (selector: string) => $<HTMLInputElement>(selector).value;
const LOGIN_RULE = /^[a-z0-9._]{3,30}$/i;

tabLogin.addEventListener('click', () => showMode('login'));
tabRegister.addEventListener('click', () => showMode('register'));
$('#to-recover').addEventListener('click', () => showMode('recover'));
$('#back-to-login').addEventListener('click', () => showMode('login'));

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError(loginForm, '');
  if (!value('#login-name').trim() || !value('#login-pass')) return formError(loginForm, 'Введите логин и пароль.');
  const result = await busy(loginForm, () => login(value('#login-name'), value('#login-pass')));
  if (result.error) return formError(loginForm, result.error);
  showApp();
});

// Свободен ли логин - подсказываем, пока его набирают.
const nameHint = $<HTMLParagraphElement>('#reg-name-hint');
const NAME_RULE_TEXT = nameHint.textContent ?? '';
let nameCheck: ReturnType<typeof setTimeout> | undefined;
$<HTMLInputElement>('#reg-name').addEventListener('input', () => {
  clearTimeout(nameCheck);
  const name = value('#reg-name').trim();
  nameHint.dataset.state = '';
  nameHint.textContent = NAME_RULE_TEXT;
  if (!LOGIN_RULE.test(name)) return;
  nameCheck = setTimeout(async () => {
    const free = await loginFree(name);
    if (free === null || value('#reg-name').trim() !== name) return;
    nameHint.dataset.state = free ? 'ok' : 'bad';
    nameHint.textContent = free ? 'Логин свободен.' : 'Такой логин уже занят.';
  }, 400);
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError(registerForm, '');
  const name = value('#reg-name').trim();
  if (!LOGIN_RULE.test(name)) return formError(registerForm, 'В логине - латинские буквы, цифры, точка и подчёркивание, от 3 до 30 знаков.');
  if (value('#reg-pass').length < 8) return formError(registerForm, 'Пароль - от 8 знаков.');
  if (value('#reg-pass') !== value('#reg-pass2')) return formError(registerForm, 'Пароли не совпадают.');
  const result = await busy(registerForm, () => register(name, value('#reg-pass'), value('#reg-site')));
  if (result.error) return formError(registerForm, result.error);
  showRecovery(result.recovery ?? '');
});

recoverForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError(recoverForm, '');
  if (!value('#rec-name').trim() || !value('#rec-key').trim()) return formError(recoverForm, 'Введите логин и ключ восстановления.');
  if (value('#rec-pass').length < 8) return formError(recoverForm, 'Новый пароль - от 8 знаков.');
  const result = await busy(recoverForm, () => recover(value('#rec-name'), value('#rec-key'), value('#rec-pass')));
  if (result.error) return formError(recoverForm, result.error);
  // Старый ключ восстановления сгорел: показываем новый.
  showRecovery(result.recovery ?? '');
});

/* ---------- ключ восстановления ---------- */

const recoveryKey = $<HTMLParagraphElement>('#recovery-key');
const recoveryNotice = $<HTMLParagraphElement>('#recovery-notice');
const recoverySaved = $<HTMLInputElement>('#recovery-saved');
const recoveryDone = $<HTMLButtonElement>('#recovery-done');

function showRecovery(key: string): void {
  heading.textContent = 'Готово';
  auth.hidden = true;
  app.hidden = true;
  recoveryBox.hidden = false;
  recoveryKey.textContent = key;
  recoveryNotice.textContent = '';
  recoverySaved.checked = false;
  recoveryDone.disabled = true;
}

$('#copy-recovery').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(recoveryKey.textContent ?? '');
    recoveryNotice.textContent = 'Скопировано. Сохраните ключ туда, где не потеряете: в заметки или менеджер паролей.';
  } catch {
    recoveryNotice.textContent = 'Не получилось скопировать: выделите ключ и скопируйте сами.';
  }
});

$('#save-recovery').addEventListener('click', () => {
  const text = `Tiza\nЛогин: ${currentLogin()}\nКлюч восстановления: ${recoveryKey.textContent}\n\nС этим ключом можно задать новый пароль, если забудете старый.\n`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  link.download = `tiza-${currentLogin()}-ключ.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
  recoveryNotice.textContent = 'Файл скачан. Храните его там, где не потеряете.';
});

recoverySaved.addEventListener('change', () => (recoveryDone.disabled = !recoverySaved.checked));
recoveryDone.addEventListener('click', showApp);

/* ---------- учётная запись: пароль и выход ---------- */

const passwordForm = $<HTMLFormElement>('#password-form');
const showPassword = $<HTMLButtonElement>('#show-password');
const passwordDone = $<HTMLParagraphElement>('#password-done');

showPassword.addEventListener('click', () => {
  passwordForm.hidden = !passwordForm.hidden;
  showPassword.setAttribute('aria-expanded', String(!passwordForm.hidden));
  passwordDone.hidden = true;
  if (!passwordForm.hidden) $<HTMLInputElement>('#old-pass').focus();
});

passwordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError(passwordForm, '');
  if (value('#new-pass').length < 8) return formError(passwordForm, 'Новый пароль - от 8 знаков.');
  const result = await busy(passwordForm, () => changePassword(value('#old-pass'), value('#new-pass')));
  if (result.error) return formError(passwordForm, result.error);
  passwordForm.reset();
  passwordForm.hidden = true;
  showPassword.setAttribute('aria-expanded', 'false');
  passwordDone.hidden = false;
  passwordDone.textContent = 'Пароль изменён. На других устройствах нужно будет войти заново.';
});

$('#logout').addEventListener('click', () => {
  if (!confirm('Выйти? Ученики останутся в учётной записи, в этом браузере их не будет до следующего входа.')) return;
  logout();
  location.replace('./');
});

/* ---------- с чего начать ---------- */

const params = new URLSearchParams(location.search);
if (params.has('out')) history.replaceState(null, '', location.pathname);

if (!hasServer) {
  // Сайт без сервера (у себя на компьютере без npm run server): входить некуда, всё живёт в браузере.
  showApp();
} else if (currentLogin()) {
  showApp();
  // Список мог поменяться в другом браузере: сверяемся с сервером и рисуем заново.
  void pull().then((changed) => changed && render());
} else {
  // В этом браузере уже есть ученики без учётной записи (до входа по логину): зарегистрироваться
  // и забрать их с собой, а не войти в пустую учётную запись.
  const waiting = loadStudents().length;
  if (waiting) {
    const carry = $<HTMLParagraphElement>('#reg-carry');
    carry.hidden = false;
    carry.textContent = `Ученики из этого браузера (${waiting}) перейдут в новую учётную запись.`;
  }
  if (params.has('out')) {
    authNote.hidden = false;
    authNote.textContent = 'Пароль сменили на другом устройстве. Войдите с новым паролем.';
  } else if (waiting) {
    authNote.hidden = false;
    authNote.textContent = 'Теперь у Tiza есть учётные записи. Зарегистрируйтесь, и ваши ученики из этого браузера будут доступны на любом устройстве.';
  }
  showMode(waiting ? 'register' : 'login');
}

// Сервер засыпает без посетителей: будим его, пока вводят пароль или выбирают ученика.
wakeServer();
