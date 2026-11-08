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
