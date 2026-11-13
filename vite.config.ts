import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/** Порт сервера доски у себя на компьютере: на него сайт идёт с localhost. */
const SERVER_PORT = 8787;

/** Занят ли порт: уже запущен сервер в другом терминале. */
function portBusy(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

/**
 * npm run dev поднимает и сервер доски: без него на localhost не войти в учётную запись.
 * Если сервер уже запущен отдельно (npm run server) или сайт смотрит на чужой сервер
 * (VITE_SERVERS, VITE_SERVER_URL в .env), второй не запускаем.
 */
function boardServer(): Plugin {
  let child: ChildProcess | null = null;
  return {
    name: 'tiza-board-server',
    apply: 'serve',
    async configureServer(vite) {
      const env = loadEnv(vite.config.mode, process.cwd(), 'VITE_');
      if (env.VITE_SERVERS || env.VITE_SERVER_URL) return;
      if (await portBusy(SERVER_PORT)) {
        vite.config.logger.info(`  Сервер доски уже запущен на порту ${SERVER_PORT}.`);
        return;
      }
      child = spawn(process.execPath, ['--env-file-if-exists=.env', '--watch', 'server/index.ts'], {
        stdio: 'inherit',
        env: { ...process.env, PORT: String(SERVER_PORT) },
      });
      const stop = () => child?.kill();
      vite.httpServer?.once('close', stop);
      process.once('exit', stop);
    },
  };
}

// Несколько страниц: список учеников, ученик с дорожной картой, доска и карта для ученика. Vite соберёт каждую.
export default defineConfig({
  // Относительные пути: сайт работает и на localhost, и на GitHub Pages по адресу /Tiza/.
  base: './',
  plugins: [boardServer()],
  build: {
    // Доска сначала дожидается сохранённых данных (await в начале модуля), это нужно современным браузерам.
    target: 'es2022',
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'index.html'),
        student: resolve(import.meta.dirname, 'student.html'),
        board: resolve(import.meta.dirname, 'board.html'),
        roadmap: resolve(import.meta.dirname, 'roadmap.html'),
      },
    },
  },
});
