import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/use-toast";
import { ReportFormatResultsPanel } from "@/components/llm/ReportFormatResultsPanel";
import { ReportFormatSwitchesSection } from "@/components/llm/ReportFormatSwitchesSection";
import { useAsrStore, type LlmApiProvider } from "@/store/asr-store";
import { useLlmReports } from "@/hooks/useLlmReports";
import { LLM_API_STATUS_META } from "@/lib/llm/llmStatusMeta";
import type { BuiltInReportResultKey, ReportResultKey } from "@/lib/llm/reportSchema";
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
import { useBackendPermissions } from "@/hooks/useBackendPermissions";
import { useReportTemplates } from "@/hooks/useReportTemplates";
import { canAccessFeature, canUseLlmProvider } from "@/lib/backend-permissions";
import { cn } from "@/lib/utils";

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

const REPORT_DOWNLOAD_LABELS: Record<BuiltInReportResultKey, string> = {
  cri: "Compte rendu détaillé",
  cro: "Compte rendu opérationnel",
  crs: "Compte rendu synthétique",
  crn: "Compte rendu narratif",
};

function LLMApiPage() {
  useBackendPermissions();
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

  const setLlmApiStatus = useAsrStore((state) => state.setLlmApiStatus);
  const setLlmApiReportDetailLevel = useAsrStore((state) => state.setLlmApiReportDetailLevel);
  const setLlmApiReportEnabledFormat = useAsrStore((state) => state.setLlmApiReportEnabledFormat);

  const { enabledTemplates } = useReportTemplates();
  const [customTemplateSelections, setCustomTemplateSelections] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setCustomTemplateSelections((current) => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const template of enabledTemplates) {
        next[template.id] = current[template.id] ?? true;
        if (next[template.id] !== current[template.id]) changed = true;
      }
      if (Object.keys(current).length !== Object.keys(next).length) changed = true;
      return changed ? next : current;
    });
  }, [enabledTemplates]);
  const selectedCustomTemplates = useMemo(
    () => enabledTemplates.filter((template) => customTemplateSelections[template.id] ?? true),
    [customTemplateSelections, enabledTemplates]
  );
  const { status, progress, results, generateAll, downloadDocx } = useLlmReports({ selectedCustomTemplates });

  const [source, setSource] = useState<"transcription" | "text">("transcription");
  const [manualText, setManualText] = useState("");
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

  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  const canSelectMemorySource = availableTranscripts.length > 0;
  const memorySourceActive = source === "transcription" && Boolean(activeTranscript);
  const documentSourceActive = source === "text";

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
      await generateAll({ source: "transcription", transcriptMode: effectiveTranscriptMode, sourceText: transcriptionText });
      return;
    }

    await generateAll({ source: "text", text: manualText });
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
    setSource("transcription");
  };

  const selectMemorySource = () => {
    if (!canSelectMemorySource) return;
    setSource("transcription");
  };

  const selectDocumentSource = () => {
    setSource("text");
  };

  const handleSourcePanelKeyDown = (event: KeyboardEvent<HTMLElement>, selectSource: () => void) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectSource();
  };

  const runDownload = async (format: ReportResultKey) => {
    logger.info("[llm-api][ui] download requested", { format });
    emitLlmEvent("LLM_CLOUD_DOWNLOAD_REQUESTED", {
      format,
      provider: llmApiProvider,
      modelId: activePipelineConfig.modelId || "unset",
    });
    try {
      await downloadDocx(format);
      toast(`DOCX ${REPORT_DOWNLOAD_LABELS[format as BuiltInReportResultKey] ?? "compte rendu"} téléchargé.`);
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

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold">Rédaction</h2>
        <p className="text-muted-foreground">
          Sélectionnez une source, choisissez les formats, puis générez et relisez les comptes rendus.
        </p>
        <p className="text-sm font-medium text-amber-700">
          La configuration du provider, des clés API et du pipeline se règle dans Paramètres &gt; LLM Cloud.
        </p>
      </header>

      <div className="space-y-4">
        <Card data-testid="llm-source-card">
            <CardHeader>
              <CardTitle>Source</CardTitle>
              <CardDescription>Choisissez une transcription en mémoire ou importez un document.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-4 lg:grid-cols-2">
                <section
                  className={cn(
                    "rounded-md border bg-muted/20 p-4 transition-colors",
                    canSelectMemorySource ? "cursor-pointer hover:border-primary/70" : "cursor-not-allowed opacity-60",
                    memorySourceActive ? "border-primary bg-primary/5" : "border-border"
                  )}
                  role="button"
                  tabIndex={canSelectMemorySource ? 0 : -1}
                  aria-disabled={!canSelectMemorySource}
                  aria-labelledby="llm-memory-source-title"
                  data-testid="llm-memory-source-panel"
                  onClick={selectMemorySource}
                  onKeyDown={(event) => handleSourcePanelKeyDown(event, selectMemorySource)}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <h3 id="llm-memory-source-title" className="text-sm font-semibold text-foreground">
                        Charger depuis la transcription en mémoire
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        Utilisez la dernière transcription disponible dans cette session navigateur.
                      </p>
                    </div>
                    {memorySourceActive ? <Badge>Source active</Badge> : null}
                  </div>

                  {availableTranscripts.length > 1 ? (
                    <div className="mt-4 space-y-2">
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

                  <div className="mt-4 rounded-md border bg-background/70 p-3 text-xs text-muted-foreground">
                    {activeTranscript ? (
                      <>
                        <p>
                          Transcription disponible :{" "}
                          <span className="font-medium text-foreground">{activeTranscript.label}</span>
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
                      <p className="text-destructive">Aucune transcription disponible en mémoire.</p>
                    )}
                  </div>
                </section>

                <section
                  className={cn(
                    "cursor-pointer rounded-md border bg-muted/20 p-4 transition-colors hover:border-primary/70",
                    documentSourceActive ? "border-primary bg-primary/5" : "border-border"
                  )}
                  role="button"
                  tabIndex={0}
                  aria-labelledby="llm-document-source-title"
                  data-testid="llm-document-source-panel"
                  onClick={selectDocumentSource}
                  onKeyDown={(event) => handleSourcePanelKeyDown(event, selectDocumentSource)}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <h3 id="llm-document-source-title" className="text-sm font-semibold text-foreground">
                        Charger depuis un document de transcription ou une prise de note
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        Importez un fichier texte, DOCX ou sous-titres pour alimenter la rédaction.
                      </p>
                    </div>
                    {documentSourceActive ? <Badge>Source active</Badge> : null}
                  </div>

                  <div className="mt-4">
                    <Button type="button" onClick={triggerSourceFilePicker} disabled={isImporting || isBusy}>
                      {isImporting ? "Import en cours..." : "Choisir un fichier"}
                    </Button>
                    <span className="mt-2 block min-w-0 break-all text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {importedFileMeta ? importedFileMeta.name : "Aucun fichier importé"}
                    </span>
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
                    <p className="text-xs text-muted-foreground">
                      Formats acceptés : {TRANSCRIPT_IMPORT_LABEL}. Taille max : 50 Mo.
                    </p>
                  </div>

                  {source === "text" && !manualText.trim() ? (
                    <p className="text-xs text-destructive">Importez un fichier pour lancer la génération.</p>
                  ) : null}

                  {importedFileMeta ? (
                    <div className="mt-4 rounded-md border bg-background/70 p-3 text-xs text-muted-foreground">
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
                </section>
              </div>

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
              {isLlmTokenMissing ? (
                <p className="text-xs text-destructive">
                  {tokenRequiredMessage} Configurez la clé dans Paramètres &gt; LLM Cloud.
                </p>
              ) : null}
              {!pipelineConfigValid && hasAllowedProvider ? (
                <div className="rounded-md border border-destructive/60 bg-destructive/10 p-3 text-xs text-destructive">
                  <p className="font-medium">Configuration du pipeline incomplète</p>
                  <p className="mt-1">Renseignez l&apos;ID du modèle dans Paramètres &gt; LLM Cloud.</p>
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

          <ReportFormatSwitchesSection
            values={llmApiReportEnabledFormats}
            onChange={setLlmApiReportEnabledFormat}
            detailValues={llmApiReportDetailLevels}
            onDetailChange={setLlmApiReportDetailLevel}
            customTemplates={enabledTemplates}
            customTemplateValues={customTemplateSelections}
            onCustomTemplateChange={(templateId, value) =>
              setCustomTemplateSelections((current) => ({ ...current, [templateId]: value }))
            }
          />

          <div className="flex flex-wrap items-center justify-center gap-2" data-testid="llm-generation-actions">
            <Button onClick={runGeneration} disabled={!canGenerate}>
              Générer les comptes rendus
            </Button>
          </div>

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

          <ReportFormatResultsPanel
            results={results}
            enabledFormats={llmApiReportEnabledFormats}
            customTemplates={selectedCustomTemplates}
            onDownload={(format) => {
              void runDownload(format);
            }}
            emptyMessage="Les comptes rendus apparaîtront ici au fil de leur réception."
          />
      </div>
    </div>
  );
}

export default LLMApiPage;
