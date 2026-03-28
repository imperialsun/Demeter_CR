/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Topbar } from './Topbar';
import { useAsrStore } from '@/store/asr-store';
import * as backendSupport from '@/lib/backend-support';
import * as backendSession from '@/lib/backend-session';
import * as toastMod from '@/components/ui/use-toast';
import * as exportLib from '@/lib/export';
import * as rr from 'react-router-dom';
import * as logger from '@/lib/logger';
import { DEMETER_SANTE_MAX_TOKENS } from '@/lib/llm/providerSettings';

const modelTestHook = vi.hoisted(() => ({
  runTest: vi.fn(),
  stopTest: vi.fn(),
  closeSummary: vi.fn(),
  state: {
    running: false,
    summaryOpen: false,
    stopRequested: false,
    progress: 0,
    progressLabel: undefined,
    currentPreset: null,
    currentBackend: null,
    step: 0,
    total: 0,
    results: [] as Array<{
      preset: string;
      label: string;
      backends: {
        webgpu: { status: "ok" | "testing" | "pending" | "too_large" | "error" | "skipped" | "unavailable"; durationMs?: number; message?: string };
        wasm: { status: "ok" | "testing" | "pending" | "too_large" | "error" | "skipped" | "unavailable"; durationMs?: number; message?: string };
      };
    }>,
  },
  summary: {
    ok: 0,
    blockedCount: 0,
    errors: 0,
  },
}));

const backendPermissionMocks = vi.hoisted(() => ({
  canAccessFeature: vi.fn((permission: string) => permission !== ""),
  getFirstAuthorizedRoute: vi.fn(() => "/localupload"),
}));

const backendAuthMocks = vi.hoisted(() => ({
  backendLogout: vi.fn(),
  backendChangePassword: vi.fn(),
}));

const runtimeConfigMocks = vi.hoisted(() => ({
  isBackendMode: vi.fn(() => false),
}));

// Mock react-router hooks used by the component
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const mod = await vi.importActual('react-router-dom');
  return {
    ...mod,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: '/localupload' }),
  };
});

vi.mock('@/hooks/useTranscriptionController', () => ({
  useTranscriptionController: () => ({ abortTranscription: vi.fn() }),
}));

vi.mock('@/lib/logger', () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  exportDiagnosticLogBundle: vi.fn((context: { session: Record<string, unknown>; settings: Record<string, unknown>; telemetry: unknown }) => ({
    schemaVersion: 1,
    exportedAt: '2026-03-19T12:34:56.000Z',
    session: context.session,
    settings: context.settings,
    telemetry: context.telemetry,
    logs: [
      {
        timestamp: 't1',
        level: 'info',
        origin: 'logger',
        scopes: ['test'],
        message: 'log',
        rawArgs: ['log'],
      },
    ],
    diagnostics: {
      persistenceStatus: 'complete',
    },
  })),
}));

vi.mock('@/lib/env', () => ({
  getEnvMode: vi.fn(() => 'test'),
}));

vi.mock('@/hooks/useModelCompatibilityTest', () => ({
  useModelCompatibilityTest: () => modelTestHook,
}));

vi.mock("@/hooks/useBackendPermissions", () => ({
  useBackendPermissions: () => ({}),
}));

vi.mock("@/lib/backend-auth", () => ({
  backendLogout: (...args: unknown[]) => backendAuthMocks.backendLogout(...args),
  backendChangePassword: (...args: unknown[]) => backendAuthMocks.backendChangePassword(...args),
}));

vi.mock("@/lib/backend-permissions", () => ({
  canAccessFeature: (...args: unknown[]) => backendPermissionMocks.canAccessFeature(...args),
  getFirstAuthorizedRoute: (...args: unknown[]) => backendPermissionMocks.getFirstAuthorizedRoute(...args),
}));

vi.mock("@/lib/runtime-config", () => ({
  isBackendMode: (...args: unknown[]) => runtimeConfigMocks.isBackendMode(...args),
}));

const BACKEND_AUTH_KEY = "demeter-backend-authenticated";
const BACKEND_SESSION_KEY = "demeter-backend-session";
const connectedEmail = "praticien@example.com";

describe('Topbar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockNavigate.mockReset();
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value: () => false,
    });
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    modelTestHook.runTest.mockReset();
    modelTestHook.stopTest.mockReset();
    modelTestHook.closeSummary.mockReset();
    modelTestHook.state.running = false;
    modelTestHook.state.summaryOpen = false;
    modelTestHook.state.stopRequested = false;
    modelTestHook.state.progress = 0;
    modelTestHook.state.progressLabel = undefined;
    modelTestHook.state.currentPreset = null;
    modelTestHook.state.currentBackend = null;
    modelTestHook.state.step = 0;
    modelTestHook.state.total = 0;
    modelTestHook.state.results = [];
    modelTestHook.summary.ok = 0;
    modelTestHook.summary.blockedCount = 0;
    modelTestHook.summary.errors = 0;
    backendPermissionMocks.canAccessFeature.mockReset();
    backendPermissionMocks.canAccessFeature.mockReturnValue(true);
    backendPermissionMocks.getFirstAuthorizedRoute.mockReset();
    backendPermissionMocks.getFirstAuthorizedRoute.mockReturnValue("/localupload");
    backendAuthMocks.backendLogout.mockReset();
    backendAuthMocks.backendLogout.mockResolvedValue(undefined);
    backendAuthMocks.backendChangePassword.mockReset();
    backendAuthMocks.backendChangePassword.mockResolvedValue(undefined);
    runtimeConfigMocks.isBackendMode.mockReset();
    runtimeConfigMocks.isBackendMode.mockReturnValue(false);
    window.localStorage.removeItem(BACKEND_AUTH_KEY);
    window.localStorage.removeItem(BACKEND_SESSION_KEY);
    // reset store defaults used by Topbar
    useAsrStore.setState({
      hasHydrated: false,
      activePreset: 'fast',
      customModelId: undefined,
      backendPreference: 'webgpu',
      activeBackend: undefined,
      status: 'idle',
      statusDetail: undefined,
      cloudStatus: 'idle',
      cloudStatusDetail: undefined,
      llmApiProvider: 'huggingface',
      llmApiHfModelId: 'openai/gpt-oss-20b',
      llmApiHfTemperature: 0.2,
      llmApiHfMaxTokens: 131072,
      llmApiMistralModelId: 'mistral-medium-latest',
      llmApiMistralTemperature: 0.2,
      llmApiMistralMaxTokens: 8192,
      telemetryCollector: null,
      telemetrySummary: null,
      audioSource: null,
      audioMetadata: null,
      webGpuSupported: true,
      wasmAvailable: true,
      wasmThreads: 1,
      preprocessingMode: 'fast',
      logLevel: 'info',
      setLogLevel: (v: string) => useAsrStore.setState({ logLevel: v as any }),
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('navigates to /settings when settings button clicked and not already on settings', () => {
    render(<Topbar />);
    const btn = screen.getByLabelText('Aller aux paramètres');
    fireEvent.click(btn);
    expect(mockNavigate).toHaveBeenCalledWith('/settings');
  });

  it('navigates to first authorized route when on settings', () => {
    // override useLocation to simulate being on /settings
    vi.spyOn(rr, 'useLocation').mockReturnValue({ pathname: '/settings', search: '', state: null, hash: '', key: '' } as any);
    backendPermissionMocks.getFirstAuthorizedRoute.mockReturnValue("/llmapi");
    render(<Topbar />);
    const btn = screen.getByLabelText('Aller aux paramètres');
    fireEvent.click(btn);
    expect(mockNavigate).toHaveBeenCalledWith('/llmapi');
  });

  it("hides settings button when feature.settings is forbidden", () => {
    backendPermissionMocks.canAccessFeature.mockImplementation((permission: string) =>
      permission === "feature.settings" ? false : true
    );

    render(<Topbar />);

    expect(screen.queryByLabelText("Aller aux paramètres")).toBeNull();
  });

  it("shows the connected email in backend mode when a session exists", () => {
    runtimeConfigMocks.isBackendMode.mockReturnValue(true);
    vi.spyOn(backendSession, "getBackendSession").mockReturnValue({
      user: { id: "user-1", email: connectedEmail, status: "active" },
      organization: { id: "org-1", name: "Org", code: "ORG", status: "active" },
      globalRoles: ["user"],
      orgRoles: ["org_member"],
      permissions: ["feature.localupload"],
    });

    render(<Topbar />);

    expect(screen.getByRole("button", { name: connectedEmail })).toBeInTheDocument();
  });

  it("does not show the email in standalone mode", () => {
    vi.spyOn(backendSession, "getBackendSession").mockReturnValue({
      user: { id: "user-1", email: connectedEmail, status: "active" },
      organization: { id: "org-1", name: "Org", code: "ORG", status: "active" },
      globalRoles: ["user"],
      orgRoles: ["org_member"],
      permissions: ["feature.localupload"],
    });

    render(<Topbar />);

    expect(screen.queryByText(connectedEmail)).toBeNull();
  });

  it("does not show the email when the backend session is missing or invalid", () => {
    runtimeConfigMocks.isBackendMode.mockReturnValue(true);
    vi.spyOn(backendSession, "getBackendSession").mockReturnValue(null);

    render(<Topbar />);

    expect(screen.queryByRole("button", { name: connectedEmail })).toBeNull();
  });

  it("opens the password change dialog from the account menu and submits it", async () => {
    runtimeConfigMocks.isBackendMode.mockReturnValue(true);
    vi.spyOn(backendSession, "getBackendSession").mockReturnValue({
      user: { id: "user-1", email: connectedEmail, status: "active" },
      organization: { id: "org-1", name: "Org", code: "ORG", status: "active" },
      globalRoles: ["user"],
      orgRoles: ["org_member"],
      permissions: ["feature.localupload"],
    });
    const toastSpy = vi.spyOn(toastMod, "toast").mockImplementation(() => "toast-id" as any);
    const user = userEvent.setup();

    render(<Topbar />);

    await user.click(screen.getByRole("button", { name: connectedEmail }));
    await user.click(await screen.findByRole("menuitem", { name: /changer le mot de passe/i }));

    expect(screen.getByRole("dialog", { name: /changer le mot de passe/i })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Sécurité du mot de passe" })).toHaveAttribute(
      "aria-valuenow",
      "0"
    );

    fireEvent.change(screen.getByLabelText("Mot de passe actuel"), {
      target: { value: "ChangeMe123!" },
    });
    fireEvent.change(screen.getByLabelText("Nouveau mot de passe"), {
      target: { value: "NewPass123!" },
    });
    expect(screen.getByRole("progressbar", { name: "Sécurité du mot de passe" })).toHaveAttribute(
      "aria-valuenow",
      "3"
    );
    fireEvent.change(screen.getByLabelText("Confirmer le mot de passe"), {
      target: { value: "NewPass123!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mettre à jour" }));

    await waitFor(() => {
      expect(backendAuthMocks.backendChangePassword).toHaveBeenCalledWith("ChangeMe123!", "NewPass123!");
    });
    expect(backendAuthMocks.backendLogout).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith("Mot de passe modifié.");
    expect(mockNavigate).toHaveBeenCalledWith("/login", { replace: true });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /changer le mot de passe/i })).toBeNull();
    });
  });

  it("shows a validation error when the password confirmation does not match", async () => {
    runtimeConfigMocks.isBackendMode.mockReturnValue(true);
    vi.spyOn(backendSession, "getBackendSession").mockReturnValue({
      user: { id: "user-1", email: connectedEmail, status: "active" },
      organization: { id: "org-1", name: "Org", code: "ORG", status: "active" },
      globalRoles: ["user"],
      orgRoles: ["org_member"],
      permissions: ["feature.localupload"],
    });
    const user = userEvent.setup();

    render(<Topbar />);

    await user.click(screen.getByRole("button", { name: connectedEmail }));
    await user.click(await screen.findByRole("menuitem", { name: /changer le mot de passe/i }));
    expect(screen.getByRole("progressbar", { name: "Sécurité du mot de passe" })).toHaveAttribute(
      "aria-valuenow",
      "0"
    );
    await user.type(screen.getByLabelText("Mot de passe actuel"), "ChangeMe123!");
    await user.type(screen.getByLabelText("Nouveau mot de passe"), "NewPass123!");
    expect(screen.getByRole("progressbar", { name: "Sécurité du mot de passe" })).toHaveAttribute(
      "aria-valuenow",
      "3"
    );
    await user.type(screen.getByLabelText("Confirmer le mot de passe"), "Mismatch123!");
    await user.click(screen.getByRole("button", { name: "Mettre à jour" }));

    expect(screen.getByText("Les mots de passe ne correspondent pas.")).toBeInTheDocument();
    expect(backendAuthMocks.backendChangePassword).not.toHaveBeenCalled();
  });

  it('opens confirm and calls resetApp on confirm', async () => {
    const resetSpy = vi.fn();
    useAsrStore.setState({ resetApp: resetSpy, wasmThreads: 4 } as any);
    const toastSpy = vi.spyOn(toastMod, 'toast').mockImplementation(() => 't-id' as any);
    vi.spyOn(backendSupport, 'initializeBackendSupport').mockResolvedValue(true);

    render(<Topbar />);

    const resetBtn = screen.getByText('Réinitialiser');
    fireEvent.click(resetBtn);

    // Confirm dialog should show "Confirmer" button
    const confirm = await screen.findByText('Confirmer');
    fireEvent.click(confirm);

    await waitFor(() => expect(resetSpy).toHaveBeenCalled());
    expect(toastSpy).toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(/multithread WASM actif/i));
  });

  it('renders the log level selector and reflects store updates', () => {
    render(<Topbar />);
    const trigger = screen.getByLabelText('Niveau de logs');

    expect(trigger).toHaveTextContent('Info');
    act(() => {
      useAsrStore.setState({ logLevel: 'debug' } as any);
    });

    expect(screen.getByLabelText('Niveau de logs')).toHaveTextContent('Debug');
  });

  it('downloads a diagnostic log file instead of copying to clipboard', () => {
    const promptSpy = vi.spyOn(window, "prompt").mockImplementation(() => null);
    const downloadSpy = vi.spyOn(exportLib, "downloadBlob").mockImplementation(() => undefined);
    vi.spyOn(toastMod, 'toast').mockImplementation(() => 't-id' as any);

    render(<Topbar />);
    fireEvent.click(screen.getByText('Télécharger logs'));

    expect(downloadSpy).toHaveBeenCalledTimes(1);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(logger.exportDiagnosticLogBundle).toHaveBeenCalledTimes(1);

    const [content, filename, type] = downloadSpy.mock.calls[0]!;
    expect(filename).toMatch(/^demeter-logs-.*\.json$/);
    expect(type).toBe("application/json");

    const bundleContext = logger.exportDiagnosticLogBundle.mock.calls[0]![0] as {
      session: Record<string, unknown>;
      settings: Record<string, unknown>;
      telemetry: unknown;
    };
    expect(bundleContext.settings).toEqual(expect.objectContaining({ logLevel: "info" }));
    expect(bundleContext.session).toEqual(expect.objectContaining({ hasHydrated: false, status: "idle", logLevel: "info" }));

    const payload = JSON.parse(content as string) as { schemaVersion?: number; logs?: unknown[] };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.logs).toEqual([
      {
        timestamp: 't1',
        level: 'info',
        origin: 'logger',
        scopes: ['test'],
        message: 'log',
        rawArgs: ['log'],
      },
    ]);
    expect(toastMod.toast).toHaveBeenCalledWith("Fichier de logs téléchargé.");
  });

  it('hides backend info and shows cloud status badges on /cloudupload', () => {
    vi.spyOn(rr, 'useLocation').mockReturnValue({ pathname: '/cloudupload', search: '', state: null, hash: '', key: '' } as any);
    useAsrStore.setState({ cloudStatus: 'transcribing', cloudStatusDetail: 'Envoi cloud' } as any);

    render(<Topbar />);

    expect(screen.queryByText('Backend')).toBeNull();
    expect(screen.getAllByText('Cloud').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Transcription').length).toBeGreaterThan(0);
  });

  it('shows llm badges and llm status on /llmapi', () => {
    vi.spyOn(rr, 'useLocation').mockReturnValue({ pathname: '/llmapi', search: '', state: null, hash: '', key: '' } as any);
    useAsrStore.setState({
      llmApiStatus: 'generating',
      llmApiStatusDetail: 'Generation CRI (1/3)',
      llmApiProvider: 'huggingface',
      llmApiHfModelId: 'openai/gpt-oss-20b',
      llmApiHfMaxTokens: 131072,
    } as any);

    render(<Topbar />);

    expect(screen.queryByText('Backend')).toBeNull();
    expect(screen.getAllByText('LLM Cloud').length).toBeGreaterThan(0);
    expect(screen.getByText('HF API')).toBeInTheDocument();
    expect(screen.getByText('OpenAI OSS 20B')).toBeInTheDocument();
    expect(screen.getByText(/Max 131/)).toBeInTheDocument();
    expect(screen.getAllByText('Generation').length).toBeGreaterThan(0);
    expect(screen.getByText('Generation CRI (1/3)')).toBeInTheDocument();
  });

  it('shows mistral provider badge on /llmapi when provider is mistral', () => {
    vi.spyOn(rr, 'useLocation').mockReturnValue({ pathname: '/llmapi', search: '', state: null, hash: '', key: '' } as any);
    useAsrStore.setState({
      llmApiStatus: 'generating',
      llmApiProvider: 'mistral',
      llmApiMistralModelId: 'mistral-medium-latest',
      llmApiMistralMaxTokens: 8192,
    } as any);

    render(<Topbar />);

    expect(screen.getByText('Mistral API')).toBeInTheDocument();
  });

  it('shows hardcoded demeter token budget on /llmapi', () => {
    vi.spyOn(rr, 'useLocation').mockReturnValue({ pathname: '/llmapi', search: '', state: null, hash: '', key: '' } as any);
    useAsrStore.setState({
      llmApiStatus: 'generating',
      llmApiProvider: 'demeter_sante',
      llmApiMistralModelId: 'mistral-medium-latest',
      llmApiMistralMaxTokens: 8192,
    } as any);

    render(<Topbar />);

    expect(screen.getByText('Demeter Santé')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Max ${Math.round(DEMETER_SANTE_MAX_TOKENS / 1000)}`))).toBeInTheDocument();
  });

  it('keeps debug controls visible in production', () => {
    render(<Topbar />);
    expect(screen.getByText('Télécharger logs')).toBeInTheDocument();
    expect(screen.getByLabelText('Niveau de logs')).toBeInTheDocument();
  });

  it("calls runTest when clicking model compatibility test button", () => {
    render(<Topbar />);
    fireEvent.click(screen.getByRole("button", { name: /tester les modèles/i }));
    expect(modelTestHook.runTest).toHaveBeenCalledTimes(1);
  });

  it("shows running model test modal and allows stop request", () => {
    modelTestHook.state.running = true;
    modelTestHook.state.summaryOpen = false;
    modelTestHook.state.currentPreset = "fast";
    modelTestHook.state.currentBackend = "webgpu";
    modelTestHook.state.step = 1;
    modelTestHook.state.total = 2;
    modelTestHook.state.progress = 0.5;
    modelTestHook.state.results = [
      {
        preset: "fast",
        label: "Rapide",
        backends: {
          webgpu: { status: "ok", durationMs: 1100, message: "ok" },
          wasm: { status: "too_large", durationMs: 300, message: "oom" },
        },
      },
    ];

    render(<Topbar />);

    expect(screen.getByText(/test de compatibilité des modèles/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /stopper le test/i }));
    expect(modelTestHook.stopTest).toHaveBeenCalledTimes(1);
  });

  it("shows summary modal and closes it with validation button", () => {
    modelTestHook.state.running = false;
    modelTestHook.state.summaryOpen = true;
    modelTestHook.state.progress = 1;
    modelTestHook.state.results = [
      {
        preset: "fast",
        label: "Rapide",
        backends: {
          webgpu: { status: "ok", durationMs: 900, message: "ok" },
          wasm: { status: "error", durationMs: 200, message: "err" },
        },
      },
    ];
    modelTestHook.summary.ok = 1;
    modelTestHook.summary.blockedCount = 0;
    modelTestHook.summary.errors = 1;

    render(<Topbar />);

    expect(screen.getByText(/récapitulatif du test/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /valider et fermer/i }));
    expect(modelTestHook.closeSummary).toHaveBeenCalledTimes(1);
  });
});
