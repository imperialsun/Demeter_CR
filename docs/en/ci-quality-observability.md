# CI, quality, and observability

## Objective

Define automatic controls and instrumentation conventions to keep quality/security high and make runtime diagnosis easier.

## GitHub Actions workflows

### `ci.yml`

Main pipeline:

1. checkout,
2. Node setup (`.nvmrc`),
3. `npm ci`,
4. `npm run docs:check`,
5. `npm run lint`,
6. `npm run test:ci`,
7. coverage hotspots report,
8. Codecov upload.

### `prod-smoke.yml`

Validates compose runtime behavior:

- build + service startup,
- HTTP availability,
- security headers,
- asset cache policies.

### `codeql.yml`

Static security analysis for JavaScript/TypeScript.

### `trivy.yml`

Two scans:

- repository filesystem,
- built Docker image.

Severity scope: `HIGH`, `CRITICAL`.

## Coverage

- Vitest reporters: `text` + `lcov`.
- Codecov target for project/patch: 80% (informational mode in config).
- project threshold script: `npm run coverage:project`.
- hotspots report: `scripts/coverage-hotspots.mjs`.

Critical CI order:

1. `npm run test:ci` must generate `coverage/lcov.info`,
2. then `node scripts/coverage-hotspots.mjs` reads that file.

If `lcov.info` is missing, expected symptom is:

- `[coverage-hotspots] missing .../coverage/lcov.info` followed by a non-zero exit code.

## Observability audit

`npm run audit:observability` executes `scripts/observability-audit.mjs`.

Rules include:

- no `console.*` outside allowed logger file,
- logger/telemetry instrumentation checks on runtime files,
- required LLM markers (`LLM_RUN_START`, `LLM_RUN_DONE`, `LLM_RUN_ERROR`).

## Application telemetry

`TelemetryCollector` records:

- structured events,
- phase timers,
- chunk metrics,
- memory snapshots,
- alert counters,
- runtime context (backend/model).

Outputs:

- live UI view (`/telemetry`),
- exported `telemetry.json`.

## Critical signals to monitor

- backend init and WASM fallback,
- model load progress and `MODEL_FETCH`,
- chunk planning and transcription timings,
- cloud provider events,
- LLM run stages and parse failures,
- preprocessing/calibration alerts.

## Recommended local gate before PR

```bash
npm run docs:check
npm run lint
npm run test:ci
npm run build
```

## Related docs

- contribution guide: [`contributing.md`](contributing.md)
- troubleshooting: [`troubleshooting.md`](troubleshooting.md)
- architecture: [`architecture.md`](architecture.md)
