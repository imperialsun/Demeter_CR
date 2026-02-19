# Contributing (detailed guide)

## Recommended workflow

1. create a dedicated branch from `main`.
2. implement scoped changes in atomic commits.
3. run local checks.
4. open PR with clear impact/risk/validation notes.

## Quality standards

Required checks before PR:

```bash
npm run docs:check
npm run lint
npm run test:ci
npm run build
```

## Testing

- add/update tests for changed behavior,
- favor deterministic tests,
- document manual validation when automation is not feasible.

## Mandatory instrumentation

Project conventions:

- use `logger` (`src/lib/logger.ts`) instead of raw `console.*`,
- emit telemetry events for long/expensive/error-prone flows,
- add telemetry alerts for critical fallbacks.

## Coding style

- keep edits targeted,
- avoid unrelated changes,
- preserve browser/runtime compatibility constraints.

## Documentation duties

When user-facing behavior changes:

- update both FR and EN docs,
- keep mirrored structure parity,
- validate links/anchors via `docs:check`.

## Suggested PR checklist

- [ ] implementation completed
- [ ] tests added/updated
- [ ] lint/test/build pass
- [ ] FR/EN docs updated
- [ ] no secrets committed
- [ ] security impact reviewed

## Links

- root contribution file: [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
- CI/quality docs: [`ci-quality-observability.md`](ci-quality-observability.md)
- architecture docs: [`architecture.md`](architecture.md)
