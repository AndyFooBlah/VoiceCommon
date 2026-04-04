# LegacyBot — Claude Code Instructions

## After any material change

Before considering a task complete, ensure all of the following are done:

1. **Tests** — verify tests exist for the changed behavior and all tests pass (`npm test -- --run`)
2. **Docs** — update `design.md` if architecture, models, data flow, or known issues changed
3. **Commit** — commit all changed files with a descriptive message
4. **Push** — push to `origin/main`
5. **Issues** — close the relevant GitHub issue(s) with a comment referencing the commit

---

## Environment

- **npm/node**: managed via nvm — always source nvm before running npm commands:
  ```bash
  export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh"
  ```
- **Firebase project**: `legacybot-5afa0` (prod)
- **GitHub repo**: `AndyFooBlah/LegacyBot`
- **Deploy**: `firebase deploy --only functions` / `firebase deploy --only firestore:rules,storage`
- **Security email**: `security@andrewbrook.com`

---

## Key Architecture Decisions

### Firebase Auth Custom Claims (`familyIds`)
Storage security rules cannot query Firestore. Family membership is instead propagated into the Firebase Auth token as a custom claim (`familyIds: string[]`). The `onMemberWritten` Cloud Function (Firestore trigger on `families/{familyId}/members/{memberId}`) syncs this claim whenever membership changes. Clients must call `user.getIdToken(true)` after joining a family to pick up the new claim before accessing Cloud Storage.

### Gap Analysis → Story Queue sync
`saveGapAnalysis()` in `functions/src/analysis.ts` now writes generated questions directly into the `questions` subcollection (with `source: 'gapAnalysis'`) so they appear in the Story Queue UI. Stale Unasked gap questions are deleted before new ones are written. This means the Story Queue is the single source of truth for what to ask next.

### Nudge email / digest
`triggerDigestForDossier` runs gap analysis on-the-fly if no `gapAnalysis` doc exists and there are no Unasked questions. The email uses the `narrativeSummary` as an intro paragraph and lists Story Queue topics once (no duplication).

### License
Apache 2.0 (switched from MIT). All source files have the standard Apache 2.0 header:
```
// Copyright 2026 Andrew Brook
//
// Licensed under the Apache License, Version 2.0 (the "License");
// ...
```

### ESLint
Flat config (`eslint.config.js`). Run with:
```bash
npx eslint src --ext .ts,.tsx
```
Notable rule choices: `no-console: 'off'` (used for logging throughout), `react-hooks/set-state-in-effect: 'off'` (intentional pattern), `@typescript-eslint/no-explicit-any: 'off'` in test/mock files.

---

## Open Issues

### #87 — Pre-launch security hardening (OPEN — partially complete)
**Completed so far:**
- Storage rules tightened: family membership enforced via `familyIds` custom claim
- `onMemberWritten` Cloud Function added to sync claims
- Existing users (Andy, Ralph) backfilled with a one-off script
- `firestore.indexes.json` updated with 3 missing composite indexes

**Remaining manual steps (cannot be done in code):**
- [ ] Restrict Firebase API key to production domain in GCP Console → APIs & Services → Credentials
- [ ] Set GCP billing alerts ($10 / $50 / $100) in GCP Console → Billing → Budgets & Alerts
- [ ] Set `maxInstances` on expensive Cloud Functions (`onSessionCompleted`, `sendDailyDigest`)
- [ ] Audit full Firestore security rules (storyteller scope, `questions` subcollection write rules, `invitations` read scope)
- [ ] Disable unused Firebase Auth sign-in providers; enable email enumeration protection
- [ ] Run Firebase Rules Playground tests for each role (admin, storyteller, unauthenticated)

### #86 — Document and simplify SMTP/email sender setup (OPEN)
Created to track the friction of setting up Gmail app passwords. No work started. Low priority.

### #90 — Memoir generation (OPEN — not started)
Goal: produce a readable life-story document from interview transcripts. Proposed output: Markdown file written to Cloud Storage (or Google Doc via Drive API). No implementation started.

---

## Completed Issues (recent)

| # | Title |
|---|-------|
| #89 | Tune interviewer AI — briefer, less empathy-heavy (`empathetic` persona rewritten, EXAMPLES added, opening shortened) |
| #88 | Make GitHub repo public — LICENSE (Apache 2.0), SECURITY.md, README.md updated; **manual step**: GitHub → Settings → Change visibility → Make public |
| #85 | Upgrade all Gemini models to 3.1 |
| #84 | Manual digest trigger (admin button) |
| #83 | Timezone-aware digest (7am local) |
| #82 | Nightly storyteller digest email |
| #81 | Server-side gap analysis after each session |

---

## Suggested Next Session Order

1. **#87 security hardening** — do the Firestore rules audit (code work) and then remind user of the remaining manual GCP/Firebase Console steps
2. **#90 memoir generation** — start design: read `memoirGeneration.ts` and `memoirExport.ts` to understand existing scaffolding, then implement
3. **#86 SMTP docs** — low effort, good for open-source friendliness
