import { waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const backendApiMocks = vi.hoisted(() => ({
  backendFetch: vi.fn(),
  parseBackendJson: vi.fn(),
  readBackendError: vi.fn(),
}))

const backendAuthMocks = vi.hoisted(() => ({
  backendRefresh: vi.fn(),
}))

vi.mock("@/lib/runtime-config", () => ({
  isBackendMode: () => true,
}))

vi.mock("@/lib/auth", () => ({
  isAuthenticated: () => true,
}))

vi.mock("@/lib/backend-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend-api")>("@/lib/backend-api")
  return {
    ...actual,
    backendFetch: (...args: unknown[]) => backendApiMocks.backendFetch(...args),
    parseBackendJson: (...args: unknown[]) => backendApiMocks.parseBackendJson(...args),
    readBackendError: (...args: unknown[]) => backendApiMocks.readBackendError(...args),
  }
})

vi.mock("@/lib/backend-auth", () => ({
  backendRefresh: (...args: unknown[]) => backendAuthMocks.backendRefresh(...args),
}))

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

import { trackBackendPerformanceSummary } from "@/lib/backend-performance-sync"
import type { TelemetrySummary } from "@/lib/telemetry"

describe("backend-performance-sync", () => {
  beforeEach(() => {
    backendApiMocks.backendFetch.mockReset()
    backendApiMocks.parseBackendJson.mockReset()
    backendApiMocks.readBackendError.mockReset()
    backendAuthMocks.backendRefresh.mockReset()
    window.localStorage.clear()
  })

  it("queues only tracked timings and flushes them to the backend", async () => {
    backendApiMocks.backendFetch.mockResolvedValue(
      new Response(JSON.stringify({ accepted: 2, duplicates: 0, rejected: [] }), { status: 200 }),
    )
    backendApiMocks.parseBackendJson.mockResolvedValue({
      accepted: 2,
      duplicates: 0,
      rejected: [],
    })

    const summary: TelemetrySummary = {
      sessionId: "session-1",
      createdAt: "2026-04-04T10:00:00.000Z",
      userAgent: "test-agent",
      transformersVersion: "4.0.0",
      backend: "webgpu",
      modelId: "model-1",
      timings: {
        load_model_total: 1234,
        llm_local_total: 4567,
        ignored_timer: 9999,
      },
      chunks: [],
      events: [],
      memorySnapshots: [],
      alerts: {},
    }

    trackBackendPerformanceSummary(summary, {
      status: "success",
      route: "/llmlocal",
      traceId: "trace-performance",
      meta: {
        sourceMode: "text",
      },
    })

    await waitFor(() => expect(backendApiMocks.backendFetch).toHaveBeenCalledTimes(1))

    const [path, init] = backendApiMocks.backendFetch.mock.calls[0] ?? []
    expect(path).toBe("/performance/events")
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    })

    const payload = JSON.parse(String((init as RequestInit).body)) as {
      events: Array<{
        component: string
        task: string
        status: string
        route: string
        traceId: string
        surface: string
        meta: { timingKey: string }
      }>
    }
    expect(payload.events).toHaveLength(2)
    expect(payload.events.map((event) => event.task)).toEqual(["load_model_total", "llm_local_total"])
    expect(payload.events.every((event) => event.surface === "frontend")).toBe(true)
    expect(payload.events[0]?.route).toBe("/llmlocal")
    expect(payload.events[0]?.traceId).toBe("trace-performance")
    expect(payload.events[0]?.meta.timingKey).toBe("load_model_total")
  })
})
