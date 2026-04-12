# VoiceCommon — Claude Code Instructions

## After any material change

Before considering a task complete, ensure all of the following are done:

1. **Tests** — verify tests exist for the changed behavior and all tests pass:
   ```bash
   npm test -- --run
   ```
2. **Docs** — update `design.md` if architecture, data model, or data flow changed
3. **Commit** — commit all changed files with a descriptive message
4. **Push** — push to `origin/main`

## Dev commands

```bash
npm test -- --run          # run all tests once
npm run test:watch         # watch mode
npx tsc --noEmit           # type-check only
npx eslint src --ext .ts,.tsx   # lint

firebase deploy --only functions
firebase deploy --only firestore:rules,storage
```

## Architecture notes

### Flat session data model
Sessions are stored at `sessions/{sessionId}` — a flat top-level collection keyed on the Firestore-generated session ID. Access control is by `userId` field. Transcripts are stored as a subcollection at `sessions/{sessionId}/transcript/entries`.

### Audio archival path
Session audio is stored in Cloud Storage at `sessions/{userId}/{sessionId}.webm`. Storage rules enforce that only the owning user can read or write.

### Tool integrations
Built-in tools live in `src/services/tools/`. Each module exports:
- A `FunctionDeclaration` compatible with the Gemini Live API
- An async implementation function

Register tools via `allTools` from `src/services/gemini.ts`, or compose a custom subset.

### ESLint config
Flat config (`eslint.config.js`). Notable intentional rule overrides:
- `no-console: 'off'` — used throughout for logging
- `react-hooks/set-state-in-effect: 'off'` — intentional pattern in this codebase
- `@typescript-eslint/no-explicit-any: 'off'` — scoped to test/mock files only

### License headers
All source files carry an Apache 2.0 header (Copyright 2026 Andrew Brook). Add the header to any new `.ts`, `.tsx`, or `.js` file:
```
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
```
