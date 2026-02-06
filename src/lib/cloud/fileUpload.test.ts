import { describe, it, expect, vi } from "vitest";
import { FileData, type Client } from "@gradio/client";
import { makeSafeFilename, uploadCloudFile } from "./fileUpload";

describe("makeSafeFilename", () => {
  it("normalizes accents and strips unsafe characters", () => {
    expect(makeSafeFilename("L'Îran test.mp3")).toBe("L_Iran_test.mp3");
  });

  it("falls back to audio when nothing remains", () => {
    expect(makeSafeFilename("!!!")).toBe("audio");
  });
});

describe("uploadCloudFile", () => {
  it("uploads and returns FileData with preserved metadata", async () => {
    const uploadSpy = vi.fn(async () => [
      new FileData({
        path: "tmp/upload.wav",
        url: "https://example.com/api/file=tmp/upload.wav",
      }),
    ]);
    const client = { upload: uploadSpy } as unknown as Client;
    const file = new File(["abc"], "Mon fichier.wav", { type: "audio/wav" });

    const result = await uploadCloudFile({
      client,
      file,
      rootUrl: "https://example.com/",
      telemetry: null,
    });

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const firstCall = uploadSpy.mock.calls[0] as unknown as [unknown[], string] | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      return;
    }
    const [filesArg, rootArg] = firstCall;
    expect(rootArg).toBe("https://example.com");
    expect(Array.isArray(filesArg)).toBe(true);
    const prepared = filesArg[0] as FileData;
    expect(prepared.orig_name).toBe(file.name);
    expect(prepared.mime_type).toBe(file.type);
    expect(result).toBeInstanceOf(FileData);
    expect(result.orig_name).toBe(file.name);
    expect(result.mime_type).toBe(file.type);
    expect(result.size).toBe(file.size);
  });

  it("throws when upload returns no file data", async () => {
    const uploadSpy = vi.fn(async () => null);
    const client = { upload: uploadSpy } as unknown as Client;
    const file = new File(["abc"], "audio.wav", { type: "audio/wav" });

    await expect(
      uploadCloudFile({ client, file, rootUrl: "https://example.com", telemetry: null })
    ).rejects.toThrow("Upload response missing file data");
  });
});
