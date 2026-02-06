import { FileData } from "@gradio/client";

function buildFileData(value: {
  path?: string;
  url?: string;
  orig_name?: string;
  size?: number;
  mime_type?: string;
}) {
  if (!value.path) {
    return null;
  }
  return new FileData({
    path: value.path,
    url: value.url,
    orig_name: value.orig_name,
    size: value.size,
    mime_type: value.mime_type,
  });
}

export function normalizeFileData(value: unknown): FileData | null {
  if (!value) {
    return null;
  }
  if (value instanceof FileData) {
    return value;
  }
  if (typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.__type__ === "update" && "value" in candidate) {
    return normalizeFileData(candidate.value);
  }
  if (candidate.meta && typeof candidate.meta === "object" && (candidate.meta as Record<string, unknown>)._type === "gradio.FileData") {
    return buildFileData({
      path: candidate.path as string | undefined,
      url: candidate.url as string | undefined,
      orig_name: candidate.orig_name as string | undefined,
      size: candidate.size as number | undefined,
      mime_type: candidate.mime_type as string | undefined,
    });
  }
  return buildFileData({
    path: candidate.path as string | undefined,
    url: candidate.url as string | undefined,
    orig_name: candidate.orig_name as string | undefined,
    size: candidate.size as number | undefined,
    mime_type: candidate.mime_type as string | undefined,
  });
}
