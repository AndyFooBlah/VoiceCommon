# voice-common (@andyfooblah/voice-common) — Project Journal

Append-only project journal (per the global policy in `~/.claude/CLAUDE.md`).

- Every entry starts with a UTC timestamp and a tag, newest at the bottom:
  `- 2026-10-17T04:42Z [decision] …`
- Tags: `[step]` `[decision]` `[friction]` `[learning]` `[surprise]` `[incident]` `[idea]` `[milestone]`.
- **Append-only.** Never edit or delete a past entry; to correct one, append a new entry naming the earlier one's timestamp.

> Established 2026-10-17 per the new journal policy. The "Reconstructed backfill"
> section was recreated from git history and session records; timestamps are the
> relevant commit times (UTC) and are approximate for anything predating
> establishment. The repo has 222 commits; only the significant recent arc is
> backfilled here.

React/TypeScript library wrapping the Gemini Live session lifecycle (audio
capture, streaming, transcript sync, archival recording) behind `useSession`.
Never holds a Gemini API key — the consumer supplies a `tokenProvider`.

---

## Reconstructed backfill (from git history + session records)

- 2026-07-02T05:43Z [learning] VAD hysteresis (0.9.1): only sustained speech (≥ `VAD_RETRIGGER_MS`) resets the end-of-turn silence timer, so transient background-noise blips no longer restart the patient wait.
- 2026-07-02T21:48Z [incident] CRITICAL recording-integrity failure + fix (0.10.0): the auto-reconnect path had been flushing/restarting the archival recorder to the **same** GCS path, overwriting the opening minutes of the interview. Owner decision (quoted): "if the system isn't recording the raw audio then it needs to halt the interview." Fix: halt on disconnect / recorder failure instead of a lossy reconnect.
- 2026-07-02T22:35Z [milestone] Robust reconnection (0.11.0) via Gemini **session resumption** + one **continuous** local recording — survives the ~10-min connection / ~15-min audio Live caps without losing audio or conversation context.
- 2026-07-02T22:55Z [friction] First double-greeting fix (0.11.1, mid-turn text-fingerprint suppression) was rejected by the owner — it cut the second greeting off mid-word, "almost worse than two greetings". Reverted.
- 2026-07-02T23:06Z [decision] Real double-greeting fix (0.12.0): mute the mic to Gemini during the opening greeting so speaker→mic echo can't trip the server VAD into restarting the greeting. Archival recording is unaffected (separate audio graph). Confirmed working.
- 2026-07-02T23:53Z [milestone] Stream the user transcript into one growing bubble per turn (0.13.0, `appendUserChunk`/`sealUserTurn`). [learning] The native-audio model emits only one `inputTranscription` at end-of-turn, so this can't actually render word-by-word — a model limitation, not a client bug. Still true on `gemini-3.8-live` (re-measured 2026-09-18); the consuming app shows a "Listening…" placeholder instead.
- 2026-07-09T19:05Z [milestone] Pre-publication cleanup (0.14.0, #20): dead demo removal, docs, dep hygiene, log gating.
- 2026-07-10T17:08Z [milestone] Published to npmjs.org; knowledge-common consumed as a versioned dep (#21).
- 2026-09-11T05:09Z [step] Housekeeping 0.14.1: verbatim Apache-2.0 LICENSE, gitignore `.env`, drop prototype, OIDC trusted publishing.
- 2026-09-18T23:19Z [decision] 0.15.0: make the Gemini **Live model and thinking level injectable** so consumers can select e.g. `gemini-3.8-live` and the matching `thinkingConfig` without a library change — important because the Live models disagree about `thinkingConfig` and a bare model-id swap otherwise closes the socket with `1007`.

---

## Live journal

- 2026-10-17T04:42Z [milestone] Journal established per the new global policy; backfilled above from git history + session records.

## 2026-10-16: correction to this journal's own timestamps

- 2026-10-16T22:05Z [incident] **Every `~`-marked timestamp above, from the 2026-02-16 initial commit
  through the ~2026-09-10 0.14.1 entry, is seven hours early and is NOT UTC.** They were produced with
  `git log --date=format:'%Y-%m-%dT%H:%MZ'`, which renders each commit in its own local zone (here
  PDT, UTC-7) and then has a literal `Z` appended by the format string. The `Z` is a lie: the real
  UTC time is seven hours later. For example the 0.14.1 release entry reads `~2026-09-10T22:09Z` but
  the commit is actually `2026-09-11T05:09Z`. Add seven hours to any `~` entry above this line.
  The un-`~` September 2026 entries were written from session chronology, not from that command, and
  are correct as written.
- 2026-10-16T22:05Z [learning] Correct incantation for a UTC backfill:
  `TZ=UTC git log --date=format-local:'%Y-%m-%dT%H:%MZ'` — note `format-local`, not `format`. Or use
  `--date=iso-strict` and convert, which at least shows the offset instead of hiding it. Appending a
  literal `Z` to a local-time format string produces timestamps that look authoritative and are
  silently wrong, which is worse than an obviously missing timezone. Found by a session backfilling
  a sibling repo, which caught it by cross-checking two different checkouts.
- 2026-10-16T22:05Z [decision] Corrected by appending this entry rather than rewriting the entries
  above, per the append-only rule. The wrong timestamps stay visible, with the offset recorded here.
- 2026-11-08T17:29Z [step] Turned on Dependabot alerts and security updates, and added a standard `.github/dependabot.yml`: weekly grouped minor/patch updates with a 5-day cooldown (14 days for majors); security updates open immediately. Part of the cross-repo dependency security program (AndyFooBlah/andy-private-docs#57).
- 2026-11-08T18:56Z [step] Dependency program phase 2 (AndyFooBlah/andy-private-docs#57): CI now runs on all PRs and on `workflow_dispatch`, also builds the library (`build:lib`) and `/functions`, and ends with the shared deps-merge / deps-fix jobs (tier standard, no deploy). Added the deps-toolchain action and deps-fixer workflow. Green Dependabot PRs now merge themselves; red ones go to the Claude fixer.
- 2026-11-08T20:17Z [incident] The shared `deps / merge` job failed outright when DEPENDABOT_ALERTS_TOKEN was rejected (401), blocking green Dependabot merges. Fix: the alert lookup now runs only in high-tier repos, and a rejected token means "routine". A failed merge now asks Dependabot to rebase, and repos without a deploy workflow re-run CI on the base branch after a merge. Part of AndyFooBlah/andy-private-docs#57.
- 2026-11-08T20:42Z [friction] deps-fixer's Claude step refused to run: the CI job that hands a red PR to the fixer dispatches it as github-actions[bot], and claude-code-action rejects bot actors unless they are listed in allowed_bots. Added allowed_bots: github-actions. Part of AndyFooBlah/andy-private-docs#57.
- 2026-11-08T22:37Z [friction] First real deps-fixer run (VoiceCommon#45): Claude's fix passed CI, but the PR had fallen behind main and could not merge. deps-fixer now merges the base branch into the PR before Claude starts, so the fix is tested against current main and the PR picks up main's newer workflows. Claude resolves any conflicts. Part of AndyFooBlah/andy-private-docs#57.
- 2026-11-08T22:33Z [step] deps-fixer: npm ci failed (typescript-eslint peer range excludes TS 7) and build:lib failed (unplugin-dts needs the JS API); added package.json overrides for typescript-eslint's typescript peer and devDependency @typescript/typescript6 (PR #45).
- 2026-11-08T22:43Z [step] deps-fixer: PR was unmergeable due to a JOURNAL.md conflict with main; kept both sides' entries, and install, tsc, tests and build:lib all pass with the existing TypeScript 7 overrides (PR #45).
- 2026-11-08T22:53Z [friction] deps-fixer's daily sweep picked up green PRs that were waiting for owner review, because an old failed deps/merge check (the earlier bad-token 401) still showed in their checks. The sweep now skips PRs labelled needs-owner-review or deps-gave-up, and ignores failed deps/* jobs. Part of AndyFooBlah/andy-private-docs#57.
- 2026-11-09T14:14Z [step] deps-fixer: npm ci failed with ERESOLVE because @andyfooblah/knowledge-common peers firebase ^12 while the PR bumps firebase to 13.1.0; added a package.json override mapping its firebase peer to the root firebase and widened our own firebase peer range to ^12 || ^13; install, tsc, tests and build:lib pass (PR #60).
- 2026-11-09T23:10Z [step] deps-fixer: added npm overrides for @grpc/grpc-js ^1.14.7 and minimatch ^11.0.1 (root), and glob ^14.0.2, minimatch ^11.0.1, uuid ^11.1.1 (functions); lockfiles updated, install, tsc, tests and builds pass.
- 2026-11-16T01:09Z [step] deps-fixer.yml synced from the program template (andy-private-docs#57, audit Q-47). It fixes two faults that had failed the daily sweep in four other enrolled repos since 2026-11-09 and were latent here. (1) In a private repo the pick job's PR query (`gh pr list --json statusCheckRollup`) needs `checks: read` and `statuses: read` once an open PR has run CI; the pick job now has its own read-only token with those scopes. (2) A PR whose merge with main conflicts in package.json broke the toolchain setup before the attempt was counted, so it failed every day; the toolchain is now set up before the merge, and a fixer failure on one PR is labelled `deps-fixer-error`, counted as an attempt and no longer fails the run. The pick log now lists every open PR with its verdict and the alert counts.
- 2026-11-16T01:34Z [step] 0.16.0 (issue #64): the default Live model is now `gemini-3.8-live` and `thinkingLevel` defaults to `'auto'`. New pure modules `src/services/liveModels.ts` (registry, `DEFAULT_LIVE_MODEL`, `resolveThinkingConfig`) and `src/services/liveConnectConfig.ts` (`buildLiveConnectConfig`, extracted from `useSession`, which now calls it). `VoiceSimulator` (a stub that returned mock data) is removed; `@andyfooblah/voice-common/testing` is now a Node-only live conformance kit (`LiveTestSession`, six committed synthetic speech fixtures, 13 named checks plus 3 provider-contract canaries, `runLiveConformance`). Offline tests went from 148 to 297. `npm run test:live` runs 42 live tests; `.github/workflows/live-contract.yml` runs them weekly once a secret is added (off by default).
- 2026-11-16T01:34Z [decision] Owner's request, verbatim: "Please update all voice applications to using the latest live voice model. We'll need a good test suite for it." This repo is the library half; LegacyBot, CarBot and weatherbot-app adopt 0.16.0 next. The owner's standing policy that paid-API tests stay off in CI unless he decides otherwise is why the canary workflow skips without the `LIVE_TEST_GEMINI_API_KEY` secret and no secret was created.
- 2026-11-16T01:34Z [learning] Thinking contract re-measured against the live API today, all five requests per model. `gemini-3.8-live`: every level rejected (1007 "Thinking level is not supported for this model."). `gemini-3.8-live-extended-thinking`: required (omitted gives 1007 "Thinking level must be specified for this model."), MINIMAL rejected, LOW/MEDIUM/HIGH accepted. `gemini-3.1-flash-live-preview`: optional, omitted and all four levels accepted. That last row corrects the 0.15.0 changelog and the 2026-09-18 note, which said the 3.1 preview requires a level.
- 2026-11-16T01:34Z [surprise] On `gemini-3.8-live` function calls are asynchronous by default (call ids start `call_`, not `fc_`). The turn that issues a call ends at once: `generationComplete` and `turnComplete` arrive right after the `toolCall`, BEFORE the spoken reply to the tool result, which is a further turn. On the 3.1 preview there is one `turnComplete`, after the reply. My first tool check took the early `turnComplete` for the end of the reply and failed with a half-sentence transcript. `gemini-3.8-live-extended-thinking` speaks a filler sentence before the call and rejects a `behavior: BLOCKING` declaration at setup with 1007; a declaration with no `behavior` (like the injected `endSession`) is accepted. The hook's turn handling on 3.8-live has not been re-examined against this ordering; the apps have run on that model since September.
- 2026-11-16T01:34Z [surprise] `ai.live.connect()` in @google/genai 2.x resolves only after `setupComplete`. When the server rejects a setup it closes the socket and the promise never settles. In `useSession` that left the session in CONNECTING, and the close handler then tried to resume a session that never existed. This is the mechanism behind "a model swap just won't connect". Fixed: the hook races connect against a close-before-setup and fails the start with the close code and reason. `LiveTestSession.connect` does the same and throws `LiveSetupError`.
- 2026-11-16T01:34Z [decision] Kept the `v1alpha` pin for ephemeral tokens (September audit item E5) and added `UseSessionOptions.liveApiVersion` as the escape hatch. Evidence: a token minted on `v1alpha` or `v1beta` opens a session on either; all four combinations pass, on SDK 2.11.0 and 2.32.0. The provider guide now says "only with the v1beta version", but the SDK (2.11.0, 2.32.0 and 3.3.0) logs "ephemeral token support is in v1alpha only" for anything else, and the apps' brokers mint on v1alpha. Both work, so there is no reason to move yet; the live suite checks all four every run.
- 2026-11-16T01:34Z [learning] Server VAD does honour a large `silenceDurationMs` on clean audio on `gemini-3.8-live`: with 2500 ms and 3000 ms the bot stayed silent through a pause of 60% of that, treated both halves of the sentence as one turn, and answered 0.4 to 1.0 s after the silence elapsed. The JSDoc and design.md said the model "ignores" large values; reworded to say room noise is what defeats it. Latency, end of speech to first bot audio: about 1.1 s under default server VAD, 0.6 to 0.75 s after `activityEnd` in manual mode. Input transcription still arrives once, after the turn.
- 2026-11-16T01:34Z [friction] The Gemini API docs moved: `ai.google.dev/gemini-api/docs/*` now 301s to `aistudio.google.com/docs/*`, and every page is available as Markdown by appending `.md` (index at `/llms.txt`). Reading the Markdown directly beat summarised fetches, which paraphrase. The models page now also lists a Gemini 4 family (`gemini-4-carbon`, `-argon`, `-hydrogen`); none is a Live model. Deprecations table today: `gemini-3.1-flash-live-preview` released 2026-03-11, "No shutdown date announced", replacement `gemini-3.8-live`.
- 2026-11-16T01:34Z [friction] Fixture generation: the TTS guide documents `response_format.sample_rate` (16000 listed), but the Interactions API returned HTTP 400 for it, so `scripts/gen-speech-fixtures.mjs` takes the 24 kHz WAV and resamples to 16 kHz itself. A bare six-word list came back at 8 to 10 seconds (over the 200 KB limit), so the transcription fixture is a sentence of distinct words instead.
- 2026-11-16T01:34Z [friction] The local `node_modules` was two months stale (@google/genai 2.11.0, vite 6, TypeScript 5.8 against a lockfile at 2.32.0, vite 8, TypeScript 7), so the first live runs exercised the old SDK. After `npm ci` everything passed again on 2.32.0, which is what CI installs. `npm run lint` was already broken on main: typescript-eslint 8 refuses to load under TypeScript 7 and CI does not run lint. Added `scripts/eslint-ts6-shim.cjs` so lint runs against the TS 6 API the repo already installs (`@typescript/typescript6`); 0 errors.
- 2026-11-16T01:34Z [idea] The live suite is not wired into the publish workflow, so a release can ship without a live run. A manual gate ("paste the live results table into the release notes") or a required `workflow_dispatch` run of live-contract.yml before `gh release create` would close that. Also worth doing: run lint in CI now that it works, and widen the `@google/genai` peer range to `^2 || ^3` after a live run on 3.x.
