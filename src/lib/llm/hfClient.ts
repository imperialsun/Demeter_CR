import logger from "@/lib/logger";

type MinimalHfClient = {
  chatCompletion: (...args: unknown[]) => Promise<unknown>;
  textGeneration: (...args: unknown[]) => Promise<unknown>;
};

let cachedToken: string | null = null;
let clientPromise: Promise<MinimalHfClient> | null = null;
let modulePromise: Promise<typeof import("@huggingface/inference")> | null = null;
const CONVERSATIONAL_FALLBACK_MAX_TOKENS = 8192;

export type GenerationStrategy = "chatCompletion" | "textGeneration";

export interface GenerateWithFallbackParams {
  client: MinimalHfClient;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  responseMode?: "json" | "text";
  provider?: "auto" | "hf-inference" | string;
  maxRetries?: number;
  initialBackoffMs?: number;
}

export interface GenerateWithFallbackResult {
  text: string;
  strategy: GenerationStrategy;
}

async function loadInferenceModule() {
  if (!modulePromise) {
    modulePromise = import("@huggingface/inference");
  }
  return modulePromise;
}

export async function getLlmHfClient(token: string) {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error("Token Hugging Face manquant.");
  }

  if (!clientPromise || cachedToken !== trimmed) {
    cachedToken = trimmed;
    clientPromise = (async () => {
      const { InferenceClient } = await loadInferenceModule();
      logger.info("[llm-api] init Hugging Face client", { tokenLength: trimmed.length });
      return new InferenceClient(trimmed) as unknown as MinimalHfClient;
    })();
  }

  return clientPromise;
}

export async function generateWithChatThenFallbackText(
  params: GenerateWithFallbackParams
): Promise<GenerateWithFallbackResult> {
  const provider = params.provider?.trim() || "auto";
  const modelId = params.modelId.trim();
  if (!modelId) {
    throw new Error("Model ID manquant.");
  }

  const maxTokens = sanitizeMaxTokens(params.maxTokens);
  const temperature = sanitizeTemperature(params.temperature);
  const responseMode = params.responseMode ?? "json";
  const maxRetries = params.maxRetries ?? 2;
  const initialBackoffMs = params.initialBackoffMs ?? 700;

  try {
    try {
      logger.info("[llm-api] chatCompletion start", {
        modelId,
        provider,
        maxTokens,
        temperature,
      });
      const chatContent = await runChatCompletion({
        client: params.client,
        modelId,
        provider,
        systemPrompt: params.systemPrompt,
        userPrompt: params.userPrompt,
        maxTokens,
        temperature,
        maxRetries,
        initialBackoffMs,
      });

      logger.info("[llm-api] chatCompletion success", {
        modelId,
        provider,
        maxTokens,
        strategy: "chatCompletion",
        textLength: chatContent.length,
      });
      return { text: chatContent, strategy: "chatCompletion" };
    } catch (chatError) {
      if (isMissingProviderInfoError(chatError)) {
        throw chatError;
      }
      logger.warn("[llm-api] chatCompletion failed, fallback textGeneration", {
        message: toErrorMessage(chatError),
      });

      let textResponse: unknown;
      try {
        logger.info("[llm-api] textGeneration start", {
          modelId,
          provider,
          maxTokens,
          temperature,
        });
        textResponse = await withRetry(
          async () =>
            params.client.textGeneration({
              model: modelId,
              provider,
              inputs: buildFallbackInputs(params.systemPrompt, params.userPrompt, responseMode),
              parameters: {
                max_new_tokens: maxTokens,
                temperature,
                return_full_text: false,
              },
            }),
          maxRetries,
          initialBackoffMs
        );
      } catch (textError) {
        if (isConversationalOnlyTaskError(textError)) {
          const reducedMaxTokens = Math.min(maxTokens, CONVERSATIONAL_FALLBACK_MAX_TOKENS);
          logger.warn("[llm-api] text-generation unsupported for conversational model, retrying chatCompletion", {
            modelId,
            provider,
            originalMaxTokens: maxTokens,
            retryMaxTokens: reducedMaxTokens,
          });

          try {
            const chatContent = await runChatCompletion({
              client: params.client,
              modelId,
              provider,
              systemPrompt: params.systemPrompt,
              userPrompt: params.userPrompt,
              maxTokens: reducedMaxTokens,
              temperature,
              maxRetries,
              initialBackoffMs,
            });
            return { text: chatContent, strategy: "chatCompletion" };
          } catch (retryChatError) {
            throw new Error(
              `Le modele ${modelId} est servi en mode conversation uniquement chez ce provider. La generation text-generation n'est pas disponible. Echec chat: ${toErrorMessage(
                retryChatError
              )}`,
              { cause: retryChatError }
            );
          }
        }
        throw textError;
      }

      const content = extractGeneratedText(textResponse);
      if (!content) {
        throw new Error("Le modele a retourne une reponse textGeneration vide.", {
          cause: chatError,
        });
      }
      logger.info("[llm-api] textGeneration success", {
        modelId,
        provider,
        strategy: "textGeneration",
        textLength: content.length,
      });

      return { text: content, strategy: "textGeneration" };
    }
  } catch (error) {
    if (isInferenceProvidersSubscriptionError(error) && provider !== "hf-inference") {
      logger.warn("[llm-api] provider access requires PRO, retrying on hf-inference", {
        modelId,
        previousProvider: provider,
      });
      try {
        return await generateWithChatThenFallbackText({
          ...params,
          provider: "hf-inference",
        });
      } catch (fallbackError) {
        if (isMissingProviderInfoError(fallbackError) || isNoHfInferenceProviderError(fallbackError)) {
          throw new Error(
            `Votre compte Hugging Face n'a pas acces aux Inference Providers (PRO requis) et ${modelId} n'est pas disponible sur hf-inference. Choisissez un autre modele ou activez PRO.`,
            { cause: fallbackError }
          );
        }
        throw fallbackError;
      }
    }

    if (isMissingProviderInfoError(error)) {
      throw new Error(
        `Aucun provider HF Inference n'est disponible pour ${modelId}. Essayez un autre modele suggere (ex: openai/gpt-oss-120b) ou utilisez un endpoint dedie.`,
        { cause: error }
      );
    }
    throw error;
  }
}

async function runChatCompletion(params: {
  client: MinimalHfClient;
  modelId: string;
  provider: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
  maxRetries: number;
  initialBackoffMs: number;
}): Promise<string> {
  const chatResponse = await withRetry(
    async () =>
      params.client.chatCompletion({
        model: params.modelId,
        provider: params.provider,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userPrompt },
        ],
        max_tokens: params.maxTokens,
        temperature: params.temperature,
      }),
    params.maxRetries,
    params.initialBackoffMs
  );

  const content = extractChatContent(chatResponse);
  if (!content) {
    throw new Error("Le modele a retourne une reponse chat vide.");
  }
  return content;
}

async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number,
  initialBackoffMs: number
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableError(error) || attempt >= maxRetries) {
        throw error;
      }
      const delayMs = initialBackoffMs * 2 ** attempt;
      attempt += 1;
      logger.warn("[llm-api] retrying Hugging Face call", {
        attempt,
        delayMs,
        reason: toErrorMessage(error),
      });
      await sleep(delayMs);
    }
  }
}

function extractChatContent(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const record = response as Record<string, unknown>;
  const directOutput = record.output_text ?? record.generated_text ?? record.content;
  const directOutputText = normalizeChatContent(directOutput);
  if (directOutputText) return directOutputText;

  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const firstRecord = first as Record<string, unknown>;

  const choiceText = normalizeChatContent(firstRecord.text);
  if (choiceText) return choiceText;

  const message = firstRecord.message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  return normalizeChatContent(content);
}

function extractGeneratedText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const record = response as Record<string, unknown>;
  const generatedText = record.generated_text;
  if (typeof generatedText === "string") {
    return generatedText.trim();
  }
  if (Array.isArray(response) && response.length > 0) {
    const first = response[0] as Record<string, unknown>;
    const value = first?.generated_text;
    if (typeof value === "string") return value.trim();
  }
  return "";
}

function sanitizeMaxTokens(value: number): number {
  if (!Number.isFinite(value)) return 2048;
  return Math.max(128, Math.min(131072, Math.round(value)));
}

function sanitizeTemperature(value: number): number {
  if (!Number.isFinite(value)) return 0.2;
  return Math.max(0, Math.min(2, value));
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const status =
    (error as { status?: unknown }).status ??
    (error as { response?: { status?: unknown } }).response?.status ??
    (error as { cause?: { status?: unknown } }).cause?.status;

  if (status === 429 || status === 503) return true;

  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("503") ||
    message.includes("rate limit") ||
    message.includes("temporarily unavailable")
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isMissingProviderInfoError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("have not been able to find inference provider information for model") ||
    message.includes("unable to find inference provider information for model")
  );
}

function isConversationalOnlyTaskError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("not supported for task text-generation") && message.includes("supported task: conversational");
}

function isInferenceProvidersSubscriptionError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("subscribe to pro to use inference providers with your account") ||
    message.includes("upgrade to pro to use inference providers")
  );
}

function isNoHfInferenceProviderError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("aucun provider hf inference n'est disponible pour");
}

function normalizeChatContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => {
        if (typeof part === "string") return part.trim();
        if (!part || typeof part !== "object") return "";
        const partText = (part as Record<string, unknown>).text;
        return typeof partText === "string" ? partText.trim() : "";
      })
      .filter(Boolean);
    return textParts.join("\n").trim();
  }

  if (content && typeof content === "object") {
    const maybeText = (content as Record<string, unknown>).text;
    if (typeof maybeText === "string") {
      return maybeText.trim();
    }
  }

  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFallbackInputs(systemPrompt: string, userPrompt: string, responseMode: "json" | "text"): string {
  const base = `${systemPrompt}\n\n${userPrompt}`;
  if (responseMode === "text") {
    return base;
  }
  return `${base}\n\nReponds uniquement en JSON valide.`;
}
