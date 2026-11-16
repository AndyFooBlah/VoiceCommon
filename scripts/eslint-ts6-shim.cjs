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

/**
 * Lets ESLint run while the repo compiles with TypeScript 7.
 *
 * typescript-eslint 8 does not support the TS 7 API and refuses to load when
 * `require('typescript')` resolves to 7.x. TypeScript's documented answer is
 * to run such tools against the TS 6 API side by side; the repo already
 * installs it as `@typescript/typescript6`. This preload redirects
 * `require('typescript')` to that package for the ESLint process only.
 * `tsc`, the build and the tests are unaffected and keep using TS 7.
 *
 * Used by `npm run lint`. Remove it once typescript-eslint supports TS 7.
 */

const Module = require('node:module');

const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return original.call(this, request === 'typescript' ? '@typescript/typescript6' : request, ...rest);
};
