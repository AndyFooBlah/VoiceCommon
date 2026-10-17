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
