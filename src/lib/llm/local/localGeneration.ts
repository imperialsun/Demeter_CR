import { loadTransformers } from "@/lib/transformers-loader";
import logger from "@/lib/logger";
import type { BackendImplementation, ModelDtype } from "@/store/asr-store";

interface PipelineProgressPayload {
  progress?: number;
  status?: string;
  file?: string;
}

interface TextGenerationPipeline {
  (
    prompt: string,
    options?: {
      max_new_tokens?: number;
      temperature?: number;
      do_sample?: boolean;
      return_full_text?: boolean;
    }
  ): Promise<unknown>;
  dispose?: () => void | Promise<void>;
}

interface CreatePipelineFn {
  (task: "text-generation", model?: string, options?: Record<string, unknown>): Promise<TextGenerationPipeline>;
}

export interface GenerateLocalTextParams {
  modelId: string;
  backend: BackendImplementation;
  dtype: ModelDtype;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
  onLoadProgress?: (payload: PipelineProgressPayload) => void;
}

const cachedPipelines = new Map<string, Promise<TextGenerationPipeline>>();

function buildPipelineCacheKey(modelId: string, backend: BackendImplementation, dtype: ModelDtype): string {
  return `${modelId}::${backend}::${dtype}`;
}

export async function generateLocalText(params: GenerateLocalTextParams): Promise<string> {
  const modelId = params.modelId.trim();
  if (!modelId) {
    throw new Error("Model ID local manquant.");
  }

  const pipeline = await getOrCreatePipeline({
    modelId,
    backend: params.backend,
    dtype: params.dtype,
    onLoadProgress: params.onLoadProgress,
  });

  const prompt = buildPrompt(pipeline, params.systemPrompt, params.userPrompt);

  const maxTokens = sanitizeMaxTokens(params.maxTokens);
  const temperature = sanitizeTemperature(params.temperature);

  const output = await pipeline(prompt, {
    max_new_tokens: maxTokens,
    temperature,
    do_sample: temperature > 0,
    return_full_text: false,
  });

  const generated = extractGeneratedText(output);
  if (!generated) {
    throw new Error("Le modele local a retourne une reponse vide.");
  }

  return generated;
}

export async function disposeLocalGenerationPipelines() {
  const pipelines = Array.from(cachedPipelines.values());
  cachedPipelines.clear();

  await Promise.all(
    pipelines.map(async (pipelinePromise) => {
      try {
        const pipeline = await pipelinePromise;
        await pipeline.dispose?.();
      } catch (error) {
        logger.warn("[llm-local] pipeline dispose failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })
  );
}

async function getOrCreatePipeline(params: {
  modelId: string;
  backend: BackendImplementation;
  dtype: ModelDtype;
  onLoadProgress?: (payload: PipelineProgressPayload) => void;
}) {
  const cacheKey = buildPipelineCacheKey(params.modelId, params.backend, params.dtype);
  const cached = cachedPipelines.get(cacheKey);
  if (cached) return cached;

  const created = createPipeline(params).catch((error) => {
    cachedPipelines.delete(cacheKey);
    throw error;
  });

  cachedPipelines.set(cacheKey, created);
  return created;
}

async function createPipeline(params: {
  modelId: string;
  backend: BackendImplementation;
  dtype: ModelDtype;
  onLoadProgress?: (payload: PipelineProgressPayload) => void;
}): Promise<TextGenerationPipeline> {
  const { pipeline } = await loadTransformers();
  const createPipeline = pipeline as unknown as CreatePipelineFn;

  const pipelineOptions: Record<string, unknown> = {
    device: params.backend,
    progress_callback: (payload: PipelineProgressPayload) => {
      params.onLoadProgress?.(payload);
      if (payload.file) {
        logger.info("[llm-local][model-fetch]", {
          file: payload.file,
          status: payload.status,
          progress: payload.progress,
        });
      }
    },
  };

  if (params.dtype !== "auto") {
    pipelineOptions.dtype = params.dtype;
  }

  if (params.backend === "wasm") {
    pipelineOptions.session_options = {
      executionProviders: [
        {
          name: "wasm",
          options: {
            wasmPaths: "/onnx/",
            numThreads: 1,
            proxy: true,
            simd: true,
            useJsep: false,
          },
        },
      ],
    };
  }

  logger.info("[llm-local] create text-generation pipeline", {
    modelId: params.modelId,
    backend: params.backend,
    dtype: params.dtype,
  });

  return createPipeline("text-generation", params.modelId, pipelineOptions);
}

function extractGeneratedText(output: unknown): string {
  if (typeof output === "string") return output.trim();

  if (Array.isArray(output) && output.length > 0) {
    const first = output[0] as Record<string, unknown>;
    if (typeof first?.generated_text === "string") {
      return first.generated_text.trim();
    }
    if (typeof first?.text === "string") {
      return first.text.trim();
    }
  }

  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.generated_text === "string") {
      return record.generated_text.trim();
    }
    if (typeof record.text === "string") {
      return record.text.trim();
    }
    if (typeof record.output_text === "string") {
      return record.output_text.trim();
    }
  }

  return "";
}

function buildPrompt(pipeline: TextGenerationPipeline, systemPrompt: string, userPrompt: string): string {
  const maybeTokenizer = (pipeline as unknown as {
    tokenizer?: {
      apply_chat_template?: (
        messages: Array<{ role: "system" | "user"; content: string }>,
        options?: { tokenize?: boolean; add_generation_prompt?: boolean }
      ) => string;
    };
  }).tokenizer;

  const applyChatTemplate = maybeTokenizer?.apply_chat_template;
  if (typeof applyChatTemplate === "function") {
    try {
      const templated = applyChatTemplate(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        { tokenize: false, add_generation_prompt: true }
      );
      if (typeof templated === "string" && templated.trim().length > 0) {
        return templated;
      }
    } catch (error) {
      logger.warn("[llm-local] apply_chat_template failed, using fallback prompt", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return [
    "System:",
    systemPrompt,
    "",
    "User:",
    userPrompt,
    "",
    "Assistant:",
  ].join("\n");
}

function sanitizeMaxTokens(value: number): number {
  if (!Number.isFinite(value)) return 512;
  return Math.max(64, Math.min(8192, Math.round(value)));
}

function sanitizeTemperature(value: number): number {
  if (!Number.isFinite(value)) return 0.2;
  return Math.max(0, Math.min(2, value));
}
