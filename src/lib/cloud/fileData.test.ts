import { describe, it, expect } from "vitest";
import { FileData } from "@gradio/client";
import { normalizeFileData } from "./fileData";

describe("normalizeFileData", () => {
  it("returns FileData instances untouched", () => {
    const data = new FileData({ path: "tmp/audio.wav", orig_name: "audio.wav" });
    expect(normalizeFileData(data)).toBe(data);
  });

  it("unwraps update objects", () => {
    const normalized = normalizeFileData({
      __type__: "update",
      value: { path: "tmp/audio.wav", orig_name: "audio.wav", size: 12, mime_type: "audio/wav" },
    });
    expect(normalized).toBeInstanceOf(FileData);
    expect(normalized?.path).toBe("tmp/audio.wav");
    expect(normalized?.orig_name).toBe("audio.wav");
    expect(normalized?.mime_type).toBe("audio/wav");
  });

  it("handles plain FileData-like objects", () => {
    const normalized = normalizeFileData({
      path: "tmp/audio.wav",
      url: "https://example.com/file=tmp/audio.wav",
      orig_name: "audio.wav",
      size: 123,
      mime_type: "audio/wav",
      meta: { _type: "gradio.FileData" },
    });
    expect(normalized).toBeInstanceOf(FileData);
    expect(normalized?.path).toBe("tmp/audio.wav");
    expect(normalized?.orig_name).toBe("audio.wav");
    expect(normalized?.mime_type).toBe("audio/wav");
  });

  it("returns null when missing path", () => {
    expect(normalizeFileData({})).toBeNull();
  });
});
