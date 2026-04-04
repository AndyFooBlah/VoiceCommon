# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in LegacyBot, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email: **andrew.brook@fooblah.org**

Include as much detail as you can:
- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested mitigations

We will acknowledge your report within 48 hours and aim to release a fix within 14 days for critical issues.

## Scope

This policy covers the LegacyBot web application and its Firebase Cloud Functions backend.

## Known Limitations

- Family creation is open to any authenticated user. Abuse prevention is planned but not yet implemented.
- Cloud Storage access is gated on Firebase Auth custom claims (`familyIds`). Claims are set by the `onMemberWritten` Cloud Function and may have a brief propagation delay after joining a family.
