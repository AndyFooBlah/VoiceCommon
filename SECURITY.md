# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in VoiceCommon, please report it responsibly.

**Please do not open a public GitHub issue for security vulnerabilities.**

Preferred: use GitHub's private vulnerability reporting — the **"Report a vulnerability"** button under this repository's **Security** tab. It opens a private channel visible only to the maintainer.

Alternatively, email **andrew.brook@fooblah.org**.

Include as much detail as you can:
- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested mitigations

We will acknowledge your report within 48 hours and aim to release a fix within 14 days for critical issues.

## Scope

This policy covers:

- The `@andyfooblah/voice-common` npm package (the library published from `src/`)
- The demo application shipped in this repository (the example app, its Cloud Functions in `functions/`, and the Firestore/Storage rules)

## API Key Handling

VoiceCommon never accepts a long-lived Gemini API key in browser configuration. The only sanctioned auth path is the **required** `tokenProvider` callback passed to `initializeVoiceCommon(...)`: a consumer-implemented wrapper around a server-side broker that holds `GEMINI_API_KEY` (e.g. in Secret Manager) and returns a single-use ephemeral token (via Gemini's `authTokens.create` API). The long-lived key never reaches the browser — in this library or in any consumer's bundle.

Two automated guards enforce this:

1. An ESLint `no-restricted-syntax` rule that fails the build on any read of secret-shaped `import.meta.env.VITE_*` variables inside `src/**`
2. A post-build bundle scan (`scripts/check-bundle-for-secrets.mjs`) that greps the published `dist/` output for known secret shapes and fails on any match

The package also ships a Node-only test kit at `@andyfooblah/voice-common/testing`. It runs in a test process, never in a browser, and is the one place a long-lived key is used: it takes the key as a runtime argument from the caller's environment, never reads it from a file, never logs or stores it, and redacts it (and anything shaped like a Google API key or an ephemeral token) from every error, trace and report. The build fails if that entry imports anything other than `@google/genai` and Node built-ins. The live test workflow (`.github/workflows/live-contract.yml`) is disabled unless a repository secret is added, installs dependencies without lifecycle scripts before the key is in scope, and holds the key only in a job with read-only permissions.

If you find a way a secret can leak into the published package or a consumer's bundle, or out of the test kit, that is in scope — please report it.
