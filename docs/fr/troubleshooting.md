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

## Outils de debug

- export logs depuis topbar,
- page `/telemetry`,
- `docker compose logs -f transcode` en conteneurise.
