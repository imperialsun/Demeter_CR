# Local transcription

## Scope

Route: `/localupload`

Browser-local execution through Transformers.js ASR + ONNX Runtime Web.

## Functional pipeline

1. File selection (`AudioUploader`).
2. Metadata probe (`probeAudioMetadata`).
3. ASR pipeline initialization (`createAsrPipeline`).
4. Audio preprocessing (`quick` or `full`).
5. Chunk plan build (`buildChunks`).
6. Chunk-by-chunk transcription (`transcribeChunk`).
7. Inter-chunk text normalization + dedup.
8. Segment/global confidence computation.
9. Exports (`VTT`, `SRT`, `JSON`, `telemetry.json`).

## Diagram: local full vs progressive pipeline

```mermaid
flowchart TD
    A[File selected] --> B[Probe metadata]
    B --> C[Init ASR pipeline]
    C --> D{Memory mode}
    D -->|full| E[decodeFileFully]
    D -->|progressive| F[createSegmentCache via FFmpeg]
    E --> G[optional preprocess full]
    F --> H[load segment by segment]
    H --> I[optional preprocess per segment]
    G --> J[buildChunks]
    I --> J
    J --> K[transcribeChunk loop]
    K --> L[normalise + dedupe + confidence]
    L --> M[store segments + telemetry + exports]
```

## Runtime backend and fallback

Logical order:

- `webgpu` preference then `wasm` fallback,
- WASM asset validation,
- WASM multithread test,
- single-thread fallback when multithread init fails.

Visible indicators:

- `activeBackend`,
- WASM single-thread/multithread badge,
- status/detail messages in topbar and status bar.

## Memory modes

### `full` mode

- full decode into RAM,
- simpler for short/medium files,
- higher memory pressure.

### `progressive` mode

- upstream segmentation with FFmpeg WASM,
- intermediate segment cache in IndexedDB,
- incremental decode/transcribe,
- robust for long media.

## Chunking and segmentation

Strategies:

- `sequential`: fixed windows,
- `overlap`: overlapping windows + dedup,
- `silence`: VAD/silence-aware segmentation.

Main parameters:

- `chunkDurationSec`,
- `overlapSec`,
- `silenceThresholdDb`,
- `minSilenceMs`,
- `minChunkMs`, `maxChunkMs`.

## Audio preprocessing

Primary controls:

- denoise (noise floor, reduction, smoothing),
- high-pass / low-pass filters,
- LUFS normalization,
- limiter,
- VAD,
- overlap-add smoothing,
- autotune.

`full` mode enables heavy processing. `quick` skips heavy steps.

## Confidence and quality

- segment confidence (`confidence`) when model returns it,
- duration-weighted global confidence,
- text-based fallback estimation when model confidence is unavailable.

## Stop, abort, errors

- Stop button requests graceful stop,
- immediate abort through shared controller,
- local session reset keeps persisted settings,
- temporary error hold before auto-reset.

## Exports

`ExportButtons` supports:

- `VTT`,
- `SRT`,
- segment `JSON`,
- `telemetry.json`.

Each export can include contextual header metadata (settings + runtime + mode).

## Related implementation files

- `src/hooks/useTranscriptionController.ts`
- `src/lib/asr.ts`
- `src/lib/preprocessing.ts`
- `src/lib/chunking.ts`
- `src/lib/export.ts`
