# CI, qualite et observabilite

## Objectif

Definir les controles automatiques et les conventions de mesure pour maintenir qualite, securite et diagnostiquer les performances.

## Workflows GitHub Actions

### `ci.yml`

Pipeline principal:

1. checkout,
2. setup Node (`.nvmrc`),
3. `npm ci`,
4. `npm run docs:check`,
5. `npm run lint`,
6. `npm run test:ci`,
7. rapport hotspots couverture,
8. upload Codecov.

### `prod-smoke.yml`

Valide en environnement compose:

- build et demarrage services,
- disponibilite HTTP,
- headers securite,
- politiques cache assets.

### `codeql.yml`

Analyse statique securite JavaScript/TypeScript.

### `trivy.yml`

Deux scans:

- filesystem repo,
- image Docker construite.

Severite cible: `HIGH`, `CRITICAL`.

## Couverture

- Vitest coverage reporter: `text` + `lcov`.
- Codecov cible projet/patch: 80% (mode informatif dans config).
- script de garde seuil projet: `npm run coverage:project`.
- hotspot report: `scripts/coverage-hotspots.mjs`.

## Audit observabilite

`npm run audit:observability` execute `scripts/observability-audit.mjs`.

Regles:

- pas de `console.*` hors logger autorise,
- verification presence instrumentation logger/telemetry sur fichiers runtime,
- verification marqueurs LLM obligatoires (`LLM_RUN_START`, `LLM_RUN_DONE`, `LLM_RUN_ERROR`).

## Telemetrie applicative

`TelemetryCollector` capture:

- events structures,
- timers de phase,
- metrics chunk,
- snapshots memoire,
- alert counters,
- contexte runtime (backend/modele).

Sorties:

- visualisation UI (`/telemetry`),
- export `telemetry.json`.

## Evenements critiques a suivre

- backend init / fallback WASM,
- model load progress et `MODEL_FETCH`,
- chunk plan et durees transcription,
- events cloud provider,
- runs LLM et erreurs parse JSON,
- alerts calibration/preprocess.

## Validation locale recommandee avant PR

```bash
npm run docs:check
npm run lint
npm run test:ci
npm run build
```

## Liens

- contribution: [`contributing.md`](contributing.md)
- depannage: [`troubleshooting.md`](troubleshooting.md)
- architecture: [`architecture.md`](architecture.md)
