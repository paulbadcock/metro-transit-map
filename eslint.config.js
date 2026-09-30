import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Empty catch blocks are used deliberately for best-effort periodic
      // refreshes where a transient failure shouldn't interrupt anything.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        L: 'readonly',
        NextBuses: 'writable',
      },
    },
  },
  {
    // UMD wrapper: also runs under Node's CommonJS loader (see public/package.json).
    files: ['public/next-buses.js'],
    languageOptions: {
      globals: {
        ...globals.commonjs,
      },
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    ignores: ['node_modules/', 'data/'],
  },
];
