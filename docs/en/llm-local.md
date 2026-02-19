# LLM Local (browser reports)

## Scope

Route: `/llmlocal`

CRI/CRO/CRS generation runs inside the browser without external LLM API calls.

## Model profiles

Main profiles (`localModelCatalog`):

- `qwen_1_7b`: default profile,
- `ministral_3_3b`: heavier, higher quality profile.

Each profile defines:

- `modelId`,
- `contextWindowTokens`,
- `maxGenerationTokens`,
- recommended webgpu/wasm dtypes,
- allowed backends.

## Local backend selection

Backend resolution order:

1. WebGPU if supported and allowed,
2. WASM if available and allowed,
3. error if no compatible backend exists.

Profile-level fallback is supported (heavy profile -> lighter profile).

## Dtype and performance

Per-profile controls:

- `dtypeWebgpu`,
- `dtypeWasm`,
- `maxTokens`,
- `temperature`,
- `appendNoThinkDirective`.

WASM multithreading can be toggled through `llmLocalForceSingleThread`.

## Local generation pipeline

1. source resolution (transcription or text/import),
2. token budget and long-input chunking,
3. local generation format by format,
4. JSON parsing,
5. JSON repair pass if parse fails,
6. DOCX export.

## Runtime states

Local flow reuses `LlmApiStatus` values:

- `idle`,
- `preparing`,
- `generating`,
- `formatting`,
- `done`,
- `error`.

## Limits and recommendations

- Heavy models may saturate VRAM/RAM depending on workstation.
- WASM is more compatible but slower than WebGPU.
- For very large text sources, validate token budget before run.

## Related implementation files

- `src/hooks/useLlmLocalReports.ts`
- `src/lib/llm/localModelCatalog.ts`
- `src/lib/llm/local/localGeneration.ts`
- `src/lib/llm/local/localReportService.ts`
- `src/lib/docx/reportDocx.ts`
