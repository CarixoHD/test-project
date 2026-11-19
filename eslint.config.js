// @ts-check
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Module boundaries (docs/ARCHITECTURE.md §3, CODING_STANDARDS.md §4).
// Matches relative imports that climb out into src/server or src/web, and any `src/server|web` path.
const SERVER_IMPORT = '^(\\.\\./)+(src/)?server(/|$)|(^|/)src/server(/|$)';
const WEB_IMPORT = '^(\\.\\./)+(src/)?web(/|$)|(^|/)src/web(/|$)';

// ADR 3: the AI SDK (`ai`, `ai/*`, `@ai-sdk/*`) stays behind src/server/llm and the API agent backend.
const AI_SDK_IMPORT = {
  regex: '^(ai|@ai-sdk/[^/]+)(/|$)',
  message: 'Only src/server/llm and src/server/agents/api-backend.ts may import the AI SDK.',
};
const AI_SDK_ALLOWED = ['src/server/llm/**', 'src/server/agents/api-backend.ts'];

const SHARED_BOUNDARY = {
  paths: builtinModules
    .filter((name) => !name.startsWith('_'))
    .map((name) => ({ name, message: 'src/shared must stay pure: no Node built-ins.' })),
  patterns: [
    { regex: '^node:', message: 'src/shared must stay pure: no node:* imports.' },
    { regex: SERVER_IMPORT, message: 'src/shared must not import src/server.' },
    { regex: WEB_IMPORT, message: 'src/shared must not import src/web.' },
    AI_SDK_IMPORT,
  ],
};

const WEB_BOUNDARY = {
  patterns: [
    {
      regex: SERVER_IMPORT,
      message: 'src/web must not import src/server; use src/web/state/api.ts and src/shared DTOs.',
    },
    AI_SDK_IMPORT,
  ],
};

export default defineConfig(
  {
    ignores: [
      'dist/',
      'coverage/',
      '.data/',
      'data/',
      'test-results/',
      'playwright-report/',
      'node_modules/',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/server/**', 'scripts/**', 'tests/**', '*.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/server/**', 'scripts/**', 'tests/**'],
    ignores: AI_SDK_ALLOWED,
    rules: { 'no-restricted-imports': ['error', { patterns: [AI_SDK_IMPORT] }] },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest'], jsxA11y.flatConfigs.recommended],
    languageOptions: { globals: globals.browser },
    rules: { 'no-restricted-imports': ['error', WEB_BOUNDARY] },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', SHARED_BOUNDARY],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'src/shared must not do I/O.' },
        { name: 'process', message: 'src/shared must not read the environment.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Pass time in via the injected Clock.' },
        { object: 'Math', property: 'random', message: 'Pass ids in via the injected IdGen.' },
      ],
    },
  },
  prettier,
);
