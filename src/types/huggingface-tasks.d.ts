declare module "@huggingface/tasks" {
  export interface AutomaticSpeechRecognitionParameters {
    generation_parameters?: {
      max_new_tokens?: number;
      temperature?: number;
      top_p?: number;
      do_sample?: boolean;
    };
    return_timestamps?: boolean;
  }

  export interface AutomaticSpeechRecognitionOutput {
    text?: string;
    chunks?: Array<{
      text?: string;
      timestamp?: [number, number] | Array<number | null> | null;
    }>;
  }
}
