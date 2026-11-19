import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/shared/**/*.test.ts', 'src/server/**/*.test.ts', 'scripts/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['src/web/**/*.test.{ts,tsx}'],
          setupFiles: ['src/web/test-setup.ts'],
        },
      },
      {
        test: {
          name: 'docker',
          environment: 'node',
          include: ['tests/docker/**/*.test.ts'],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
