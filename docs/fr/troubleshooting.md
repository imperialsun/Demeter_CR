# Depannage

## Aucun backend utilisable

Symptome:

- statut erreur au boot,
- message indiquant WebGPU non supporte et/ou WASM indisponible.

Checks:

1. verifier fichiers `public/onnx/*` servis.
2. verifier headers COOP/COEP.
3. verifier console navigateur (`checkWasmAssets`, init backend logs).

## WASM multithread indisponible

Symptome:

- fallback single-thread recurrent.

Checks:

1. `window.crossOriginIsolated` doit etre `true`.
2. headers COOP/COEP presents sur `index.html` et assets.
3. verifier logs `WASM_MULTITHREAD_TEST`.

## Transcription locale lente

Actions:

- choisir preset plus leger (`fast`/`balanced`),
- reduire `chunkDurationSec`,
- utiliser mode `progressive`,
- forcer WASM single-thread si contention.

## Erreurs Gradio

Actions:

- verifier `cloudApiUrl`,
- verifier proxy `/gradio` et `/gradio_api`,
- verifier reponse `gradio_api/info`.

## Erreurs Whisper

Actions:

- verifier token HF,
- verifier quotas/provider access,
- adapter chunking cloud whisper.

## Erreurs Mistral transcription

Actions:

- verifier cle API et `cloudMistralApiUrl`,
- verifier `cloudMistralModel`,
- desactiver diarization si validation errors 422.

## Speaker non visible dans la table cloud

Symptomes:

- transcription Mistral terminee mais colonne speaker vide/inexistante.

Checks:

1. verifier que la requete Mistral part avec `diarize=true`,
2. verifier si un fallback `422` force un retry sans diarization (`retrying without diarization...`),
3. verifier l export `segments.json`: si `speaker` absent dans les segments, la colonne ne peut pas s afficher.

Interpretation:

- speaker absent dans reponse API => limite provider/model/parametres,
- speaker present dans segments mais pas visible => verifier rendu UI/table et assignations.

## Bouton "Assigner speakers" absent

Symptome:

- aucun bouton `Assigner speakers` dans la barre export.

Cause attendue:

- le bouton n apparait que si au moins un segment contient un `speaker` non vide.

Actions:

1. verifier `segments.json` exporte,
2. confirmer que diarization est effectivement activee et non fallbackee,
3. tester avec un audio multi-intervenants.

## LLM cloud: contexte trop long

Symptome:

- blocage budget contexte,
- erreur max tokens/context window.

Actions:

- reduire source texte,
- choisir modele avec contexte plus large,
- verifier settings max tokens provider.

## LLM local: OOM ou lenteur severe

Actions:

- basculer vers profil plus leger,
- baisser `maxTokens`,
- ajuster dtype plus compact,
- preferer WebGPU si disponible.

## Login refuse

Actions:

- verifier `LOGIN_PASSWORDS` injecte au build,
- reconstruire image/app apres changement mot de passe,
- verifier hashes chargés dans logs auth.

## CI echoue sur docs

Actions:

- executer `npm run docs:check` local,
- corriger liens relatifs et ancres,
- verifier parite fichiers `docs/fr` vs `docs/en`.

## CI echoue sur coverage-hotspots (`missing coverage/lcov.info`)

Symptome:

- `node scripts/coverage-hotspots.mjs` echoue avec `missing .../coverage/lcov.info`.

Cause probable:

- l etape qui genere la couverture (`npm run test:ci`) n a pas tourne, ou a echoue avant emission du fichier `lcov`.

Actions:

1. lancer `npm run test:ci` localement et verifier la creation de `coverage/lcov.info`,
2. verifier l ordre CI: tests coverage avant `coverage-hotspots`,
3. corriger la cause d echec tests/lint en amont si le fichier n est jamais genere.

## Outils de debug

- export logs depuis topbar,
- page `/telemetry`,
- `docker compose logs -f transcode` en conteneurise.
