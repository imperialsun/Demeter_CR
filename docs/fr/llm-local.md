# LLM Local (rapports navigateur)

## Scope

Route: `/llmlocal`

Generation CRI/CRO/CRS executee localement dans le navigateur, sans appel API externe.

## Profils modeles

Profils principaux (`localModelCatalog`):

- `qwen_0_6b`: profil leger,
- `qwen_1_7b`: profil standard,
- `ministral_3_3b`: profil lourd, qualite superieure.

Chaque profil definit:

- `modelId`,
- `contextWindowTokens`,
- `maxGenerationTokens`,
- dtypes recommandes webgpu/wasm,
- backends autorises.

## Selection backend locale

Resolution backend en priorite:

1. WebGPU si supporte et autorise par profil,
2. WASM si disponible et autorise,
3. erreur si aucun backend compatible.

Fallback possible par profil (ex: profil lourd -> profil plus leger).

## Dtype et performance

Parametres par profil:

- `dtypeWebgpu`,
- `dtypeWasm`,
- `maxTokens`,
- `temperature`,
- `appendNoThinkDirective`.

WASM multithread peut etre force/desactive via `llmLocalForceSingleThread`.

## Pipeline generation locale

1. resolution source (transcription ou texte/import),
2. budget tokens et chunking long input,
3. generation locale format par format,
4. parse JSON,
5. pass de reparation JSON si parse echoue,
6. export DOCX.

## Etats runtime

`LlmApiStatus` reuse cote local:

- `idle`,
- `preparing`,
- `generating`,
- `formatting`,
- `done`,
- `error`.

## Limites et recommandations

- Les modeles lourds peuvent saturer VRAM/RAM selon poste.
- WASM est plus compatible mais plus lent que WebGPU.
- Pour tres gros input texte, verifier budget tokens avant lancement.

## Fichiers techniques lies

- `src/hooks/useLlmLocalReports.ts`
- `src/lib/llm/localModelCatalog.ts`
- `src/lib/llm/local/localGeneration.ts`
- `src/lib/llm/local/localReportService.ts`
- `src/lib/docx/reportDocx.ts`
