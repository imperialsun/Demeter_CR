# Settings reference

## Purpose

This document references persisted settings and their runtime impact.

Source of truth:

- `src/store/asr-store.ts` (state + actions),
- `src/lib/storage.ts` (`DEFAULT_SETTINGS`),
- `src/lib/secure-token-vault.ts` (secrets).

## Storage keys

### localStorage

- `demeter-asr-settings`: JSON blob for non-sensitive settings.
- `demeter-authenticated`: login state flag.
- `demeter-theme`: UI theme.

### IndexedDB

- `demeter-secure-vault`: encrypted tokens (stores `keys`, `secrets`).
- progressive segment cache database (segment cache module).

## Non-persisted session state

These fields exist in runtime store state but are not written to `demeter-asr-settings`:

- `runExportHeaders` (per mode `upload|mic|cloud`): snapshot of effective run settings/runtime used in export headers.
- `speakerAssignments` (per mode `upload|mic|cloud`): technical speaker id -> `firstName/lastName` mapping used for UI and exports.

Lifecycle:

- new local/mic/cloud run: assignments are cleared for that mode,
- `resetSession` / `resetApp`: assignments and run export snapshots are cleared,
- page reload: state is lost (session-only).

Explicit note: `speakerAssignments` is not part of `PersistedSettings`.

## Local transcription domain

### Model and backend

- `activePreset`: `fast|balanced|medium|quality|mms|turbo|custom`.
- `customModelId`: custom model id.
- `backendPreference`: `webgpu|wasm`.
- `forceSingleThread`: forces WASM single-thread.

### Chunking

- `chunkStrategy`: `sequential|overlap|silence`.
- `segmentationMode`: `chunks|silence`.
- `chunkDurationSec`, `overlapSec`.
- `silenceThresholdDb`, `minSilenceMs`, `minChunkMs`, `maxChunkMs`.
- `dedupeMode`: `normal|fuzzy`.
- `cleanIntraChunk`: intra-chunk cleanup.

### Preprocessing

- `preprocessingMode`: `quick|full`.
- denoise: `denoiseNoiseFloorDb`, `denoiseReductionDb`, `denoiseSmoothing`, `denoiseCalibrationSeconds`.
- filters: `preprocessEnableFilters`, `preprocessHighpassHz`, `preprocessLowpassHz`.
- loudness: `preprocessEnableLufs`, `preprocessTargetLufs`.
- limiter: `preprocessLimiterEnabled`, `preprocessLimiterThresholdDb`, `preprocessLimiterSoftness`.
- VAD: `preprocessVadEnabled`, `preprocessVadThresholdDb`, `preprocessVadMinSilenceMs`.
- overlap-add: `preprocessOverlapAdd`, `preprocessOverlapBlockSec`, `preprocessOverlapSec`.
- autotune: `autoTunePreprocess`.

### Display/export

- `showSegments`.
- `showExportVtt|showExportSrt|showExportJson|showExportTelemetry`.
- `enableWordTimestamps`.
- `showSegmentConfidence`.

## Cloud transcription domain

### Endpoints and auth

- `cloudApiUrl` (Gradio).
- `cloudMistralApiUrl`.
- `cloudMistralModel`.
- `hfApiToken` (secure vault).
- `mistralApiKey` (secure vault).

### Generation/transcription

- `cloudMaxTokens`, `cloudTemperature`, `cloudTopP`, `cloudDoSample`.
- `cloudContextPreset`.
- `cloudMistralDiarizationEnabled`.

### Provider-specific chunking

- Whisper: `cloudWhisperChunkDurationSec`, `cloudWhisperOverlapSec`.
- Mistral: `cloudMistralChunkDurationSec`, `cloudMistralOverlapSec`.

### Cloud preprocessing

- `cloudPreprocessingMode`.
- denoise/filter/lufs/limiter/vad settings equivalent to local mode.
- `cloudAutoTunePreprocess`.

### Cloud display/export

- `cloudShowSegments`.
- `cloudShowExportVtt|cloudShowExportSrt|cloudShowExportJson|cloudShowExportTelemetry`.
- `cloudEnableWordTimestamps`.
- `cloudShowSegmentConfidence`.

## LLM cloud domain

- `llmApiProvider`: `huggingface|mistral`.
- HF: `llmApiHfModelId`, `llmApiHfTemperature`, `llmApiHfMaxTokens`.
- Mistral: `llmApiMistralModelId`, `llmApiMistralTemperature`, `llmApiMistralMaxTokens`.

## LLM local domain

- `llmLocalModelProfile`: `qwen_1_7b|ministral_3_3b`.
- `llmLocalSettingsByProfile`:
  - `modelId`,
  - `temperature`,
  - `maxTokens`,
  - `dtypeWebgpu`,
  - `dtypeWasm`,
  - `appendNoThinkDirective`.
- `llmLocalForceSingleThread`.

## Notable defaults

- expected Node: `25.6.1`.
- local preset: `fast`.
- local backend preference: `webgpu`.
- cloud provider in UI: Gradio.
- LLM cloud provider: `huggingface`.
- LLM local profile: `qwen_1_7b`.

## Sensitive settings and sanitization

`src/lib/storage.ts` automatically strips sensitive fields from persisted settings:

- `hfApiToken`,
- `mistralApiKey`,
- `cloudHfToken`,
- `cloudMistralApiKey`,
- `llmApiHfToken`.

Those values are preserved through the encrypted secure vault.

## Tuning guidance

- Prefer `webgpu` for latency.
- Use `progressive` mode for long media.
- Lower `chunkDurationSec` under memory pressure.
- Enable `forceSingleThread` on unstable WASM MT platforms.
- Tune `cloud*ChunkDurationSec` based on provider quotas/timeouts.
