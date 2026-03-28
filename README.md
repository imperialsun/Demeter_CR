# Demeter Speech

[![CI](https://github.com/imperialsun/Demeter_CR/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/imperialsun/Demeter_CR/actions/workflows/ci.yml)
[![Prod Smoke](https://github.com/imperialsun/Demeter_CR/actions/workflows/prod-smoke.yml/badge.svg?branch=main)](https://github.com/imperialsun/Demeter_CR/actions/workflows/prod-smoke.yml)
[![CodeQL](https://github.com/imperialsun/Demeter_CR/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/imperialsun/Demeter_CR/actions/workflows/codeql.yml)
[![Trivy](https://github.com/imperialsun/Demeter_CR/actions/workflows/trivy.yml/badge.svg?branch=main)](https://github.com/imperialsun/Demeter_CR/actions/workflows/trivy.yml)
[![Coverage](https://codecov.io/gh/imperialsun/Demeter_CR/branch/main/graph/badge.svg)](https://codecov.io/gh/imperialsun/Demeter_CR)
[![Last commit](https://img.shields.io/github/last-commit/imperialsun/Demeter_CR)](https://github.com/imperialsun/Demeter_CR/commits/main)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

Demeter Speech is a browser application for:

- local speech transcription (WebGPU/WASM, no cloud transfer),
- cloud speech transcription (Gradio / Hugging Face Whisper / Mistral),
- LLM report generation (CRI / CRO / CRS) in cloud and local modes,
- export of transcripts and telemetry.

## Quickstart

### Local development

```bash
npm ci
npm run dev
```

### Local backend integration tests

```bash
npm run test:backend-integration
```

Prerequisites:

- `go` must be available in `PATH`,
- the backend checkout must exist at `../Backend`,
- this suite is local-only in v1 and is not wired into the default CI jobs.

### Docker production stack

```bash
docker compose up --build -d
```

### Docker dev stack

```bash
docker compose -f compose.dev.yml up -d
```

### Workspace local deployment

From the workspace root, `./deploy-transcode.sh local` starts Backend, Front user, and Admin panel together.

## Which mode should I use?

| Mode | Route | Best for | Audio leaves workstation |
| --- | --- | --- | --- |
| Local transcription | `/localupload` | Maximum confidentiality, offline-like workflow | No |
| Cloud transcription | `/cloudupload` | Remote ASR providers, long media offload | Yes |
| LLM local | `/llmlocal` | Local report generation from transcript/text | No |
| LLM cloud | `/llmapi` | Cloud LLM report generation with large context windows | Yes |

## Recent capabilities

- Local and cloud export actions are rendered above the segment table for faster download workflow.
- Export headers are generated from the real run snapshot (effective settings + runtime), not only current UI values.
- Speaker workflow now includes speaker display, per-run speaker assignment, and assigned labels in `VTT`/`SRT`/`JSON` exports.

## Compatibility and prerequisites

- Node.js `25.8.1` (`.nvmrc`) for local build and scripts.
- npm (lockfile is `package-lock.json`).
- Modern browser with WebGPU/WASM support (Chrome/Edge recommended).
- Cross-origin isolation headers for multithreaded WASM:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`

## Security notes

- Login is a client-side gate (`src/lib/auth.ts`), not a server-side IAM.
- Password hashes are injected at build time from `LOGIN_PASSWORDS`.
- The repo keeps only two tracked env files for that purpose: `.env.development` and `.env.production`.
- API tokens are not persisted in clear text settings; sensitive tokens are stored in an encrypted browser vault (`src/lib/secure-token-vault.ts`, AES-GCM + IndexedDB + WebCrypto).

## Full documentation

- Documentation portal: [`docs/README.md`](docs/README.md)
- French docs: [`docs/fr/index.md`](docs/fr/index.md)
- English docs: [`docs/en/index.md`](docs/en/index.md)

## Community

- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security policy: [`SECURITY.md`](SECURITY.md)

## License

This project is licensed under GPL-3.0-or-later. See [`LICENSE`](LICENSE).
