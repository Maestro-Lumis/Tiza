import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Несколько страниц: список учеников, ученик с дорожной картой и доска. Vite соберёт каждую.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'index.html'),
        student: resolve(import.meta.dirname, 'student.html'),
        board: resolve(import.meta.dirname, 'board.html'),
      },
    },
  },
});
