declare module "onnxruntime-web" {
  export namespace InferenceSession {
    interface SessionOptions {
      executionProviders?: Array<string | { name?: string } | Record<string, unknown>>;
      [key: string]: unknown;
    }
  }

  export interface InferenceSession {}

  export const InferenceSession: {
    create(
      buffer: string | ArrayBufferLike | Uint8Array,
      options?: InferenceSession.SessionOptions
    ): Promise<InferenceSession>;
  };

  export const backend: {
    resolveBackendAndExecutionProviders(
      options?: InferenceSession.SessionOptions
    ): Promise<[unknown, InferenceSession.SessionOptions]>;
  };

  export const env: {
    allowLocalModels: boolean;
    useBrowserCache: boolean;
    backends: Record<string, any>;
  };
}
