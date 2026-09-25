# Security Policy

Browser Control drives a real browser that may be signed in to real accounts, so we take security
reports seriously.

## Reporting a vulnerability

Please **do not** open a public issue. Report privately with GitHub's "Report a vulnerability"
button (Security → Advisories) on this repository.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge
reports within 3 business days and to agree a disclosure timeline with you.

## Scope

In scope: the extension (`src/`), the host daemon and shim (`host/`), and the installer scripts.
Examples: bypassing tenant/agent isolation, reading a vault value through any tool result or log,
defeating secret-field masking, the host accepting non-loopback or unauthenticated requests,
telemetry sending anything beyond its documented fields.

## Supported versions

Only the latest release receives fixes during the 0.x series.
