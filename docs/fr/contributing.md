# Contribution (guide detaille)

## Workflow recommande

1. creer une branche dediee depuis `main`.
2. implementer changement cible en commits atomiques.
3. executer checks locaux.
4. ouvrir PR avec description claire (impact, risques, validation).

## Standards de qualite

Checks obligatoires avant PR:

```bash
npm run docs:check
npm run lint
npm run test:ci
npm run build
```

## Tests

- ajouter/adapter tests pour comportement modifie,
- privilegier tests deterministes,
- documenter test manuel si automatisation impossible.

## Instrumentation obligatoire

Conventions du projet:

- utiliser `logger` (`src/lib/logger.ts`) plutot que `console.*`,
- emettre events telemetrie pour flux long/couteux/erreur,
- ajouter alerts telemetrie sur fallbacks critiques.

## Style de code

- modifications ciblees,
- pas de changement hors scope,
- garder compatibilite runtime/browser.

## Documentation

Si comportement user-facing change:

- mettre a jour docs FR et EN,
- garder parite de structure,
- verifier liens/ancres via `docs:check`.

## Checklist PR suggeree

- [ ] implementation terminee
- [ ] tests ajoutes/mis a jour
- [ ] lint/test/build OK
- [ ] docs FR/EN mises a jour
- [ ] aucun secret committe
- [ ] impact securite evalue

## Liens

- contribution root: [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
- CI/qualite: [`ci-quality-observability.md`](ci-quality-observability.md)
- architecture: [`architecture.md`](architecture.md)
