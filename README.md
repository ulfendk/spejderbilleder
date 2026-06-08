# Spejderbilleder

Privacy-first photo/video sharing for scouting groups.

## What is implemented

- Static React app suitable for GitHub Pages hosting.
- Browser-side encryption for media metadata and chunks (`AES-GCM`).
- Per-upload file key wrapped by a passphrase-derived group key (`PBKDF2 + AES-KW`).
- Signed manifests (`ECDSA P-256`) so clients can verify uploader authenticity.
- Login-style passphrase gate before accessing gallery/upload workflows.
- Parent gallery view with:
  - image preview decryption (on-demand),
  - date sorting (newest/oldest),
  - fixed tag toggles (`Bævere`, `Ulve`, `Stifindere`, `Spejdere`, `Pionerer`, `Rovere`, `Ledere`, `Forældre`),
  - per-item details panel for technical metadata/signature status,
  - local IndexedDB gallery index for faster browsing of large record sets.
- Leader upload workflow with:
  - bulk upload (`multiple` file picker),
  - predefined tag toggles (same fixed tag set),
  - metadata extraction/fallback from selected files (capture timestamp/GPS when available).
- Pluggable storage backend selection:
  - `mock` (default): encrypted records in browser localStorage.
  - `s3-signer`: expects a private backend API to persist encrypted records.

## Why a companion backend is still needed

The frontend can be static, but private storage access still needs a trusted backend for authz and signed access policies.

## Local run

```bash
npm install
npm run dev
```

## GitHub Pages deployment

The repository now includes `.github/workflows/deploy-pages.yml` that:
- builds on pushes to `main` (and manual dispatch),
- sets `VITE_BASE_PATH` automatically for user/org pages vs project pages,
- uploads `dist/` as a Pages artifact,
- deploys with `actions/deploy-pages`.

In repository settings, set **Pages** source to **GitHub Actions**.

## Environment variables

Create `.env.local`:

```bash
VITE_STORAGE_BACKEND=mock
# Optional when VITE_STORAGE_BACKEND=s3-signer:
VITE_SIGNER_API_BASE=/api
# Optional branch reference shown as a UI footnote:
VITE_BRANCH_REF=main
```

Valid `VITE_STORAGE_BACKEND` values:
- `mock`
- `s3-signer`

## Security behavior

- No plaintext media metadata is stored in backend payloads.
- Object keys are random UUID based paths.
- Feed decryption requires the shared passphrase.
- Invalid signatures are surfaced in UI.
- Sorting/filtering fields are cached in a local client-side index (IndexedDB) after decryption for performance; clear this cache from the feed toolbar if needed.

See `AGENTS.md` for the backend contract and implementation guidance.
