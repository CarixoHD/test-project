import react from '@vitejs/plugin-react';
import { defineConfig, type TestProjectInlineConfiguration } from 'vitest/config';

// The docker project needs a real Docker daemon and is opt-in (ADR 2): it is only
// registered when selected explicitly (`npm run test:docker` = `vitest run --project docker`,
// or a path under tests/docker), so a plain `npx vitest run` runs the unit and web projects.
const argv = process.argv.slice(2);
const dockerSelected = argv.some(
  (arg, i) =>
    arg === '--project=docker' ||
    (arg === '--project' && argv[i + 1] === 'docker') ||
    arg.replaceAll('\\', '/').includes('tests/docker'),
);

const dockerProject: TestProjectInlineConfiguration = {
  test: {
    name: 'docker',
    environment: 'node',
    include: ['tests/docker/**/*.test.ts'],
    testTimeout: 120_000,
  },
};

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
      ...(dockerSelected ? [dockerProject] : []),
    ],
  },
});
