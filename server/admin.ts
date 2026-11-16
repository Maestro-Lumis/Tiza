/**
 * Команды администратора. Запускаются у себя на компьютере.
 * npm run admin работает с базой из .env (без Turso - с локальной data/tiza.db),
 * npm run admin:turso - с настоящей базой: адрес и токен Turso лежат в .env.turso (в git не попадает).
 *
 *   npm run admin:turso -- recovery <логин>       новый ключ восстановления, если учитель потерял и пароль, и ключ
 *   npm run admin:turso -- list                   все логины
 *   npm run admin:turso -- orphans                списки учеников без учётной записи (браузер забыл свой ключ)
 *   npm run admin:turso -- adopt <логин> <номер>  перенести такой список в учётную запись
 *
 * Новый ключ восстановления передайте учителю лично: с ним он сам задаст новый пароль на сайте.
 */
import { newRecovery, normalizeLogin, recoveryHash, workspaceId } from './auth.ts';
import { deleteWorkspace, listLogins, listWorkspaces, loadAccount, loadWorkspace, saveWorkspace, storeName, updateAccount } from './store.ts';

type Stored = { students: { id: string; name: string }[]; at: number };

const [command, ...args] = process.argv.slice(2);

function parse(data: string | null): Stored {
  try {
    const s = JSON.parse(data ?? '') as Stored;
    return Array.isArray(s.students) ? s : { students: [], at: 0 };
  } catch {
    return { students: [], at: 0 };
  }
}

/** Списки, к которым не привязана ни одна учётная запись. Номер - начало id, его хватает, чтобы указать список. */
async function orphans() {
  const owned = new Set<string>();
  for (const login of await listLogins()) {
    const a = await loadAccount(login);
    if (a) owned.add(workspaceId(a.workspaceKey));
  }
  return (await listWorkspaces()).filter((w) => !owned.has(w.id));
}

function fail(text: string): never {
  console.error(text);
  process.exit(1);
}

if (command === 'recovery' && args[0]) {
  const a = await loadAccount(normalizeLogin(args[0]));
  if (!a) fail(`Логина «${args[0]}» нет (база: ${storeName}).`);
  const recovery = newRecovery();
  a.recoveryHash = recoveryHash(recovery);
  await updateAccount(a);
  console.log(`Новый ключ восстановления для «${a.login}»: ${recovery}`);
  console.log('Старый ключ больше не работает. Пароль не менялся: учитель задаст новый сам, по этому ключу.');
} else if (command === 'list') {
  const logins = await listLogins();
  console.log(logins.length ? logins.join('\n') : `Учётных записей пока нет (база: ${storeName}).`);
} else if (command === 'orphans') {
  const list = await orphans();
  if (!list.length) console.log(`Все списки учеников привязаны к учётным записям (база: ${storeName}).`);
  for (const w of list) {
    const names = parse(w.data).students.map((s) => s.name);
    console.log(`${w.id.slice(0, 8)}  ${new Date(w.updatedAt).toLocaleString('ru')}  учеников: ${names.length}  ${names.join(', ')}`);
  }
} else if (command === 'adopt' && args[0] && args[1]) {
  const a = await loadAccount(normalizeLogin(args[0]));
  if (!a) fail(`Логина «${args[0]}» нет (база: ${storeName}).`);
  const found = (await orphans()).filter((w) => w.id.startsWith(args[1]));
  if (found.length !== 1) fail(found.length ? 'Под этот номер подходит несколько списков: укажите номер длиннее.' : `Списка без учётной записи с номером «${args[1]}» нет. Номера показывает команда orphans.`);
  const from = parse(found[0].data);
  const id = workspaceId(a.workspaceKey);
  const to = parse(await loadWorkspace(id));
  // Ученики, которые уже есть в учётной записи, остаются; перенесённые добавляются следом.
  const have = new Set(to.students.map((s) => s.id));
  const added = from.students.filter((s) => !have.has(s.id));
  // Время - сейчас: браузер учителя увидит, что на сервере список новее, и заберёт его.
  await saveWorkspace(id, JSON.stringify({ students: [...to.students, ...added], at: Date.now() }));
  await deleteWorkspace(found[0].id);
  console.log(`В «${a.login}» перенесено учеников: ${added.length} (${added.map((s) => s.name).join(', ')}).`);
  console.log('Учитель увидит их, когда откроет или обновит страницу «Мои ученики». Доски и темы на месте.');
} else {
  console.log(
    'Команды: recovery <логин> - новый ключ восстановления; list - все логины;\n' +
      'orphans - списки учеников без учётной записи; adopt <логин> <номер> - перенести такой список в учётную запись.',
  );
}
