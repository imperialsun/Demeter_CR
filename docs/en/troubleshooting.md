# Troubleshooting

## No usable backend

Symptoms:

- startup error state,
- message says WebGPU unsupported and/or WASM unavailable.

Checks:

1. verify `public/onnx/*` files are served,
2. verify COOP/COEP headers,
3. inspect browser logs (`checkWasmAssets`, backend init logs).

## WASM multithread unavailable

Symptoms:

- repeated single-thread fallback.

Checks:

1. `window.crossOriginIsolated` must be `true`.
2. COOP/COEP headers must be present.
3. inspect `WASM_MULTITHREAD_TEST` telemetry/logs.

## Slow local transcription

Actions:

- use lighter preset (`fast`/`balanced`),
- reduce `chunkDurationSec`,
- switch to `progressive` mode,
- force WASM single-thread on unstable MT hosts.

## Gradio errors

Actions:

- verify `cloudApiUrl`,
- verify `/gradio` and `/gradio_api` proxy routing,
- validate `gradio_api/info` response.

## Whisper errors

Actions:

- verify HF token,
- verify provider access/quota,
- tune whisper cloud chunking values.

## Mistral transcription errors

Actions:

- verify API key and `cloudMistralApiUrl`,
- verify `cloudMistralModel`,
- disable diarization on repeated 422 validation failures.

## Speaker not visible in cloud table

Symptoms:

- Mistral transcription completes but speaker column is empty/missing.

Checks:

1. verify Mistral request is sent with `diarize=true`,
2. check whether a `422` fallback retried without diarization (`retrying without diarization...`),
3. inspect exported `segments.json`: if `speaker` is missing in segments, UI cannot show it.

Interpretation:

- speaker missing in API response => provider/model/parameter limitation,
- speaker present in segments but not visible => verify UI table rendering and assignments.

## Missing "Assigner speakers" button

Symptom:

- no `Assigner speakers` button in export actions.

Expected cause:

- the button is shown only when at least one segment has a non-empty `speaker`.

Actions:

1. inspect exported `segments.json`,
2. confirm diarization is effectively enabled and not fallback-disabled,
3. test with a clear multi-speaker audio sample.

## LLM cloud context overflow

Symptoms:

- run blocked by context budget,
- max token/context window errors.

Actions:

- reduce input source size,
- choose model with larger context,
- verify provider max token settings.

## LLM local OOM or severe slowness

Actions:

- switch to lighter profile,
- lower `maxTokens`,
- choose more compact dtype,
- prefer WebGPU where available.

## Login rejected

Actions:

- verify `LOGIN_PASSWORDS` at build time,
- rebuild app/image after password change,
- verify auth hash load logs.

## CI docs check failure

Actions:

- run `npm run docs:check` locally,
- fix relative links and anchors,
- verify `docs/fr` and `docs/en` file parity.

## CI coverage-hotspots failure (`missing coverage/lcov.info`)

Symptom:

- `node scripts/coverage-hotspots.mjs` fails with `missing .../coverage/lcov.info`.

Likely cause:

- the coverage-producing step (`npm run test:ci`) did not run, or failed before writing `lcov`.

Actions:

1. run `npm run test:ci` locally and verify `coverage/lcov.info` exists,
2. verify CI order: coverage tests before `coverage-hotspots`,
3. fix upstream test/lint failures if coverage file is never generated.

## Debug tools

- topbar log export,
- `/telemetry` page,
- `docker compose logs -f transcode` for container runtime.
