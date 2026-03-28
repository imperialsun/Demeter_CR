# Reference des parametres

## Objectif

Ce document reference les parametres persistes et leur impact runtime.

Sources de verite:

- `src/store/asr-store.ts` (etat et actions),
- `src/lib/storage.ts` (`DEFAULT_SETTINGS`),
- `src/lib/secure-token-vault.ts` (secrets).

## Cles de stockage

### localStorage

- `demeter-asr-settings`: blob JSON des settings non sensibles.
- `demeter-authenticated`: flag login.
- `demeter-theme`: theme UI.

### IndexedDB

- `demeter-secure-vault`: tokens chiffres (stores `keys`, `secrets`).
- cache segments progressifs (module segment cache).

## Etat session non persiste

Ces champs existent dans le store runtime mais ne sont pas ecrits dans `demeter-asr-settings`:

- `runExportHeaders` (par mode `upload|mic|cloud`): snapshot des settings/runtime reels du run, utilise dans les headers des exports.
- `speakerAssignments` (par mode `upload|mic|cloud`): mapping speaker technique -> `firstName/lastName` applique a l affichage et aux exports.

Cycle de vie:

- nouveau run local/mic/cloud: purge des assignations du mode courant,
- `resetSession` / `resetApp`: purge des assignations et des snapshots d export,
- reload page: etat perdu (session-only).

Note explicite: `speakerAssignments` n est pas inclus dans `PersistedSettings`.

## Domaine local transcription

### Modele et backend

- `activePreset`: `fast|balanced|medium|quality|mms|turbo|custom`.
- `customModelId`: model id custom.
- `backendPreference`: `webgpu|wasm`.
- `forceSingleThread`: force WASM single-thread.

### Chunking

- `chunkStrategy`: `sequential|overlap|silence`.
- `segmentationMode`: `chunks|silence`.
- `chunkDurationSec`, `overlapSec`.
- `silenceThresholdDb`, `minSilenceMs`, `minChunkMs`, `maxChunkMs`.
- `dedupeMode`: `normal|fuzzy`.
- `cleanIntraChunk`: nettoyage intra-chunk.

### Pretraitement

- `preprocessingMode`: `quick|full`.
- denoise: `denoiseNoiseFloorDb`, `denoiseReductionDb`, `denoiseSmoothing`, `denoiseCalibrationSeconds`.
- filtres: `preprocessEnableFilters`, `preprocessHighpassHz`, `preprocessLowpassHz`.
- loudness: `preprocessEnableLufs`, `preprocessTargetLufs`.
- limiteur: `preprocessLimiterEnabled`, `preprocessLimiterThresholdDb`, `preprocessLimiterSoftness`.
- VAD: `preprocessVadEnabled`, `preprocessVadThresholdDb`, `preprocessVadMinSilenceMs`.
- overlap-add: `preprocessOverlapAdd`, `preprocessOverlapBlockSec`, `preprocessOverlapSec`.
- autotune: `autoTunePreprocess`.

### Affichage/export

- `showSegments`.
- `showExportVtt|showExportSrt|showExportJson|showExportTelemetry`.
- `enableWordTimestamps`.
- `showSegmentConfidence`.

## Domaine cloud transcription

### Provider endpoints et auth

- `cloudMistralApiUrl`.
- `cloudMistralModel`.
- `hfApiToken` (secret vault).
- `mistralApiKey` (secret vault).

### Generation/transcription

- `cloudMaxTokens`, `cloudTemperature`, `cloudTopP`, `cloudDoSample`.
- `cloudMistralDiarizationEnabled`.

### Chunking provider-specific

- Whisper: `cloudWhisperChunkDurationSec`, `cloudWhisperOverlapSec`.
- Mistral et Demeter: `cloudMistralChunkDurationSec`, `cloudMistralOverlapSec`.

### Pretraitement cloud

- `cloudPreprocessingMode`.
- parametres denoise/filters/lufs/limiter/vad equivalents du mode local.
- `cloudAutoTunePreprocess`.

### Affichage/export cloud

- `cloudShowSegments`.
- `cloudShowExportVtt|cloudShowExportSrt|cloudShowExportJson|cloudShowExportTelemetry`.
- `cloudEnableWordTimestamps`.
- `cloudShowSegmentConfidence`.

## Domaine LLM cloud

- `llmApiProvider`: `huggingface|mistral`.
- HF: `llmApiHfModelId`, `llmApiHfTemperature`, `llmApiHfMaxTokens`.
- Mistral: `llmApiMistralModelId`, `llmApiMistralTemperature`, `llmApiMistralMaxTokens`.

## Domaine LLM local

- `llmLocalModelProfile`: `qwen_0_6b|qwen_1_7b|ministral_3_3b`.
- `llmLocalSettingsByProfile`:
  - `modelId`,
  - `temperature`,
  - `maxTokens`,
  - `dtypeWebgpu`,
  - `dtypeWasm`,
  - `appendNoThinkDirective`.
- `llmLocalForceSingleThread`.

## Valeurs par defaut notables

- Node attendu: `25.8.1`.
- Local preset: `fast`.
- Local backend preference: `webgpu`.
- Cloud provider (UI): Gradio.
- LLM cloud provider: `huggingface`.
- LLM local profile: `qwen_1_7b`.

## Parametres sensibles et sanitization

`src/lib/storage.ts` retire automatiquement les champs sensibles du blob settings:

- `hfApiToken`,
- `mistralApiKey`,
- `cloudHfToken`,
- `cloudMistralApiKey`,
- `llmApiHfToken`.

Ces valeurs sont conservees via secure vault chiffre.

## Conseils de tuning

- Prioriser `webgpu` pour latence.
- Passer en `progressive` pour medias longs.
- Diminuer `chunkDurationSec` en cas de memoire limitee.
- Activer `forceSingleThread` si incidents WASM MT.
- Ajuster `cloud*ChunkDurationSec` selon quota et timeout provider.
