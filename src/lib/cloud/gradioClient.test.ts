import { describe, it, expect, vi, beforeEach } from "vitest";
import { getGradioClient } from "./gradioClient";

const { connectSpy } = vi.hoisted(() => ({
  connectSpy: vi.fn(async (url: string) => ({ url })),
}));

vi.mock("@gradio/client", () => ({
  Client: {
    connect: connectSpy,
  },
}));

describe("getGradioClient", () => {
  beforeEach(() => {
    connectSpy.mockClear();
  });

  it("connects and caches the client", async () => {
    const client1 = await getGradioClient("https://example.com");
    const client2 = await getGradioClient("https://example.com");
    expect(client1).toEqual(client2);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledWith("https://example.com/");
  });

  it("throws on empty url", async () => {
    await expect(getGradioClient("")).rejects.toThrow("URL Gradio manquante");
  });
});
