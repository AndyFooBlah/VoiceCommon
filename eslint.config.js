import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: './tsconfig.json' },
      globals: { ...globals.browser },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // any is used deliberately in many places — warn only so CI doesn't fail on it
      '@typescript-eslint/no-explicit-any': 'warn',
      // console is used throughout for logging — acceptable in this codebase
      'no-console': 'off',
      // Flag genuinely unused vars but allow _-prefixed intentional ignores
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // React hooks exhaustive deps - real correctness issue
      'react-hooks/exhaustive-deps': 'warn',
      // Setting state synchronously at the top of a useEffect is a common and
      // intentional pattern in this codebase (e.g. setLoading(true) before a fetch).
      'react-hooks/set-state-in-effect': 'off',
      // Disallow the generic Function type (use explicit signatures instead)
      '@typescript-eslint/no-unsafe-function-type': 'error',
    },
  },
  {
    // Relax rules in test and mock files
    files: ['src/__tests__/**/*.{ts,tsx}', 'src/__mocks__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'error',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'functions/'],
  },
];
