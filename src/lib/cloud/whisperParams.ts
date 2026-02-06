import type { AutomaticSpeechRecognitionParameters } from "@huggingface/tasks";

export type WhisperGenerationSettings = {
  maxTokens: number;
  temperature: number;
  topP: number;
  doSample: boolean;
  returnTimestamps: boolean;
};

export function buildWhisperParameters(
  settings: WhisperGenerationSettings
): AutomaticSpeechRecognitionParameters {
  const generation = {
    max_new_tokens: settings.maxTokens,
    temperature: settings.temperature,
    top_p: settings.topP,
    do_sample: settings.doSample,
  };
  const params: AutomaticSpeechRecognitionParameters = {
    generation_parameters: generation,
  };
  if (settings.returnTimestamps) {
    params.return_timestamps = true;
  }
  return params;
}
