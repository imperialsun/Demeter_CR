# Copilot / AI agent instructions — Test transformer js

Quick facts
- Run locally: `npm run dev` (Vite); build with `npm run build`; preview production bundle with `npm run preview`.
- Lint: `npm run lint` (ESLint configured in `eslint.config.js`).
- No unit tests shipped; be careful when adding heavy external deps (transformers) — they are dynamically imported.

Big-picture architecture
- Frontend: React + TypeScript + Vite (single-page app). Entry: `src/main.tsx` → `src/App.tsx` → route pages (`src/routes/*`).
- ASR domain logic lives under `src/lib/`:
  - `asr.ts` — pipeline creation (`createAsrPipeline`), WASM/webgpu fallback, `transcribeChunk` (core transcription loop).
  - `transformers-loader.ts` — dynamic import of `@huggingface/transformers` and environment configuration (cache, wasm paths, default backend settings).
  - `ort-wasm.ts` — runtime patches for onnxruntime-web to force WASM providers or modify wasm env.
  - `backend-support.ts` — feature detection (WebGPU, WASM assets, multithread test).
  - `audio.ts`, `preprocessing.ts`, `chunking.ts`, `silence.ts` — audio decoding, preprocessing (noise/gate), and chunk planning.
- State & persistence: Zustand store at `src/store/asr-store.ts` (settings persisted to localStorage via `src/lib/storage.ts`, key `demeter-asr-settings`).
- Telemetry: `src/lib/telemetry.ts` provides `TelemetryCollector` and event names used across the system (`START_LOAD_MODEL`, `PROGRESS_MODEL`, `READY`, `ERROR`, etc.).

Important patterns & conventions (project-specific)
- Dynamic heavy imports: `@huggingface/transformers` is loaded lazily (see `loadTransformers()`), and environment mutation happens immediately after import; prefer modifying `transformers-loader.ts` rather than sprinkling global patches elsewhere.
- ONNX/WASM defaults: `transformers-loader.configureEnvironment` sets `allowLocalModels = false` and `useBrowserCache = true` by default. To allow local model testing set `allowLocalModels = true` here.
- WASM threads & cross-origin isolation: multithreaded WASM requires COOP/COEP and `SharedArrayBuffer`; see `backend-support.testWasmMultithreadSupport()` and error messages in `createAsrPipeline` when threads fail (the app will fall back to single-thread and set `forceSingleThread` in the store).
- Assets: WASM files are expected in `public/onnx/` (e.g., `ort-wasm-simd-threaded.wasm`). `backend-support.checkWasmAssets()` checks for them; missing files cause the app to skip WASM.
- Persisted settings: defaults are in `src/lib/storage.ts` → `DEFAULT_SETTINGS`. To change default backend/model presets edit `src/store/asr-store.ts` (`MODEL_PRESETS`) and `DEFAULT_SETTINGS`.
- Telemetry-first diagnostic flow: long operations call telemetry timers & events (e.g., `TelemetryCollector.startTimer('load_model_total')`). Use these events to reproduce and debug performance or failure cases.
- Debug logging: look for console logs with markers: `ASR model load start`, `ASR pipeline init`, `[model-fetch]`, `ASR model load success`, and `Échec initialisation backend` for failure context.

Logging & Telemetry requirements (for AI agents)
- **Always** add verbose instrumentation to any new or modified code: log to the console and emit telemetry events where appropriate.
  - Console: use `console.info`, `console.debug`, `console.warn`, and `console.error` with clear markers and structured objects, e.g. `console.info("ASR model load start", { modelId, backend })`.
  - Telemetry: accept a `TelemetryCollector` (or use `useAsrStore.getState().telemetryCollector`) and call `telemetry?.logEvent("EVENT_NAME", { ...meta })`, `telemetry?.startTimer(...)` / `telemetry?.stopTimer(...)`, `telemetry?.recordAlert(...)`, and `telemetry?.snapshotMemory(...)` for long-running or failure conditions.
  - Use existing telemetry event names where applicable (`START_LOAD_MODEL`, `PROGRESS_MODEL`, `READY`, `ERROR`, `WASM_MULTITHREAD_UNAVAILABLE`, `PREPROCESS_AUTOTUNE`, `RAM_USAGE`, etc.) to keep analytics consistent.
  - For exceptions and recoverable fallbacks, always log both a console message and a corresponding telemetry `ERROR` or `ALERT` event with contextual data.
  - Be mindful to avoid logging sensitive data (do not include raw audio content or full user files); prefer identifiers (`fileName`, `chunkId`, `modelId`) and metrics (timings, sizes, memory usage).
  - Example pattern for a long operation:
    - `console.info("ASR model load start", { modelId, backendPreference });`
    - `telemetry?.startTimer("load_model_total");`
    - on progress: `console.debug("ASR model progress", { progress }); telemetry?.logEvent("PROGRESS_MODEL", { progress, backend });`
    - on ready: `telemetry?.stopTimer("load_model_total"); telemetry?.logEvent("READY", { backend }); console.info("ASR model load success", { backend, modelId });`

Developer workflows & debugging tips
- Reproduce model-load issues: open DevTools Network and Console to see resource fetches and the console logs above. The model loader records resource timing entries and logs cached vs downloaded files.
- Simulate WebGPU/WASM: `backend-support.detectWebGpuSupport()` is used to set `webGpuSupported`. You can override `useAsrStore.getState().setWebGpuSupport(false)` in the console to force WASM path.
- For WASM multithread failures, check server response headers (COOP/COEP) if you need threaded WASM; otherwise the code retries single-thread and persists fallback (`forceSingleThread`).
- Use `TelemetryCollector` for reproducible instrumentation. Example: `const t = new TelemetryCollector(); createAsrPipeline({... , telemetry: t, onStatus:..., onProgress: ...})`.

Required pre-commit checks & commit policy (FR: Règles de pré-commit)
- Avant de committer: **toujours** exécuter et faire réussir la build, le lint, et les tests, et corriger les erreurs:
  - `npm run build` (TypeScript compile + `vite build`) — corriger toutes les erreurs de compilation.
  - `npm run lint` — corriger toutes les erreurs signalées par ESLint.
  - `npm run test` — exécuter la suite de tests (voir section "Testing & validation" ci-dessous). Utilisez `npm run test:ci` si vous avez un script CI pour exécuter tests en mode headless/CI.
- Avant d'apposer un commit ou de pousser des modifications, présenter à l'utilisateur:
  - la diff (`git diff --staged` / `git show`),
  - les sorties de `npm run build`, `npm run lint` et `npm run test`.
  Obtenir une **validation explicite** de l'utilisateur (par exemple: « j'approuve, fais le commit ») **avant** d'exécuter `git commit` / `git push`.
- Si la build, le lint, ou les tests échouent, documenter l'erreur, proposer une remediation et ne pas effectuer de commit tant que les checks ne sont pas passés.

Testing & validation
- **Requirement:** pour chaque nouvelle fonction ou modification, **ajoutez des tests unitaires** qui couvrent les comportements modifiés. Les tests sont obligatoires et doivent être exécutés et validés avant le commit.
- **Recommandation d'outil:** ce projet ne contient pas encore de framework de test. Nous recommandons **Vitest** pour les tests unitaires (rapide et compatible Vite/TS). Exemple d'ajout minimal :
  - `npm install -D vitest @testing-library/react @testing-library/jest-dom`
  - Ajouter un script `"test": "vitest"` et `"test:ci": "vitest --run"` dans `package.json`.
- **Guidelines de test:**
  - Favorisez les tests unitaires rapides et déterministes. Mockez les APIs lourdes (transformers, WebGPU) pour tests locaux.
  - Ecrire des tests pour chaque utilitaire ajouté dans `src/lib/` (p.ex. `chunking`, `preprocessing`, `audio` helpers).
  - Pour modifications critiques (WASM threading, model loading), ajouter tests d'intégration manuels ou des tests end-to-end documentés dans la PR.
  - Si vous ne pouvez pas ajouter un test automatisé (p.ex. besoin d'assets externes), documentez un test manuel reproductible dans la description de la PR.
- **Validation avant commit:** joindre les sorties de `npm run test` (et `npm run build` / `npm run lint`) à la demande d'approbation. Le commit ne doit pas être fait tant que la suite de tests ne passe pas.

Where to change things (examples)
- Add or edit model presets: `src/store/asr-store.ts` → `MODEL_PRESETS`.
- Change default settings (persisted): `src/lib/storage.ts` → `DEFAULT_SETTINGS`.
- Modify transformers/ONNX environment defaults: `src/lib/transformers-loader.ts` and `src/lib/ort-wasm.ts` (use `patchOrtWasmEnv` and `flagWasmSessionOptions` helpers).
- Adjust chunking logic: `src/lib/chunking.ts` (used by both progressive and full decode flows in `useTranscriptionController`).

Do's & Don'ts for AI edits
- DO reference the concrete files above and prefer small, targeted edits (easier to test in-browser). Use the telemetry hooks and console logs to verify behavior.
- DO NOT assume COOP/COEP headers; check `backend-support.testWasmMultithreadSupport()` behavior instead of guessing.
- DO avoid changing global dynamic import behavior lightly — tests and runtime are sensitive to the transformers env configuration.

Modularity, portability & optimization (requirements)
- Prefer small, single-responsibility functions and clear module boundaries. When adding logic, expose it as a pure helper in `src/lib/` so it can be reused and unit-tested (e.g. put chunking helpers in `src/lib/chunking.ts`, preprocessing helpers in `src/lib/preprocessing.ts`).
- Use dependency injection where possible: accept a `TelemetryCollector` or `telemetry?: TelemetryCollector` param rather than grabbing global state; accept `sessionOptions` and config objects rather than reading globals.
- Avoid DOM or window-only APIs in core logic; keep audio processing, chunking, and model init code portable (so they can run in Workers or Node tests). Use `typeof window !== 'undefined'` guards where unavoidable.
- Performance best-practices:
  - Minimize copies of large TypedArrays: use `subarray()`/views and reuse buffers when processing chunks.
  - Favor progressive/streaming flows (`decodeFileProgressively`) for large inputs to keep memory bounded and measurable.
  - Use telemetry timers and `snapshotMemory()` to capture before/after snapshots for critical changes.
  - When changing threading or WASM options, measure memory and time (console + telemetry) and document results in the PR.
- When adding heavy/optional dependencies, prefer dynamic import and keep them behind loader modules (pattern in `src/lib/transformers-loader.ts`). Document runtime cost and usage examples in the module comment.
- Optimization requirement during edits: whenever you modify or add code, look for local micro-optimizations (reducing allocations, simplifying hot loops, avoiding redundant async/wait on hot paths) and add a short note in the PR describing what you changed and why.
- Add test or manual verification steps for changes that affect performance or correctness (e.g., sample files and telemetry output to compare). If you can't add unit tests, add a reproducible manual test in the PR description.

If anything is unclear or you want more details (examples of common debugging sessions, or instrumentation snippets), tell me which area to expand and I will iterate.  

