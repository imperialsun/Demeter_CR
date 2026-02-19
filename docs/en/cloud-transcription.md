# Cloud transcription

## Scope

Route: `/cloudupload`

The module applies local preprocessing then delegates transcription to a remote provider.

Supported providers:

- Gradio,
- Hugging Face Whisper,
- Mistral audio transcription.

## Shared pipeline

1. File selection + metadata.
2. Session settings resolution (`resolveCloudSessionSettings`).
3. Local preprocessing (`preprocessCloudAudio`).
4. WAV encoding.
5. Provider upload/submit.
6. Output parsing into normalized segments.
7. Result export.

## Diagram: cloud pipeline by provider

```mermaid
flowchart TD
    A[File selected] --> B[Local preprocess and WAV encode]
    B --> C{Provider}
    C -->|Gradio| D[gradio upload + submit + poll]
    C -->|Whisper| E[HF inference chunk plan + calls]
    C -->|Mistral| F[Mistral /v1/audio/transcriptions]
    D --> G[normalize segments]
    E --> G
    F --> G
    G --> H[UI results + exports + telemetry]
```

## Provider differences

### Gradio

- Default URL: `https://transcode.demeter-sante.fr/gradio`.
- Context text is used (preset + session context).
- May return SRT/text payloads to parse.

### Whisper (Hugging Face)

- HF token required.
- Whisper-specific cloud chunking (`cloudWhisperChunkDurationSec`, `cloudWhisperOverlapSec`).
- Custom context is currently ignored (explicit telemetry marker).

### Mistral

- Mistral API key required.
- Endpoint: `${cloudMistralApiUrl}/v1/audio/transcriptions`.
- Mistral-specific chunking (`cloudMistralChunkDurationSec`, `cloudMistralOverlapSec`).
- Diarization configurable (`cloudMistralDiarizationEnabled`).
- Retry without diarization on validation error 422.

## Context handling

- Effective context = settings preset + session context.
- Context is sent only in Gradio flows.
- Whisper/Mistral log a context-ignored event when context exists.

## Runtime states

`CloudStatus` values:

- `idle`,
- `preprocessing`,
- `uploading`,
- `transcribing`,
- `stopping`,
- `done`,
- `error`.

UI exposes progress, status detail, stop/reset controls.

## Stop and reset

- Stop attempts provider-side cancellation (notably Gradio stop flag).
- Reset invalidates current run, waits for stop, then clears cloud session state.

## Cloud exports

Configurable independently from local mode:

- segment visibility,
- VTT/SRT/JSON/telemetry exports.

Cloud placement and defaults:

- on `/cloudupload`, export buttons are rendered above segments (right after `AudioPlayer`),
- cloud defaults for new profiles: `VTT`, `SRT`, `JSON` visible and `Telemetry` hidden,
- cloud toggles stay independent from local toggles.

Export header (run snapshot):

- built from `runExportHeaders.cloud` (effective settings used by the run),
- provider-specific without parameter mixing:
  - Gradio: endpoint + generation/context/cloud preprocess fields,
  - Whisper: whisper chunking + whisper/cloud preprocess fields (context not sent),
  - Mistral: endpoint/model/chunking + requested/effective diarization/fallback chunks.

## Speakers and diarization in UI

Display:

- the table `Speaker` column is shown when at least one segment contains speaker data,
- it is no longer strictly tied to the diarization toggle alone.

Assignment:

- the `Assigner speakers` button is shown only when speakers are detected in segments,
- applied assignments (first/last names) are reflected in the table and `VTT`/`SRT`/`JSON` exports.

Known limitation:

- if Mistral returns `422` and auto-falls back without diarization, segments can be produced without speaker data.

## Related implementation files

- `src/hooks/useCloudTranscription.ts`
- `src/lib/cloud/preprocessCloudAudio.ts`
- `src/lib/cloud/gradioClient.ts`
- `src/lib/cloud/whisperClient.ts`
- `src/lib/cloud/mistralClient.ts`
- `src/lib/cloud/sessionSettings.ts`
