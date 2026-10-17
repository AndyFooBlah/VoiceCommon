# Project journal

An append-only record of how VoiceCommon was built: **decisions** (and who made them), **friction** hit,
what we **learned**, what **surprised** us, and ideas for later.

**Format:** every entry starts with a UTC timestamp and a tag:
`- 2026-10-16T17:52Z [decision] …`. Tags: `[step]`, `[decision]` (who decided, and why), `[friction]`,
`[learning]`, `[surprise]`, `[incident]`, `[idea]`, `[milestone]`.

**Append-only.** Never edit or delete a past entry. To correct one, append a new entry naming the earlier
one's timestamp. A copy is synced to the owner's private repo (`andy-private-docs/journals/`).

**Backfill note.** This journal was created on 2026-10-16, after the new project-journal rule in
`~/.claude/CLAUDE.md`. Entries before that date were reconstructed from commit history, the changelog, and
session records, so their timestamps are commit times and are marked `~`. The reconstruction is coarse for
February–August 2026 — one entry per turning point, not per commit — and detailed only where a session had
the work directly in hand. Earlier reasoning that was never written down is lost; that is the gap this rule
exists to stop repeating.

"Owner" is the project owner. "Session" is a Claude Code session working on the repo.

**Rule for every contributor (human or agent):** add an entry here in the same commit or PR as the change
that prompted it. That covers any decision, any workaround, anything that took more than one try, and any
result that differed from expectation.

---

## 2026-02 to 2026-04: extraction and hardening

- ~2026-02-16T21:58Z [milestone] Initial commit. VoiceCommon begins as the shared Gemini Live session engine
  extracted from LegacyBot, so more than one voice app can share one session pipeline.
- ~2026-02-19T08:13Z [step] Adaptive interviewing, prompt photos and events-as-entities land (#54, #62).
- ~2026-04-04T10:55Z [incident] Security pass before public release (#87, #88): storage rules fixed via custom
  claims, `onMemberWritten` added, questions-write restricted, function instances capped. A library that holds
  someone's family recordings has a different bar than a prototype.
- ~2026-04-12T21:52Z [incident] Auto-greet failed with a WebSocket `1007`. Fixed by disabling server VAD and
  driving `activityEnd` from a client VAD. First appearance of a pattern that recurs for the life of this
  project: **a Live API config mismatch presents as a connection fault, not a config error.**
- ~2026-04-27T01:53Z [decision] `initializeVoiceCommon` takes a `tokenProvider` rather than an API key, so no
  consumer ever puts a Gemini key in the browser.

## 2026-07: turn-taking, and a recording-integrity incident

- ~2026-07-01T21:00Z [friction] Could not tell "the wait never propagated" from "the model ignored it", so
  0.7.1 logs the resolved `silenceDurationMs` at connect. Observability first, then the fix.
- ~2026-07-01T21:53Z [decision] 0.9.0 adds `manualTurnControl`: client-side energy VAD driving
  `activityStart`/`activityEnd`, on the premise that the native-audio model ignores large `silenceDurationMs`.
  Built for BiographyBot, whose elderly storytellers pause mid-thought.
- ~2026-07-01T22:43Z [learning] 0.9.1: any single above-threshold frame was restarting the silence timer, so
  faint background noise made a 5s wait run past 10s. Fixed with hysteresis — only sustained speech
  (>=200ms) resets the timer. **Room noise, not the model, was defeating the wait.** This matters again in
  September.
- ~2026-07-02T14:48Z [incident] 0.10.0, the most serious bug in this project's history: auto-reconnect
  overwrote the opening audio of an interview. A lossy reconnect silently destroyed irreplaceable recordings.
  Changed to **halt** on disconnect or recorder failure rather than continue unrecorded. Raw audio is the one
  thing that cannot be regenerated.
- ~2026-07-02T15:35Z [decision] 0.11.0 restores robustness the right way: session resumption handles plus a
  continuous recording, so a session survives the Live API's connection resets without losing audio.
- ~2026-07-06T00:00Z [decision] Owner, on weatherbot: *"We don't want to use the manual VAD. It's not as
  natural sounding as the built in one."* Manual turn control stays opt-in, off by default. Two consumers now
  want opposite turn-taking, which is why it is a parameter and not a setting.

## 2026-09-10: housekeeping release

- ~2026-09-10T22:09Z [milestone] 0.14.1: verbatim Apache-2.0 LICENSE (GitHub had reported NOASSERTION),
  `.env` gitignored, the latency-comparator prototype removed (49 dependabot alerts, browser-side keys by
  design), and publishing moved to npm Trusted Publishing via OIDC — no NPM_TOKEN stored anywhere.

## 2026-09-18: 0.15.0, injectable model and thinking level

- 2026-09-18T22:05Z [step] Asked whether a newer Live model existed. `gemini-3.8-live` had gone stable three
  days earlier (2026-09-15) at pricing identical to `gemini-3.1-flash-live-preview`: $0.75/1M text in,
  $3.00/1M audio in, $4.50/1M text out, $12.00/1M audio out. Both share one pricing block in Google's docs.
- 2026-09-18T22:30Z [surprise] The three Live models **disagree about `thinkingConfig`**, measured directly
  against the API: `gemini-3.8-live` rejects the field outright (`1007 Thinking level is not supported for
  this model`); `gemini-3.8-live-extended-thinking` requires one but rejects `MINIMAL`;
  `gemini-3.1-flash-live-preview` required one. `useSession` sent `MINIMAL` unconditionally, so a bare
  model-id swap would have closed every session at setup. Same failure shape as the April `1007`.
- 2026-09-18T22:35Z [learning] Measured, contradicting this repo's own comment: `silenceDurationMs=10000`
  **was** honoured, by the 3.1 preview as well as 3.8-live. Neither barged into an 8s gap. But the test used
  digital silence and the July observation came from a real room, so the likely truth is that the server
  honours the value and **room noise defeats it** — consistent with the 0.9.1 hysteresis fix. The code comment
  claiming the model ignores large values is too strong; left in place rather than rewritten on one clean-audio
  test.
- 2026-09-18T22:40Z [decision] Session decided to add `liveModel` and `thinkingLevel` (`ThinkingLevel | 'none'`)
  as options with **defaults unchanged**, rather than swapping the hardcoded id. Consumers opt in individually,
  so one app can migrate without moving the others.
- 2026-09-18T23:20Z [incident] The release tag was pushed with a type error: `renderSession`'s overrides
  parameter re-listed option names by hand, so `liveModel` was rejected by tsc. The publish workflow caught it
  at the type-check step and **nothing reached npm**. Root cause was mine: I reported "tsc clean" from a run
  made *before* the final edit. Fixed by typing the helper as `Partial<UseSessionOptions>`, which removes the
  duplicated list entirely.
- 2026-09-18T23:21Z [learning] The gate only counts if it runs after the last edit. Re-ran tsc, tests, lint and
  build after the final change before re-tagging.
- 2026-09-18T23:21Z [milestone] 0.15.0 published to npm with signed provenance via OIDC. Registry took about a
  minute to serve it after the workflow reported success — the workflow log said "may take a few minutes to
  become available", so a `npm view` immediately after a green publish is not evidence of failure.
- 2026-09-19T18:40Z [friction] The changelog stopped at 0.14.1 while 0.15.0 was published and consumed by three
  apps, so anyone reading it to decide whether to upgrade could not see the new options existed. Entry added
  after the fact.

## 2026-10-16: journal created

- 2026-10-16T21:45Z [milestone] JOURNAL.md created under the new project-journal rule, backfilled as described
  above.
- 2026-10-16T21:45Z [friction] `andy-private-docs/journals/sync.sh` only scanned `$DEV/*/`, one level deep.
  Consumers nested a level down (notably `legacy/LegacyBot`) were invisible to the archive. Fixed in
  andy-private-docs `cbc4463` to scan two levels, preferring the most recently modified journal when a stale
  duplicate checkout shares a basename.
