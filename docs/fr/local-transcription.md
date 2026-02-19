# Transcription locale

## Scope

Route: `/localupload`

Execution locale dans le navigateur avec pipeline ASR Transformers.js + ONNX Runtime Web.

## Pipeline fonctionnel

1. Selection fichier (`AudioUploader`).
2. Probe metadata (`probeAudioMetadata`).
3. Initialisation pipeline ASR (`createAsrPipeline`).
4. Pretraitement audio (mode `quick` ou `full`).
5. Construction plan de chunks (`buildChunks`).
6. Transcription chunk par chunk (`transcribeChunk`).
7. Normalisation texte inter-chunks + dedup.
8. Calcul confiance segment/global.
9. Exports (`VTT`, `SRT`, `JSON`, `telemetry.json`).

## Diagramme: pipeline local full vs progressive

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

## Runtime backend et fallback

Ordre logique:

- preference `webgpu` puis fallback `wasm` si necessaire,
- verification assets WASM,
- test multithread WASM,
- fallback single-thread si erreur init WASM multi.

Indicateurs visibles:

- `activeBackend`,
- badge WASM single-thread/multithread,
- messages status/detail dans topbar et status bar.

## Modes memoire

### Mode `full`

- decode complet en RAM,
- simple pour fichiers courts/moyens,
- pression memoire plus elevee.

### Mode `progressive`

- segmentation amont via FFmpeg WASM,
- cache segments intermediaires en IndexedDB,
- lecture/transcription incrementale,
- robuste pour medias longs.

## Chunking et segmentation

Strategies:

- `sequential`: fenetres fixes,
- `overlap`: fenetres chevauchees + dedup,
- `silence`: segmentation orientee VAD/silence.

Parametres structurants:

- `chunkDurationSec`,
- `overlapSec`,
- `silenceThresholdDb`,
- `minSilenceMs`,
- `minChunkMs`, `maxChunkMs`.

## Pretraitement audio

Parametres principaux:

- denoise (noise floor, reduction, smoothing),
- filtres high-pass / low-pass,
- normalisation LUFS,
- limiteur,
- VAD,
- overlap-add smoothing,
- autotune parametres.

Le mode `full` active la phase la plus couteuse. Le mode `quick` saute les traitements lourds.

## Confiance et qualite

- score segment (`confidence`) si retourne par modele,
- score global pondere duree via accumulateur,
- fallback estimation texte si score modele absent.

## Arret, abort, erreurs

- bouton Stop: demande d arret propre,
- abort immediate via controller partage,
- reset session local preserve seulement les settings persistants,
- statut `error` garde temporaire avant reset automatique.

## Exports et snapshot de run

Sur `/localupload`, le bloc `ExportButtons` est rendu au-dessus du tableau des segments (juste apres le lecteur audio).

Par defaut local:

- `VTT`, `SRT`, `JSON` visibles,
- `telemetry` masque.

Les exports supportes restent:

- transcription `VTT`,
- transcription `SRT`,
- segments `JSON`,
- `telemetry.json`.

Le header d export est base en priorite sur le snapshot du run (`runExportHeaders.upload`), capture au demarrage de la transcription:

- settings reels utilises (mode memoire effectif, chunking, preprocess, options timestamps/confiance),
- runtime reel (run id, fichier, backend actif, modele actif).

Si aucun snapshot n est disponible, un fallback utilise les settings courants.

## Speakers et assignation

Le tableau des segments affiche automatiquement la colonne `Speaker` si au moins un segment contient un speaker.

Quand des speakers sont disponibles:

- le bouton `Assigner speakers` apparait,
- une modal permet de renseigner `Nom` et `Prenom` par speaker technique,
- le label affiche devient `Nom Prenom` (sans ID technique) dans la table.

Les assignations sont:

- scope session uniquement (pas de persistance),
- separees par mode (`upload`, `mic`, `cloud`),
- purgees au nouveau run, reset session/app, ou reload.

Impact export speaker:

- `VTT`/`SRT`: prefixe inline `Speaker: texte`,
- `JSON`: champ `speaker` renomme selon assignation,
- `telemetry.json`: inchange.

## Fichiers techniques lies

- `src/hooks/useTranscriptionController.ts`
- `src/lib/asr.ts`
- `src/lib/preprocessing.ts`
- `src/lib/chunking.ts`
- `src/lib/export.ts`
