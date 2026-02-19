# Security and privacy

## High-level security model

Demeter Speech is a front-end application.

Key points:

- authentication is a client-side gate,
- no built-in server-side IAM in this repository,
- runtime hardening through browser headers and container controls,
- security monitoring through GitHub workflows.

## Authentication

Implementation:

- `src/lib/auth.ts`,
- `src/routes/LoginPage.tsx`,
- login hashes injected in `vite.config.ts` (`__LOGIN_HASHES__`).

Properties:

- local bcrypt verification (`compareSync`),
- auth state stored in `localStorage` (`demeter-authenticated`).

Important limitation:

- this mechanism is not equivalent to server-side access control.

## API token handling

Covered tokens:

- Hugging Face,
- Mistral.

Strategy:

- no clear-text persistence in `demeter-asr-settings`,
- AES-GCM encryption through WebCrypto,
- ciphertext + IV stored in IndexedDB `demeter-secure-vault`.

Components:

- `src/lib/secure-token-vault.ts`,
- `src/store/asr-store.ts` (settings <-> vault sync).

## Browser isolation and WASM

Required headers for multithreaded WASM:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

Applied via:

- Vite dev/preview (`vite.config.ts`),
- runtime Nginx (`docker/nginx/transcode.conf`),
- Traefik labels (defense in depth).

## Container hardening

In `docker-compose.yml` (`transcode` service):

- `read_only: true`,
- `tmpfs` writable areas,
- `cap_drop: [ALL]`.

## CI/CD security controls

Main workflows:

- `ci.yml`: lint, tests, coverage.
- `codeql.yml`: static security analysis.
- `trivy.yml`: FS + image vulnerability scans (HIGH/CRITICAL).
- `prod-smoke.yml`: runtime availability + security header checks.

## Data privacy by mode

### Local transcription / local LLM

- audio/text processing remains in browser,
- data is not sent to external providers (except model downloads when browser cache is cold).

### Cloud transcription / cloud LLM

- data is sent to the selected provider,
- tokens are sent only to the target provider endpoint.

## Operational recommendations

- set strong `LOGIN_PASSWORDS` values in production builds,
- restrict network exposure of services when needed,
- monitor Trivy/CodeQL findings regularly,
- define retention policy for locally exported transcript artifacts.

## References

- root policy: [`SECURITY.md`](../../SECURITY.md)
- CI/security controls: [`ci-quality-observability.md`](ci-quality-observability.md)
- deployment runbooks: [`deployment-operations.md`](deployment-operations.md)
