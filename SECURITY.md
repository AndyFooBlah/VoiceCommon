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

If you find a way a secret can leak into the published package or a consumer's bundle, that is in scope — please report it.
