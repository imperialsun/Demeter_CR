# LLM Cloud (rapports CRI/CRO/CRS)

## Scope

Route: `/llmapi`

Generation de trois formats de compte rendu:

- `CRI` (fidele),
- `CRO` (structure),
- `CRS` (synthese).

Providers:

- Hugging Face,
- Mistral.

## Sources d entree

- transcription session (`segments`),
- texte libre,
- import de fichiers `.txt`, `.srt`, `.vtt`, `.json`.

Parsing import assure extraction robuste de texte transcrit (`parseTranscriptFile`).

## Pipeline long input

Si la source depasse le budget contexte modele, une strategie 2 passes est appliquee.

## Diagramme: pipeline long input LLM

```mermaid
flowchart TD
    A[Source text resolved] --> B[Estimate tokens]
    B --> C[Resolve model token budget]
    C --> D{Over threshold?}
    D -->|No| E[Single pass generation]
    D -->|Yes| F[Chunk extraction pass]
    F --> G[Chunk summaries]
    G --> H[Consolidation pass]
    H --> E
    E --> I[Generate CRI]
    I --> J[Generate CRO]
    J --> K[Generate CRS]
    K --> L[Parse JSON + store results + DOCX export]
```

## Regles provider

### Hugging Face

- token HF requis,
- strategie `chatCompletion` avec fallback `textGeneration` selon modele/provider,
- retries exponentiels sur erreurs transientes.

### Mistral

- cle API requise,
- metadata modeles recuperee via `/v1/models` pour ajuster max tokens,
- generation via endpoint chat completions,
- reduction progressive `max_tokens` en cas erreur limite contexte.

## Orchestration multi-formats

Ordre fixe:

1. CRI,
2. CRO,
3. CRS.

Chaque format est parse en JSON structure (`reportSchema`) puis stocke dans `llmApiResults`.

## Export DOCX

- un document par format,
- nommage: `rapport-<format>-YYYY-MM-DD-HHmm.docx`,
- metadata incluse: modele, date, mode source, tokens source.

## Etats runtime

`LlmApiStatus`:

- `idle`,
- `preparing`,
- `generating`,
- `formatting`,
- `done`,
- `error`.

Progression globale exposee dans UI et topbar.

## Parametres importants

- provider actif (`llmApiProvider`),
- model id/temperature/max tokens par provider,
- token HF et cle Mistral (stockage securise via vault).

## Fichiers techniques lies

- `src/hooks/useLlmReports.ts`
- `src/lib/llm/providerSettings.ts`
- `src/lib/llm/modelCatalog.ts`
- `src/lib/llm/reportService.ts`
- `src/lib/llm/hfClient.ts`
- `src/lib/llm/mistralChatClient.ts`
- `src/lib/docx/reportDocx.ts`
