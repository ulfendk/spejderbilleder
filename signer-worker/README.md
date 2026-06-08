# signer-worker

Companion backend example for static frontend deployments.

Purpose:
- authenticate sessions,
- authorize media list/upload operations,
- persist encrypted `StoredMediaRecord` objects.

The sample `src/index.ts` only provides contract shape and explicit auth gate behavior. Replace the storage TODOs with your chosen private backend service.

For production:
- remove `ALLOW_ANON_DEMO`,
- enforce role checks,
- add audit logging,
- add request schema validation and size limits.
