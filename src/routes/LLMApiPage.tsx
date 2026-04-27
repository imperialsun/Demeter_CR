import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type HTMLAttributes,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import { ReportFormatResultsPanel } from "@/components/llm/ReportFormatResultsPanel";
import { ReportFormatSwitchesSection } from "@/components/llm/ReportFormatSwitchesSection";
import { ReportDetailLevelsSection } from "@/components/llm/ReportDetailLevelsSection";
import { useAsrStore, type LlmApiProvider } from "@/store/asr-store";
import { useLlmReports } from "@/hooks/useLlmReports";
import { moveArrayItem } from "@/lib/arrayMove";
import { buildReportFormatDescription, buildReportFormatLabel } from "@/lib/llm/reportPrompts";
import { LLM_API_STATUS_META } from "@/lib/llm/llmStatusMeta";
import { areReportJsonsEqual, cloneReportJson, type ReportJson, type ReportResultKey } from "@/lib/llm/reportSchema";
import {
  formatTokenCount,
  resolveModelTokenBudget,
} from "@/lib/llm/modelCatalog";
import { resolveActiveLlmPipelineConfig } from "@/lib/llm/providerSettings";
import { emitLlmEvent } from "@/lib/llm/telemetrySession";
import {
  getSessionTranscriptText,
  getSessionTranscriptSegmentCount,
  hasSessionTranscriptContent,
  type SessionTranscriptMode,
} from "@/lib/sessionTranscriptMemory";
import {
  parseTranscriptFile,
  type ParsedTranscriptFile,
  TRANSCRIPT_IMPORT_ACCEPT,
  TRANSCRIPT_IMPORT_LABEL,
} from "@/lib/transcript/parseTranscriptFile";
import { estimateTokenCount } from "@/lib/tokens";
import logger from "@/lib/logger";
import { SESSION_ONLY_SECRET_NOTICE } from "@/lib/secret-storage-copy";
import { useBackendPermissions } from "@/hooks/useBackendPermissions";
import { canAccessFeature, canUseLlmProvider } from "@/lib/backend-permissions";
import { isBackendMode } from "@/lib/runtime-config";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";

const FORMAT_PREVIEW_META = [
  {
    format: "cri" as const,
    code: "CRI" as const,
    label: buildReportFormatLabel("CRI"),
    description: buildReportFormatDescription("CRI"),
  },
  {
    format: "cro" as const,
    code: "CRO" as const,
    label: buildReportFormatLabel("CRO"),
    description: buildReportFormatDescription("CRO"),
  },
  {
    format: "crs" as const,
    code: "CRS" as const,
    label: buildReportFormatLabel("CRS"),
    description: buildReportFormatDescription("CRS"),
  },
  {
    format: "crn" as const,
    code: "CRN" as const,
    label: buildReportFormatLabel("CRN"),
    description: buildReportFormatDescription("CRN"),
  },
];

type ReportTabKey = (typeof FORMAT_PREVIEW_META)[number]["format"];

const LLM_HF_TOKEN_REQUIRED_MESSAGE = "Ce module ne peut pas fonctionner sans clé API Hugging Face.";
const LLM_MISTRAL_TOKEN_REQUIRED_MESSAGE = "Ce module ne peut pas fonctionner sans clé API Mistral.";
const LLM_PROVIDER_FORBIDDEN_MESSAGE = "Accès refusé par vos permissions backend.";
const LLM_PIPELINE_CONFIG_REQUIRED_MESSAGE =
  "Configuration du pipeline incomplète : renseignez l'ID du modèle dans Paramètres > LLM Cloud.";
type ImportedFileMeta = {
  name: string;
  format: ParsedTranscriptFile["format"];
  extraction: ParsedTranscriptFile["extraction"];
  segmentCount?: number;
  charCount: number;
  tokenCount: number;
};

type AvailableSessionTranscriptOption = {
  mode: SessionTranscriptMode;
  label: string;
  text: string;
  segmentCount: number;
  charCount: number;
  tokenCount: number;
  updatedAt: string;
};

function LLMApiPage() {
  useBackendPermissions();
  const backendMode = isBackendMode();
  const canUseHFProvider = canUseLlmProvider("huggingface");
  const canUseMistralProvider = canUseLlmProvider("mistral");
  const canUseDemeterProvider = canUseLlmProvider("demeter_sante");
  const canOpenSettings = canAccessFeature("feature.settings");
  const sessionTranscriptMemories = useAsrStore((state) => state.sessionTranscriptMemories);
  const llmApiProvider = useAsrStore((state) => state.llmApiProvider);
  const hfApiToken = useAsrStore((state) => state.hfApiToken);
  const llmApiHfModelId = useAsrStore((state) => state.llmApiHfModelId);
  const llmApiHfTemperature = useAsrStore((state) => state.llmApiHfTemperature);
  const llmApiHfMaxTokens = useAsrStore((state) => state.llmApiHfMaxTokens);
  const llmApiMistralModelId = useAsrStore((state) => state.llmApiMistralModelId);
  const llmApiMistralTemperature = useAsrStore((state) => state.llmApiMistralTemperature);
  const llmApiMistralMaxTokens = useAsrStore((state) => state.llmApiMistralMaxTokens);
  const llmApiReportDetailLevels = useAsrStore((state) => state.llmApiReportDetailLevels);
  const llmApiReportEnabledFormats = useAsrStore((state) => state.llmApiReportEnabledFormats);
  const llmApiStatusDetail = useAsrStore((state) => state.llmApiStatusDetail);
  const mistralApiKey = useAsrStore((state) => state.mistralApiKey);

  const setLlmApiProvider = useAsrStore((state) => state.setLlmApiProvider);
  const setHfApiToken = useAsrStore((state) => state.setHfApiToken);
  const setLlmApiStatus = useAsrStore((state) => state.setLlmApiStatus);
  const resetLlmApiSession = useAsrStore((state) => state.resetLlmApiSession);
  const setMistralApiKey = useAsrStore((state) => state.setMistralApiKey);
  const setLlmApiReportDetailLevel = useAsrStore((state) => state.setLlmApiReportDetailLevel);
  const setLlmApiReportEnabledFormat = useAsrStore((state) => state.setLlmApiReportEnabledFormat);

  const { status, progress, results, generateAll, downloadDocx } = useLlmReports();

  const [source, setSource] = useState<"transcription" | "text">("transcription");
  const [manualText, setManualText] = useState("");
  const [activeTab, setActiveTab] = useState<ReportTabKey>("cri");
  const [isImporting, setIsImporting] = useState(false);
  const [importedFileMeta, setImportedFileMeta] = useState<ImportedFileMeta | null>(null);
  const [selectedTranscriptMode, setSelectedTranscriptMode] = useState<SessionTranscriptMode | null>(null);
  const sourceFileInputRef = useRef<HTMLInputElement | null>(null);

  const allowedProviders = useMemo<LlmApiProvider[]>(() => {
    const providers: LlmApiProvider[] = [];
    if (canUseHFProvider) providers.push("huggingface");
    if (canUseMistralProvider) providers.push("mistral");
    if (canUseDemeterProvider) providers.push("demeter_sante");
    return providers;
  }, [canUseDemeterProvider, canUseHFProvider, canUseMistralProvider]);

  const hasAllowedProvider = allowedProviders.length > 0;
  const isCurrentProviderAllowed = allowedProviders.includes(llmApiProvider);
  const providerSelectValue = isCurrentProviderAllowed ? llmApiProvider : "__unauthorized__";
  const activeProvider = isCurrentProviderAllowed ? llmApiProvider : null;

  useEffect(() => {
    logger.debug("[llm-cloud][ui] page view", { route: "/llmapi", mode: "cloud" });
    emitLlmEvent("LLM_CLOUD_PAGE_VIEW", { route: "/llmapi", mode: "cloud" });
  }, []);

  const availableTranscripts = useMemo<AvailableSessionTranscriptOption[]>(() => {
    const memoryEntries: Array<[SessionTranscriptMode, (typeof sessionTranscriptMemories)[SessionTranscriptMode]]> = [
      ["upload", sessionTranscriptMemories.upload],
      ["mic", sessionTranscriptMemories.mic],
      ["cloud", sessionTranscriptMemories.cloud],
    ];

    return memoryEntries
      .map(([mode, entry]) => {
        if (!hasSessionTranscriptContent(entry)) return null;
        const text = getSessionTranscriptText(entry);
        return {
          mode,
          label: entry.label,
          text,
          segmentCount: getSessionTranscriptSegmentCount(entry),
          charCount: text.length,
          tokenCount: estimateTokenCount(text),
          updatedAt: entry.updatedAt,
        };
      })
      .filter((entry): entry is AvailableSessionTranscriptOption => Boolean(entry))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }, [sessionTranscriptMemories]);

  const effectiveTranscriptMode = selectedTranscriptMode ?? availableTranscripts[0]?.mode ?? null;

  useEffect(() => {
    if (availableTranscripts.length === 0) {
      if (selectedTranscriptMode !== null) {
        setSelectedTranscriptMode(null);
      }
      return;
    }

    const selectedStillAvailable = selectedTranscriptMode
      ? availableTranscripts.some((entry) => entry.mode === selectedTranscriptMode)
      : false;

    if (!selectedStillAvailable) {
      setSelectedTranscriptMode(availableTranscripts[0]?.mode ?? null);
      return;
    }

    if (availableTranscripts.length === 1 && selectedTranscriptMode !== availableTranscripts[0]?.mode) {
      setSelectedTranscriptMode(availableTranscripts[0]?.mode ?? null);
    }
  }, [availableTranscripts, selectedTranscriptMode]);

  const activeTranscript = useMemo(
    () => availableTranscripts.find((entry) => entry.mode === effectiveTranscriptMode) ?? null,
    [availableTranscripts, effectiveTranscriptMode]
  );

  useEffect(() => {
    if (results[activeTab]) {
      return;
    }

    const nextAvailableTab = FORMAT_PREVIEW_META.find((item) => results[item.format]);
    if (nextAvailableTab && nextAvailableTab.format !== activeTab) {
      setActiveTab(nextAvailableTab.format);
    }
  }, [activeTab, results]);

  const transcriptionText = activeTranscript?.text ?? "";

  const activePipelineConfig = useMemo(
    () =>
      resolveActiveLlmPipelineConfig(
        {
          llmApiHfModelId,
          llmApiHfTemperature,
          llmApiHfMaxTokens,
          llmApiMistralModelId,
          llmApiMistralTemperature,
          llmApiMistralMaxTokens,
        },
        llmApiProvider
      ),
    [
      llmApiHfMaxTokens,
      llmApiHfModelId,
      llmApiHfTemperature,
      llmApiMistralMaxTokens,
      llmApiMistralModelId,
      llmApiMistralTemperature,
      llmApiProvider,
    ]
  );

  const sourceTextForBudget = source === "transcription" ? transcriptionText : manualText;
  const sourceTokenEstimate = useMemo(() => estimateTokenCount(sourceTextForBudget), [sourceTextForBudget]);
  const tokenBudget = useMemo(
    () =>
      resolveModelTokenBudget({
        modelId: activePipelineConfig.modelId,
        sourceTokens: sourceTokenEstimate,
      }),
    [activePipelineConfig.modelId, sourceTokenEstimate]
  );

  const meta = LLM_API_STATUS_META[status];
  const isBusy = status === "preparing" || status === "generating" || status === "formatting";
  const hasSource = source === "transcription" ? transcriptionText.length > 0 : manualText.trim().length > 0;
  const tokenRequiredMessage =
    activeProvider === "huggingface"
      ? LLM_HF_TOKEN_REQUIRED_MESSAGE
      : activeProvider === "mistral"
        ? LLM_MISTRAL_TOKEN_REQUIRED_MESSAGE
        : "";
  const isLlmTokenMissing =
    activeProvider === "huggingface"
      ? hfApiToken.trim().length === 0
      : activeProvider === "mistral"
        ? mistralApiKey.trim().length === 0
        : false;
  const pipelineConfigValid = activePipelineConfig.modelId.trim().length > 0;
  const sourceFitsModelContext = !tokenBudget.blockedByContext;
  const canGenerate =
    !isBusy &&
    !isImporting &&
    hasAllowedProvider &&
    isCurrentProviderAllowed &&
    hasSource &&
    sourceFitsModelContext &&
    pipelineConfigValid;

  const docxDownloads = useMemo(
    () =>
      FORMAT_PREVIEW_META.filter((item) => results[item.format]).map((item) => ({
        key: item.format,
        label: item.label,
        description: item.description,
      })),
    [results],
  );

  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);

  const runGeneration = async () => {
    if (!hasAllowedProvider || !isCurrentProviderAllowed) {
      setLlmApiStatus("error", LLM_PROVIDER_FORBIDDEN_MESSAGE);
      toast(LLM_PROVIDER_FORBIDDEN_MESSAGE);
      return;
    }

    logger.info("[llm-api][ui] generation requested", {
      provider: llmApiProvider,
      source,
      modelId: activePipelineConfig.modelId,
      sourceTokenEstimate,
    });
    emitLlmEvent("LLM_CLOUD_GENERATION_REQUESTED", {
      provider: llmApiProvider,
      sourceMode: source,
      modelId: activePipelineConfig.modelId || "unset",
      sourceTokenEstimate,
    });

    if (isLlmTokenMissing) {
      logger.warn("[llm-api][ui] generation blocked: missing token", {
        provider: llmApiProvider,
      });
      emitLlmEvent("LLM_CLOUD_GENERATION_BLOCKED", {
        provider: llmApiProvider,
        sourceMode: source,
        modelId: activePipelineConfig.modelId || "unset",
        reason: "missing_token",
      });
      setLlmApiStatus("error", tokenRequiredMessage);
      toast(tokenRequiredMessage);
      return;
    }

    if (!pipelineConfigValid) {
      logger.warn("[llm-api][ui] generation blocked: invalid pipeline config", {
        modelId: activePipelineConfig.modelId,
      });
      emitLlmEvent("LLM_CLOUD_GENERATION_BLOCKED", {
        provider: llmApiProvider,
        sourceMode: source,
        modelId: activePipelineConfig.modelId || "unset",
        reason: "invalid_pipeline_config",
      });
      setLlmApiStatus("error", LLM_PIPELINE_CONFIG_REQUIRED_MESSAGE);
      toast(LLM_PIPELINE_CONFIG_REQUIRED_MESSAGE);
      return;
    }

    if (source === "transcription") {
      if (!effectiveTranscriptMode) {
        setLlmApiStatus("error", "Aucune transcription disponible dans la session.");
        toast("Aucune transcription disponible dans la session.");
        return;
      }
      await generateAll({ source: "transcription", transcriptMode: effectiveTranscriptMode });
      return;
    }

    await generateAll({ source: "text", text: manualText });
  };

  const handleProviderChange = (value: string) => {
    if (value === "__unauthorized__") return;
    const nextProvider: LlmApiProvider =
      value === "mistral" || value === "demeter_sante" ? (value as LlmApiProvider) : "huggingface";
    if (!canUseLlmProvider(nextProvider)) {
      setLlmApiStatus("error", LLM_PROVIDER_FORBIDDEN_MESSAGE);
      toast(LLM_PROVIDER_FORBIDDEN_MESSAGE);
      return;
    }
    logger.info("[llm-api][ui] provider changed", { previousProvider: llmApiProvider, nextProvider });
    emitLlmEvent("LLM_CLOUD_PROVIDER_CHANGE", {
      previousProvider: llmApiProvider,
      nextProvider,
      sourceMode: source,
    });
    setLlmApiProvider(nextProvider);
  };

  const handleSourceChange = (value: string) => {
    const nextSource = value === "text" ? "text" : "transcription";
    logger.info("[llm-cloud][ui] source mode changed", {
      previousSource: source,
      nextSource,
      provider: llmApiProvider,
      modelId: activePipelineConfig.modelId || "unset",
    });
    emitLlmEvent("LLM_CLOUD_SOURCE_CHANGE", {
      previousSource: source,
      nextSource,
      provider: llmApiProvider,
      modelId: activePipelineConfig.modelId || "unset",
    });
    setSource(nextSource);
  };

  const handleTranscriptModeChange = (value: string) => {
    const nextMode = value as SessionTranscriptMode;
    const nextTranscript = availableTranscripts.find((entry) => entry.mode === nextMode);
    if (!nextTranscript) return;
    logger.info("[llm-cloud][ui] transcript source changed", {
      previousTranscriptMode: selectedTranscriptMode,
      nextTranscriptMode: nextMode,
      provider: llmApiProvider,
      modelId: activePipelineConfig.modelId || "unset",
    });
    setSelectedTranscriptMode(nextMode);
  };

  const runDownload = async (format: ReportResultKey) => {
    const formatMeta = FORMAT_PREVIEW_META.find((item) => item.format === format);
    logger.info("[llm-api][ui] download requested", { format });
    emitLlmEvent("LLM_CLOUD_DOWNLOAD_REQUESTED", {
      format,
      provider: llmApiProvider,
      modelId: activePipelineConfig.modelId || "unset",
    });
    try {
      await downloadDocx(format);
      toast(`DOCX ${formatMeta?.label ?? format.toUpperCase()} téléchargé.`);
      logger.info("[llm-api][ui] download completed", { format });
      emitLlmEvent("LLM_CLOUD_DOWNLOAD_DONE", {
        format,
        provider: llmApiProvider,
        modelId: activePipelineConfig.modelId || "unset",
      });
    } catch (error) {
      toast((error as Error)?.message ?? "Impossible de télécharger le DOCX.");
      logger.error("[llm-api][ui] download failed", {
        format,
        message: error instanceof Error ? error.message : String(error),
      });
      emitLlmEvent("LLM_CLOUD_DOWNLOAD_FAILED", {
        format,
        provider: llmApiProvider,
        modelId: activePipelineConfig.modelId || "unset",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleSourceFileImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    logger.info("[llm-api][ui] source file import start", {
      fileName: file.name,
      sizeBytes: file.size,
      fileType: file.type,
    });
    emitLlmEvent("LLM_CLOUD_IMPORT_START", {
      provider: llmApiProvider,
      fileName: file.name,
      sizeBytes: file.size,
      fileType: file.type,
      sourceMode: source,
    });

    try {
      const parsed = await parseTranscriptFile(file);
      const importedText = parsed.text.trim();
      const tokenCount = estimateTokenCount(importedText);

      if (source !== "text") {
        logger.info("[llm-cloud][ui] source mode changed by import", {
          previousSource: source,
          nextSource: "text",
          provider: llmApiProvider,
          modelId: activePipelineConfig.modelId || "unset",
        });
        emitLlmEvent("LLM_CLOUD_SOURCE_CHANGE", {
          previousSource: source,
          nextSource: "text",
          reason: "file_import",
          provider: llmApiProvider,
          modelId: activePipelineConfig.modelId || "unset",
        });
      }

      setManualText(importedText);
      setSource("text");
      setImportedFileMeta({
        name: file.name,
        format: parsed.format,
        extraction: parsed.extraction,
        segmentCount: parsed.segmentCount,
        charCount: importedText.length,
        tokenCount,
      });
      toast(
        `Fichier importé: ${file.name} (${parsed.format.toUpperCase()}, ${formatTokenCount(importedText.length)} caractères).`
      );
      logger.info("[llm-api][ui] source file import success", {
        fileName: file.name,
        format: parsed.format,
        extraction: parsed.extraction,
        textLength: importedText.length,
        tokenCount,
      });
      emitLlmEvent("LLM_CLOUD_IMPORT_SUCCESS", {
        provider: llmApiProvider,
        fileName: file.name,
        format: parsed.format,
        extraction: parsed.extraction,
        textLength: importedText.length,
        tokenCount,
      });
    } catch (error) {
      toast((error as Error)?.message ?? "Impossible d'importer le fichier.");
      logger.error("[llm-api][ui] source file import failed", {
        fileName: file.name,
        message: error instanceof Error ? error.message : String(error),
      });
      emitLlmEvent("LLM_CLOUD_IMPORT_FAILED", {
        provider: llmApiProvider,
        fileName: file.name,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsImporting(false);
      if (sourceFileInputRef.current) {
        sourceFileInputRef.current.value = "";
      }
    }
  };

  const triggerSourceFilePicker = () => {
    sourceFileInputRef.current?.click();
  };

  const handleResetSession = () => {
    logger.info("[llm-cloud][ui] reset requested", {
      provider: llmApiProvider,
      sourceMode: source,
      modelId: activePipelineConfig.modelId || "unset",
    });
    emitLlmEvent("LLM_CLOUD_RESET_REQUESTED", {
      provider: llmApiProvider,
      sourceMode: source,
      modelId: activePipelineConfig.modelId || "unset",
    });
    resetLlmApiSession();
    logger.info("[llm-cloud][ui] reset completed", {
      provider: llmApiProvider,
      sourceMode: source,
      modelId: activePipelineConfig.modelId || "unset",
    });
    emitLlmEvent("LLM_CLOUD_RESET_DONE", {
      provider: llmApiProvider,
      sourceMode: source,
      modelId: activePipelineConfig.modelId || "unset",
    });
  };

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold">LLM Cloud</h2>
        <p className="text-muted-foreground">
          Générez les comptes rendus via le provider LLM cloud, puis téléchargez chaque version en DOCX.
        </p>
        <p className="text-sm font-medium text-amber-700">
          Note : ce module utilise une API externe du provider sélectionné. Pour un équivalent local, utilisez LLM
          Local (/llmlocal).
        </p>
      </header>

      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Configuration API</CardTitle>
              <CardDescription>Provider et jetons d&apos;accès. Le pipeline LLM se règle dans Paramètres.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {hasAllowedProvider ? (
                <div className="space-y-2">
                  <Label htmlFor="llm-provider">Provider LLM</Label>
                  <Select value={providerSelectValue} onValueChange={handleProviderChange}>
                    <SelectTrigger id="llm-provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {!isCurrentProviderAllowed ? (
                        <SelectItem value="__unauthorized__" disabled>
                          Sélectionnez un provider autorisé
                        </SelectItem>
                      ) : null}
                      {canUseHFProvider ? <SelectItem value="huggingface">Hugging Face</SelectItem> : null}
                      {canUseMistralProvider ? <SelectItem value="mistral">Mistral</SelectItem> : null}
                      {backendMode && canUseDemeterProvider ? (
                        <SelectItem value="demeter_sante">Demeter Santé</SelectItem>
                      ) : null}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                  Aucun provider LLM cloud autorisé par le backend.
                </div>
              )}

              {!isCurrentProviderAllowed && hasAllowedProvider ? (
                <div className="rounded-md border border-destructive/60 bg-destructive/10 p-3 text-xs text-destructive">
                  {LLM_PROVIDER_FORBIDDEN_MESSAGE}
                </div>
              ) : null}

              {activeProvider === "huggingface" ? (
                <div className="space-y-2">
                  <Label htmlFor="llm-api-token">Token Hugging Face</Label>
                  <Input
                    id="llm-api-token"
                    type="password"
                    value={hfApiToken}
                    onChange={(event) => setHfApiToken(event.target.value)}
                    placeholder="hf_..."
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">{SESSION_ONLY_SECRET_NOTICE}</p>
                  {isLlmTokenMissing ? <p className="text-xs text-destructive">{tokenRequiredMessage}</p> : null}
                </div>
              ) : activeProvider === "mistral" ? (
                <div className="space-y-2">
                  <Label htmlFor="llm-mistral-api-key">Clé API Mistral</Label>
                  <Input
                    id="llm-mistral-api-key"
                    type="password"
                    value={mistralApiKey}
                    onChange={(event) => setMistralApiKey(event.target.value)}
                    placeholder="mistral_..."
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">Clé partagée avec la page /cloudupload.</p>
                  <p className="text-xs text-muted-foreground">{SESSION_ONLY_SECRET_NOTICE}</p>
                  {isLlmTokenMissing ? <p className="text-xs text-destructive">{tokenRequiredMessage}</p> : null}
                </div>
              ) : activeProvider === "demeter_sante" ? (
                <div className="space-y-2 rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                  <p className="text-sm font-medium text-foreground">Demeter Santé</p>
                  <p>Ce provider passe par le backend, aucune clé API n'est requise dans le navigateur.</p>
                </div>
              ) : null}

              {hasAllowedProvider ? (
                <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                  <p className="text-sm font-medium text-foreground">Configuration du pipeline</p>
                  <p className="mt-1">
                    Fournisseur :{" "}
                    <span className="font-medium text-foreground">
                      {llmApiProvider === "mistral"
                        ? "Mistral"
                        : llmApiProvider === "demeter_sante"
                          ? "Demeter Santé"
                          : "Hugging Face"}
                    </span>
                  </p>
                  <p>
                    ID du modèle :{" "}
                    <span className="font-medium text-foreground">{activePipelineConfig.modelId.trim() || "non défini"}</span>
                  </p>
                  <p>
                    Température : <span className="font-medium text-foreground">{activePipelineConfig.temperature}</span>
                  </p>
                  <p>
                    Nombre max de tokens :{" "}
                    <span className="font-medium text-foreground">{formatTokenCount(activePipelineConfig.maxTokens)}</span>
                  </p>
                  {canOpenSettings ? (
                    <div className="mt-3">
                      <Button asChild variant="outline" size="sm">
                        <a href="/settings?tab=llm">Ouvrir paramètres LLM</a>
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                  Le pipeline n'est pas configurable tant qu'aucun provider LLM cloud n'est autorisé.
                </div>
              )}

              {!pipelineConfigValid && hasAllowedProvider ? (
                <div className="rounded-md border border-destructive/60 bg-destructive/10 p-3 text-xs text-destructive">
                  <p className="font-medium">Configuration du pipeline incomplète</p>
                  <p className="mt-1">Le module /llmapi ne peut pas fonctionner sans ID du modèle configuré.</p>
                  {canOpenSettings ? (
                    <div className="mt-3">
                      <Button asChild variant="outline" size="sm">
                        <a href="/settings?tab=llm">Ouvrir paramètres LLM</a>
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <ReportDetailLevelsSection
            values={llmApiReportDetailLevels}
            onChange={setLlmApiReportDetailLevel}
            defaultCollapsed
          />

          <ReportFormatSwitchesSection
            values={llmApiReportEnabledFormats}
            onChange={setLlmApiReportEnabledFormat}
          />

          <Card>
            <CardHeader>
              <CardTitle>Source</CardTitle>
              <CardDescription>Choisissez la transcription de session ou un texte libre.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="llm-source">Mode d&apos;entrée</Label>
                <Select value={source} onValueChange={handleSourceChange}>
                  <SelectTrigger id="llm-source">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="transcription">Depuis transcription</SelectItem>
                    <SelectItem value="text">Texte libre</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {source === "transcription" ? (
                <div className="space-y-3">
                  {availableTranscripts.length > 1 ? (
                    <div className="space-y-2">
                      <Label htmlFor="llm-session-transcript">Transcription à utiliser</Label>
                      <Select
                        value={effectiveTranscriptMode ?? availableTranscripts[0]?.mode ?? ""}
                        onValueChange={handleTranscriptModeChange}
                      >
                        <SelectTrigger id="llm-session-transcript">
                          <SelectValue placeholder="Choisir une transcription" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableTranscripts.map((transcript) => (
                            <SelectItem key={transcript.mode} value={transcript.mode}>
                              {transcript.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}

                  <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                    {activeTranscript ? (
                      <>
                        <p>
                          Source active : <span className="font-medium text-foreground">{activeTranscript.label}</span>
                        </p>
                        <p>
                          Segments disponibles :{" "}
                          <span className="font-medium text-foreground">{activeTranscript.segmentCount}</span>
                        </p>
                        <p>
                          Taille source approx. :{" "}
                          <span className="font-medium text-foreground">{formatTokenCount(activeTranscript.charCount)}</span>{" "}
                          caractères.
                        </p>
                        <p>
                          Tokens source approx. :{" "}
                          <span className="font-medium text-foreground">{formatTokenCount(activeTranscript.tokenCount)}</span>{" "}
                          tokens.
                        </p>
                        <p>Disponible pendant la session navigateur, même après changement de page ou rechargement.</p>
                      </>
                    ) : (
                      <p className="text-destructive">Aucune transcription active dans la session.</p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-md border bg-muted/20 p-3">
                    <p className="text-sm font-medium text-foreground">Import de transcription</p>
                    <p className="text-xs text-muted-foreground">
                      Importez un fichier texte ou DOCX pour alimenter la génération des comptes rendus.
                    </p>
                    <div className="mt-3 flex flex-wrap items-start gap-2 sm:flex-nowrap">
                      <Button type="button" onClick={triggerSourceFilePicker} disabled={isImporting || isBusy}>
                        {isImporting ? "Import en cours..." : "Choisir un fichier"}
                      </Button>
                      <span className="min-w-0 flex-1 break-all text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {importedFileMeta ? importedFileMeta.name : "Aucun fichier importé"}
                      </span>
                    </div>
                    <Label htmlFor="llm-source-file" className="sr-only">
                      Importer un fichier de transcription
                    </Label>
                    <input
                      ref={sourceFileInputRef}
                      id="llm-source-file"
                      type="file"
                      accept={TRANSCRIPT_IMPORT_ACCEPT}
                      onChange={handleSourceFileImport}
                      disabled={isImporting || isBusy}
                      className="sr-only"
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      Formats acceptés : {TRANSCRIPT_IMPORT_LABEL}. Taille max : 50 Mo.
                    </p>
                  </div>
                  {!manualText.trim() ? (
                    <p className="text-xs text-destructive">Importez un fichier pour lancer la génération.</p>
                  ) : null}
                  {importedFileMeta ? (
                    <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                      <p className="min-w-0">
                        Fichier importé :{" "}
                        <span className="mt-1 block break-all font-medium text-foreground [overflow-wrap:anywhere]">
                          {importedFileMeta.name}
                        </span>
                      </p>
                      <p>
                        Format détecté :{" "}
                        <span className="font-medium text-foreground">{importedFileMeta.format.toUpperCase()}</span>
                      </p>
                      <p>
                        Taille du texte importé :{" "}
                        <span className="font-medium text-foreground">
                          {formatTokenCount(importedFileMeta.charCount)}
                        </span>{" "}
                        caractères.
                      </p>
                      <p>
                        Tokens du fichier importé approx. :{" "}
                        <span className="font-medium text-foreground">
                          {formatTokenCount(importedFileMeta.tokenCount)}
                        </span>{" "}
                        tokens.
                      </p>
                      {typeof importedFileMeta.segmentCount === "number" ? (
                        <p>
                          Segments extraits :{" "}
                          <span className="font-medium text-foreground">
                            {formatTokenCount(importedFileMeta.segmentCount)}
                          </span>
                          .
                        </p>
                      ) : null}
                      <p>
                        Méthode d&apos;extraction :{" "}
                        <span className="font-medium text-foreground">{importedFileMeta.extraction}</span>.
                      </p>
                    </div>
                  ) : null}
                </div>
              )}

              {!sourceFitsModelContext ? (
                <p className="text-xs text-destructive">
                  Source trop longue pour ce modèle. Ajustez le pipeline dans Paramètres &gt; LLM Cloud.
                </p>
              ) : null}
              {!hasAllowedProvider ? (
                <p className="text-xs text-muted-foreground">
                  Aucun provider LLM cloud n'est activé par le backend pour ce compte.
                </p>
              ) : null}
              {hasAllowedProvider && !isCurrentProviderAllowed ? (
                <p className="text-xs text-destructive">{LLM_PROVIDER_FORBIDDEN_MESSAGE}</p>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={runGeneration} disabled={!canGenerate}>
                  Générer les comptes rendus
                </Button>
                <Button variant="outline" onClick={handleResetSession} disabled={isBusy}>
                  Réinitialiser la session LLM
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Progression</CardTitle>
              <CardDescription>Pipeline cloud: préparation, génération et mise en forme des comptes rendus.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant={meta.variant}>{meta.label}</Badge>
                <Badge variant="outline">{percent}%</Badge>
                {llmApiStatusDetail ? <span className="text-sm text-muted-foreground">{llmApiStatusDetail}</span> : null}
              </div>
              <Progress value={percent} className="h-2" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Édition des formats</CardTitle>
              <CardDescription>
                Chaque format peut être relu et modifié après génération. L&apos;export DOCX suit la version éditée de
                cette session.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                    {FORMAT_PREVIEW_META.map((item) => (
                      <div key={item.format} className="rounded-md border bg-muted/20 p-3">
                        <p className="text-sm font-semibold text-foreground">{item.label}</p>
                        <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                          {item.description}
                        </p>
                      </div>
                    ))}
                  </div>

                  <ReportFormatResultsPanel
                    className="mt-4"
                    results={results}
                    enabledFormats={llmApiReportEnabledFormats}
                    onDownload={(format) => {
                      void runDownload(format);
                    }}
                    showDownloadButton={false}
                    emptyMessage="Les comptes rendus apparaîtront ici au fil de leur génération."
                  />

                {docxDownloads.length > 0 ? (
                  <section
                    aria-labelledby="llm-docx-downloads-title"
                    className="mt-4 rounded-2xl border border-border/70 bg-muted/30 p-4 shadow-sm"
                    role="region"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold tracking-tight text-foreground" id="llm-docx-downloads-title">
                          Téléchargements DOCX
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Chaque bouton apparaît dès que son compte rendu correspondant est généré.
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                      {docxDownloads.map((item) => (
                        <Button
                          className="w-full whitespace-normal sm:flex-1"
                          disabled={isBusy}
                          key={item.key}
                          onClick={() => runDownload(item.key)}
                          size="lg"
                          variant="default"
                        >
                          Télécharger le {item.label} (.docx)
                        </Button>
                      ))}
                    </div>
                  </section>
                ) : null}

                <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ReportTabKey)}>
                  <TabsList className="grid h-auto w-full grid-cols-1 gap-1 sm:grid-cols-2 xl:grid-cols-4">
                    {FORMAT_PREVIEW_META.map((item) => (
                      <TabsTrigger
                        key={item.format}
                        value={item.format}
                        className="min-w-0 whitespace-normal px-3 py-2 text-center leading-tight"
                      >
                        {item.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>

                {FORMAT_PREVIEW_META.map((item) => (
                  <TabsContent key={item.format} value={item.format} className="mt-4">
                    <ReportFormatEditor format={item.format} description={item.description} />
                  </TabsContent>
                ))}
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ReportFormatEditor({ format, description }: { format: ReportResultKey; description: string }) {
  const formatMeta = FORMAT_PREVIEW_META.find((item) => item.format === format);
  const result = useAsrStore((state) => state.llmApiResults[format]);
  const draft = useAsrStore((state) => state.llmApiReportDrafts[format]);
  const llmApiStatus = useAsrStore((state) => state.llmApiStatus);
  const setLlmApiReportDraft = useAsrStore((state) => state.setLlmApiReportDraft);
  const resetLlmApiReportDraft = useAsrStore((state) => state.resetLlmApiReportDraft);
  const isBusy = llmApiStatus === "preparing" || llmApiStatus === "generating" || llmApiStatus === "formatting";
  const baseReport = result?.report;
  const currentReport = draft ?? baseReport;
  const isDirty = Boolean(draft && (!baseReport || !areReportJsonsEqual(draft, baseReport)));

  const commitReport = (nextReport: ReportJson) => {
    if (!baseReport) {
      setLlmApiReportDraft(format, nextReport);
      return;
    }
    if (areReportJsonsEqual(nextReport, baseReport)) {
      resetLlmApiReportDraft(format);
      return;
    }
    setLlmApiReportDraft(format, nextReport);
  };

  const updateReport = (mutator: (nextReport: ReportJson) => void) => {
    if (!currentReport) return;
    const nextReport = cloneReportJson(currentReport);
    mutator(nextReport);
    commitReport(nextReport);
  };

  const handleTitleChange = (value: string) => {
    updateReport((nextReport) => {
      nextReport.title = value;
    });
  };

  const handleSubtitleChange = (value: string) => {
    updateReport((nextReport) => {
      if (value.trim().length > 0) {
        nextReport.subtitle = value;
      } else {
        delete nextReport.subtitle;
      }
    });
  };

  const moveSection = (fromIndex: number, toIndex: number) => {
    updateReport((nextReport) => {
      nextReport.sections = moveArrayItem(nextReport.sections, fromIndex, toIndex);
    });
  };

  const addSection = () => {
    updateReport((nextReport) => {
      nextReport.sections.push({
        heading: "Nouvelle section",
        paragraphs: [""],
      });
    });
  };

  const removeSection = (sectionIndex: number) => {
    updateReport((nextReport) => {
      nextReport.sections.splice(sectionIndex, 1);
    });
  };

  const updateSectionHeading = (sectionIndex: number, value: string) => {
    updateReport((nextReport) => {
      const section = nextReport.sections[sectionIndex];
      if (!section) return;
      section.heading = value;
    });
  };

  const addSectionParagraph = (sectionIndex: number) => {
    updateReport((nextReport) => {
      const section = nextReport.sections[sectionIndex];
      if (!section) return;
      section.paragraphs.push("");
    });
  };

  const updateSectionParagraph = (sectionIndex: number, paragraphIndex: number, value: string) => {
    updateReport((nextReport) => {
      const section = nextReport.sections[sectionIndex];
      if (!section) return;
      section.paragraphs[paragraphIndex] = value;
    });
  };

  const moveSectionParagraph = (sectionIndex: number, fromIndex: number, toIndex: number) => {
    updateReport((nextReport) => {
      const section = nextReport.sections[sectionIndex];
      if (!section) return;
      section.paragraphs = moveArrayItem(section.paragraphs, fromIndex, toIndex);
    });
  };

  const removeSectionParagraph = (sectionIndex: number, paragraphIndex: number) => {
    updateReport((nextReport) => {
      const section = nextReport.sections[sectionIndex];
      if (!section) return;
      section.paragraphs.splice(paragraphIndex, 1);
    });
  };

  const moveListField = (field: "key_points" | "action_items" | "caveats", fromIndex: number, toIndex: number) => {
    updateReport((nextReport) => {
      const currentValues = nextReport[field] ?? [];
      nextReport[field] = moveArrayItem(currentValues, fromIndex, toIndex);
    });
  };

  const addListFieldValue = (field: "key_points" | "action_items" | "caveats") => {
    updateReport((nextReport) => {
      const currentValues = [...(nextReport[field] ?? [])];
      currentValues.push("");
      nextReport[field] = currentValues;
    });
  };

  const updateListFieldValue = (
    field: "key_points" | "action_items" | "caveats",
    itemIndex: number,
    value: string
  ) => {
    updateReport((nextReport) => {
      const currentValues = [...(nextReport[field] ?? [])];
      currentValues[itemIndex] = value;
      nextReport[field] = currentValues;
    });
  };

  const removeListFieldValue = (field: "key_points" | "action_items" | "caveats", itemIndex: number) => {
    updateReport((nextReport) => {
      const currentValues = [...(nextReport[field] ?? [])];
      currentValues.splice(itemIndex, 1);
      if (currentValues.length > 0) {
        nextReport[field] = currentValues;
      } else {
        delete nextReport[field];
      }
    });
  };

  if (!currentReport) {
    return (
      <div
        data-testid={`report-editor-${format}`}
        className="rounded-md border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground"
      >
        Aucun compte rendu {formatMeta?.label ?? format.toUpperCase()} pour le moment.
      </div>
    );
  }

  return (
    <div data-testid={`report-editor-${format}`} className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{formatMeta?.label ?? format.toUpperCase()}</Badge>
            {result ? (
              <>
                <Badge variant="outline">{result.modelId}</Badge>
                <Badge variant="outline">{result.strategy}</Badge>
                <Badge variant="outline">passes {result.pipelinePasses}</Badge>
              </>
            ) : null}
            <Badge variant={isDirty ? "warning" : "outline"}>{isDirty ? "Modifié" : "Version cloud"}</Badge>
          </div>
          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>

        <Button variant="outline" size="sm" onClick={() => resetLlmApiReportDraft(format)} disabled={!draft || isBusy}>
          Réinitialiser ce compte rendu
        </Button>
      </div>

      <div className="space-y-4 rounded-md border bg-background p-4">
        <div className="space-y-2">
          <Label htmlFor={`${format}-report-title`}>Titre</Label>
          <Input
            id={`${format}-report-title`}
            value={currentReport.title}
            onChange={(event) => handleTitleChange(event.target.value)}
            disabled={isBusy}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${format}-report-subtitle`}>Sous-titre</Label>
          <Textarea
            id={`${format}-report-subtitle`}
            value={currentReport.subtitle ?? ""}
            onChange={(event) => handleSubtitleChange(event.target.value)}
            disabled={isBusy}
            rows={3}
          />
        </div>

        <ReportSectionsEditor
          format={format}
          sections={currentReport.sections}
          disabled={isBusy}
          onAddSection={addSection}
          onRemoveSection={removeSection}
          onMoveSection={moveSection}
          onChangeSectionHeading={updateSectionHeading}
          onAddParagraph={addSectionParagraph}
          onRemoveParagraph={removeSectionParagraph}
          onMoveParagraph={moveSectionParagraph}
          onChangeParagraph={updateSectionParagraph}
        />

        <ReorderableTextListEditor
          fieldKey={`${format}-key-points`}
          title="Points clés"
          description="Ajustez les points essentiels du compte rendu."
          values={currentReport.key_points}
          disabled={isBusy}
          emptyMessage="Aucun point clé pour le moment."
          addLabel="Ajouter un point clé"
          itemLabel="Point clé"
          onAdd={() => addListFieldValue("key_points")}
          onChange={(index, value) => updateListFieldValue("key_points", index, value)}
          onRemove={(index) => removeListFieldValue("key_points", index)}
          onMove={(fromIndex, toIndex) => moveListField("key_points", fromIndex, toIndex)}
        />

        <ReorderableTextListEditor
          fieldKey={`${format}-action-items`}
          title="Actions"
          description="Listez les actions à mener ou à suivre."
          values={currentReport.action_items}
          disabled={isBusy}
          emptyMessage="Aucune action pour le moment."
          addLabel="Ajouter une action"
          itemLabel="Action"
          onAdd={() => addListFieldValue("action_items")}
          onChange={(index, value) => updateListFieldValue("action_items", index, value)}
          onRemove={(index) => removeListFieldValue("action_items", index)}
          onMove={(fromIndex, toIndex) => moveListField("action_items", fromIndex, toIndex)}
        />

        <ReorderableTextListEditor
          fieldKey={`${format}-caveats`}
          title="Points de vigilance"
          description="Conservez ici les alertes, risques ou points de contrôle."
          values={currentReport.caveats}
          disabled={isBusy}
          emptyMessage="Aucun point de vigilance pour le moment."
          addLabel="Ajouter un point de vigilance"
          itemLabel="Point de vigilance"
          onAdd={() => addListFieldValue("caveats")}
          onChange={(index, value) => updateListFieldValue("caveats", index, value)}
          onRemove={(index) => removeListFieldValue("caveats", index)}
          onMove={(fromIndex, toIndex) => moveListField("caveats", fromIndex, toIndex)}
        />
      </div>
    </div>
  );
}

function ReportSectionsEditor({
  format,
  sections,
  disabled,
  onAddSection,
  onRemoveSection,
  onMoveSection,
  onChangeSectionHeading,
  onAddParagraph,
  onRemoveParagraph,
  onMoveParagraph,
  onChangeParagraph,
}: {
  format: ReportResultKey;
  sections: ReportJson["sections"];
  disabled: boolean;
  onAddSection: () => void;
  onRemoveSection: (sectionIndex: number) => void;
  onMoveSection: (fromIndex: number, toIndex: number) => void;
  onChangeSectionHeading: (sectionIndex: number, value: string) => void;
  onAddParagraph: (sectionIndex: number) => void;
  onRemoveParagraph: (sectionIndex: number, paragraphIndex: number) => void;
  onMoveParagraph: (sectionIndex: number, fromIndex: number, toIndex: number) => void;
  onChangeParagraph: (sectionIndex: number, paragraphIndex: number, value: string) => void;
}) {
  const reorder = useReorderableList(onMoveSection, disabled);

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Sections</p>
          <p className="text-xs text-muted-foreground">
            Glissez les sections vers le haut ou le bas, ou utilisez les boutons de secours.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onAddSection} disabled={disabled}>
          Ajouter une section
        </Button>
      </div>

      {sections.length > 0 ? (
        <div className="space-y-3">
          {sections.map((section, sectionIndex) => {
            const isDragging = reorder.draggingIndex === sectionIndex;
            return (
              <div
                key={`${format}-section-${sectionIndex}`}
                data-testid={`${format}-section-card-${sectionIndex}`}
                className={`space-y-4 rounded-md border border-border/70 bg-background p-4 ${
                  isDragging ? "opacity-70 ring-1 ring-primary/30" : ""
                }`}
                {...reorder.getDropTargetProps(sectionIndex)}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-xs font-semibold tracking-wide text-foreground">Section {sectionIndex + 1}</p>
                    <p className="text-xs text-muted-foreground">
                      Déplacez cette section ou utilisez les boutons Monter / Descendre.
                    </p>
                  </div>
                  <ReorderControls
                    itemLabel="Section"
                    index={sectionIndex}
                    count={sections.length}
                    disabled={disabled}
                    onMoveUp={() => reorder.moveUp(sectionIndex)}
                    onMoveDown={() => reorder.moveDown(sectionIndex, sections.length)}
                    onRemove={() => onRemoveSection(sectionIndex)}
                    removeLabel="Supprimer"
                    dragHandleProps={reorder.getDragHandleProps(sectionIndex)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor={`${format}-section-${sectionIndex}-heading`}>Titre de section</Label>
                  <Input
                    id={`${format}-section-${sectionIndex}-heading`}
                    value={section.heading}
                    onChange={(event) => onChangeSectionHeading(sectionIndex, event.target.value)}
                    disabled={disabled}
                  />
                </div>

                <ReorderableTextListEditor
                  fieldKey={`${format}-section-${sectionIndex}-paragraphs`}
                  title="Paragraphes"
                  description="Réorganisez les paragraphes de cette section."
                  values={section.paragraphs}
                  disabled={disabled}
                  emptyMessage="Aucun paragraphe pour cette section."
                  addLabel="Ajouter un paragraphe"
                  itemLabel="Paragraphe"
                  onAdd={() => onAddParagraph(sectionIndex)}
                  onChange={(paragraphIndex, value) => onChangeParagraph(sectionIndex, paragraphIndex, value)}
                  onRemove={(paragraphIndex) => onRemoveParagraph(sectionIndex, paragraphIndex)}
                  onMove={(fromIndex, toIndex) => onMoveParagraph(sectionIndex, fromIndex, toIndex)}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-dashed bg-background/80 p-3 text-xs text-muted-foreground">
          Aucune section pour le moment.
        </div>
      )}
    </div>
  );
}

function ReorderableTextListEditor({
  fieldKey,
  title,
  description,
  values,
  disabled,
  emptyMessage,
  addLabel,
  itemLabel,
  onAdd,
  onChange,
  onRemove,
  onMove,
}: {
  fieldKey: string;
  title: string;
  description: string;
  values?: string[];
  disabled: boolean;
  emptyMessage: string;
  addLabel: string;
  itemLabel: string;
  onAdd: () => void;
  onChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
}) {
  const reorder = useReorderableList(onMove, disabled);

  return (
    <div className="space-y-3 rounded-md border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onAdd} disabled={disabled}>
          {addLabel}
        </Button>
      </div>

      {values?.length ? (
        <div className="space-y-3">
          {values.map((value, index) => {
            const isDragging = reorder.draggingIndex === index;
            return (
              <div
                key={`${fieldKey}-${index}`}
                data-testid={`${fieldKey}-item-${index}`}
                className={`space-y-2 rounded-md border bg-muted/20 p-3 ${
                  isDragging ? "opacity-70 ring-1 ring-primary/30" : ""
                }`}
                {...reorder.getDropTargetProps(index)}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="cursor-grab touch-none"
                      aria-label={`Déplacer ${itemLabel} ${index + 1}`}
                      title={`Déplacer ${itemLabel} ${index + 1}`}
                      {...reorder.getDragHandleProps(index)}
                    >
                      <GripVertical className="h-4 w-4" />
                    </Button>
                    <Label htmlFor={`${fieldKey}-${index}`}>{itemLabel} {index + 1}</Label>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => reorder.moveUp(index)}
                      disabled={disabled || index === 0}
                    >
                      <ChevronUp className="mr-1 h-4 w-4" />
                      Monter
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => reorder.moveDown(index, values.length)}
                      disabled={disabled || index === values.length - 1}
                    >
                      <ChevronDown className="mr-1 h-4 w-4" />
                      Descendre
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => onRemove(index)} disabled={disabled}>
                      Supprimer
                    </Button>
                  </div>
                </div>
                <Textarea
                  id={`${fieldKey}-${index}`}
                  value={value}
                  onChange={(event) => onChange(index, event.target.value)}
                  disabled={disabled}
                  rows={2}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-dashed bg-muted/10 p-3 text-xs text-muted-foreground">
          {emptyMessage}
        </div>
      )}
    </div>
  );
}

function ReorderControls({
  itemLabel,
  index,
  count,
  disabled,
  onMoveUp,
  onMoveDown,
  onRemove,
  removeLabel,
  dragHandleProps,
}: {
  itemLabel: string;
  index: number;
  count: number;
  disabled: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  removeLabel: string;
  dragHandleProps: ButtonHTMLAttributes<HTMLButtonElement>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="cursor-grab touch-none"
        aria-label={`Déplacer ${itemLabel} ${index + 1}`}
        title={`Déplacer ${itemLabel} ${index + 1}`}
        {...dragHandleProps}
      >
        <GripVertical className="h-4 w-4" />
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onMoveUp} disabled={disabled || index === 0}>
        <ChevronUp className="mr-1 h-4 w-4" />
        Monter
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onMoveDown} disabled={disabled || index === count - 1}>
        <ChevronDown className="mr-1 h-4 w-4" />
        Descendre
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onRemove} disabled={disabled}>
        {removeLabel}
      </Button>
    </div>
  );
}

function useReorderableList(onMove: (fromIndex: number, toIndex: number) => void, disabled: boolean) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  const clearDragState = () => {
    setDraggingIndex(null);
  };

  const moveItem = (fromIndex: number, toIndex: number) => {
    if (disabled || fromIndex === toIndex) {
      clearDragState();
      return;
    }
    onMove(fromIndex, toIndex);
    clearDragState();
  };

  const getDragHandleProps = (index: number): ButtonHTMLAttributes<HTMLButtonElement> => ({
    draggable: !disabled,
    onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => {
      if (disabled) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
      setDraggingIndex(index);
    },
    onDragEnd: () => clearDragState(),
  });

  const getDropTargetProps = (index: number): HTMLAttributes<HTMLDivElement> => ({
    onDragOver: (event: ReactDragEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
    },
    onDrop: (event: ReactDragEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      const rawIndex = event.dataTransfer.getData("text/plain");
      const parsedIndex = Number.parseInt(rawIndex, 10);
      const fromIndex = Number.isNaN(parsedIndex) ? draggingIndex : parsedIndex;
      if (fromIndex === null) {
        clearDragState();
        return;
      }
      moveItem(fromIndex, index);
    },
  });

  return {
    draggingIndex,
    getDragHandleProps,
    getDropTargetProps,
    moveUp: (index: number) => moveItem(index, index - 1),
    moveDown: (index: number, count: number) => {
      if (index >= count - 1) {
        clearDragState();
        return;
      }
      moveItem(index, index + 1);
    },
  };
}

export default LLMApiPage;
