// Copyright 2026 Andrew Brook
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

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
      // Hard rule: a library must never read sensitive VITE_*-prefixed env
      // vars in production code. Anything VITE_* gets baked into the
      // consumer's bundle, so reading one here would force every consumer
      // to ship that key. All Gemini access is via the consumer-supplied
      // tokenProvider; the demo entry point (src/index.tsx) is exempted
      // below since it's not part of the published library bundle.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.object.type='MetaProperty'][object.property.name='env'][property.name=/^VITE_(GEMINI|GOOGLE_MAPS)/]",
          message:
            'A library must not read VITE_GEMINI_* / VITE_GOOGLE_MAPS_*. Consumers pass a tokenProvider; the library never holds a long-lived key.',
        },
        {
          selector:
            "MemberExpression[object.object.type='MetaProperty'][object.property.name='env'][property.name=/_(SECRET|TOKEN)$/]",
          message:
            'A library must not read VITE_*_SECRET / VITE_*_TOKEN. All credentials are consumer-supplied at runtime via initializeVoiceCommon(...).',
        },
      ],
    },
  },
  {
    // Demo entry point — not part of the published library; allowed to read
    // VITE_FIREBASE_* for local dev. The library-wide rule above still
    // explicitly blocks GEMINI/MAPS/SECRET/TOKEN.
    files: ['src/index.tsx'],
    rules: { 'no-restricted-syntax': 'off' },
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
