// Flat ESLint config. The point here is correctness, not layout: formatting
// rules are deliberately absent (they were deprecated in ESLint core), so this
// only complains about things that can actually bite.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': ['error', 'properties'],
      'no-throw-literal': 'error',
      'no-promise-executor-return': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'require-atomic-updates': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // This server speaks JSON-RPC on stdout: one stray console.log corrupts
      // the protocol stream and the client sees a parse error, not a message.
      'no-console': 'error',
      curly: ['error', 'multi-line'],
    },
  },
  {
    // Scripts and tests are ordinary programs: printing is their job, and the
    // mock's HTTP handler answers by returning res.end(...).
    files: ['scripts/**/*.mjs', 'test/**/*.mjs'],
    rules: { 'no-console': 'off', 'no-promise-executor-return': 'off' },
  },
];
