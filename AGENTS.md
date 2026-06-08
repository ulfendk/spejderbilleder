# AGENTS.md

This document is a technical handoff for maintainers/agents working on `spejderbilleder`.

## Project goal

Build a scouting media platform where:
- privacy is first priority,
- leaders can publish quickly from phones,
- parents can follow activities through the week.

Current implementation is a secure MVP foundation.

## Current architecture

### Frontend
- Framework: React + TypeScript + Vite.
- Host target: static hosting (e.g., GitHub Pages).
- Main UI tabs:
  - **Parent feed**: decrypts metadata and verifies signature.
  - **Leader upload**: encrypts and signs media record before storage.

### Cryptography model
- Per-upload random **file key** (`AES-GCM`).
- File key wrapped with passphrase-derived **group key** (`PBKDF2 + AES-KW`).
- Metadata encrypted with file key.
- File split into chunks; each chunk encrypted with nonce derived from base nonce + chunk index.
- Manifest signed with uploader signing key (`ECDSA P-256`) and verified on read.

### Storage abstraction
`src/storage/` defines adapters:
- `mockStorage.ts`: browser localStorage demo backend (default).
- `signerStorage.ts`: expects secure private API (`GET/POST /media`).

Backend selected via `VITE_STORAGE_BACKEND`.

## Important security constraints

1. Do not store plaintext metadata in any backend payload.
2. Do not remove signature verification checks in feed.
3. Do not ship mock backend as production default.
4. Do not add silent fallback from `s3-signer` to `mock` in production.
5. Preserve key wrapping (`AES-KW`) and avoid IV-reuse patterns for wrapping.

## Required backend contract (production path)

For `s3-signer`, a private backend must enforce:
- invite/session auth,
- role authorization (leaders publish, parents read),
- object path scoping,
- short-lived upload/download permissions,
- request size/type limits,
- audit logging and membership revocation support.

Minimum API expected by current frontend:
- `POST /media` -> stores encrypted `StoredMediaRecord`
- `GET /media` -> returns `{ records: StoredMediaRecord[] }`

## Key files

- `src/App.tsx` — main UX and upload/feed workflows.
- `src/lib/crypto.ts` — crypto primitives and key wrapping.
- `src/lib/signing.ts` — canonical JSON signing/verification.
- `src/lib/media.ts` — encrypt/sign and decrypt/verify pipeline.
- `src/storage/*.ts` — backend abstractions/adapters.
- `README.md` — setup and operator-focused overview.

## Next high-priority tasks

1. Implement real invite/auth flow and session backend.
2. Implement server-side record persistence (not browser localStorage).
3. Add secure media retrieval/decryption UX (download and preview).
4. Add key rotation and membership epoch handling for revocation.
5. Add integration tests for signature and decryption failure paths.
