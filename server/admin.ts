/**
 * Команды администратора. Запускаются у себя на компьютере, база берётся из .env
 * (для настоящих учителей там должны быть адрес и токен Turso).
 *
 *   npm run admin -- recovery <логин>   новый ключ восстановления, если учитель потерял и пароль, и ключ
 *   npm run admin -- list               все логины
 *
 * Новый ключ передайте учителю лично: с ним он сам задаст новый пароль на сайте.
 */
import { newRecovery, normalizeLogin, recoveryHash } from './auth.ts';
import { listLogins, loadAccount, storeName, updateAccount } from './store.ts';

const [command, arg] = process.argv.slice(2);

if (command === 'recovery' && arg) {
  const a = await loadAccount(normalizeLogin(arg));
  if (!a) {
    console.error(`Логина «${arg}» нет (база: ${storeName}).`);
    process.exit(1);
  }
  const recovery = newRecovery();
  a.recoveryHash = recoveryHash(recovery);
  await updateAccount(a);
  console.log(`Новый ключ восстановления для «${a.login}»: ${recovery}`);
  console.log('Старый ключ больше не работает. Пароль не менялся: учитель задаст новый сам, по этому ключу.');
} else if (command === 'list') {
  const logins = await listLogins();
  console.log(logins.length ? logins.join('\n') : `Учётных записей пока нет (база: ${storeName}).`);
} else {
  console.log('Команды: recovery <логин> - новый ключ восстановления; list - все логины.');
}
