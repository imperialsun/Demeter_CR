import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ForegroundAlertDialog } from "@/components/ui/ForegroundAlertDialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/use-toast";
import { useAsrStore } from "@/store/asr-store";
import { useLlmLocalReports } from "@/hooks/useLlmLocalReports";
import { LLM_API_STATUS_META } from "@/lib/llm/llmStatusMeta";
import {
  LOCAL_LLM_MODEL_PROFILES,
  getLocalLlmModelProfile,
  resolveLocalLlmBackend,
  resolveLocalLlmBackendCandidates,
  resolveLocalLlmModelId,
  type LlmLocalModelProfile,
} from "@/lib/llm/localModelCatalog";
import { emitLlmEvent } from "@/lib/llm/telemetrySession";
import { parseTranscriptFile, type ParsedTranscriptFile } from "@/lib/transcript/parseTranscriptFile";
import { estimateTokenCount } from "@/lib/tokens";
import { formatTokenCount, resolveModelTokenBudget } from "@/lib/llm/modelCatalog";
import type { ReportResultKey } from "@/lib/llm/reportSchema";
import logger from "@/lib/logger";

const LLM_IMPORT_ACCEPT = ".txt,.srt,.vtt,.json,application/json,text/plain,text/vtt";

type ImportedFileMeta = {
  name: string;
  format: ParsedTranscriptFile["format"];
  extraction: ParsedTranscriptFile["extraction"];
  segmentCount?: number;
  charCount: number;
  tokenCount: number;
};

function LLMLocalPage() {
  const segments = useAsrStore((state) => state.segments);
  const webGpuSupported = useAsrStore((state) => state.webGpuSupported);
  const wasmAvailable = useAsrStore((state) => state.wasmAvailable);

  const llmLocalModelProfile = useAsrStore((state) => state.llmLocalModelProfile);
  const llmLocalModelId = useAsrStore((state) => state.llmLocalModelId);
  const llmLocalStatusDetail = useAsrStore((state) => state.llmLocalStatusDetail);
  const llmLocalModelSizeAlert = useAsrStore((state) => state.llmLocalModelSizeAlert);

  const setLlmLocalModelProfile = useAsrStore((state) => state.setLlmLocalModelProfile);
  const setLlmLocalModelId = useAsrStore((state) => state.setLlmLocalModelId);
  const setLlmLocalStatus = useAsrStore((state) => state.setLlmLocalStatus);
  const clearLlmLocalModelSizeAlert = useAsrStore((state) => state.clearLlmLocalModelSizeAlert);

  const { status, progress, results, isResettingSession, generateAll, resetSession, downloadDocx } = useLlmLocalReports();

  const [source, setSource] = useState<"transcription" | "text">("transcription");
  const [manualText, setManualText] = useState("");
  const [activeTab, setActiveTab] = useState<"cri" | "cro" | "crs">("cri");
  const [isImporting, setIsImporting] = useState(false);
  const [importedFileMeta, setImportedFileMeta] = useState<ImportedFileMeta | null>(null);
  const [pendingHeavyProfile, setPendingHeavyProfile] = useState<LlmLocalModelProfile | null>(null);
  const sourceFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    logger.info("[llm-local][ui] page view", { route: "/llmlocal", mode: "local" });
    emitLlmEvent("LLM_LOCAL_PAGE_VIEW", { route: "/llmlocal", mode: "local" });
  }, []);

  const selectedProfile = useMemo(() => getLocalLlmModelProfile(llmLocalModelProfile), [llmLocalModelProfile]);

  const backendCandidates = useMemo(
    () =>
      resolveLocalLlmBackendCandidates({
        profile: selectedProfile,
        webGpuSupported,
        wasmAvailable,
      }),
    [selectedProfile, wasmAvailable, webGpuSupported]
  );

  const backendResolution = useMemo(
    () =>
      resolveLocalLlmBackend({
        profile: selectedProfile,
        webGpuSupported,
        wasmAvailable,
      }),
    [selectedProfile, wasmAvailable, webGpuSupported]
  );

  const transcriptionText = useMemo(
    () =>
      segments
        .map((segment) => segment.text.trim())
        .filter((text) => text.length > 0)
        .join("\n"),
    [segments]
  );

  const sourceTextForBudget = source === "transcription" ? transcriptionText : manualText;
  const sourceTokenEstimate = useMemo(() => estimateTokenCount(sourceTextForBudget), [sourceTextForBudget]);

  const tokenBudget = useMemo(
    () =>
      resolveModelTokenBudget({
        modelId: selectedProfile.modelId,
        sourceTokens: sourceTokenEstimate,
        runtimeLimits: {
          contextWindowTokens: selectedProfile.contextWindowTokens,
          maxGenerationTokens: selectedProfile.maxGenerationTokens,
        },
      }),
    [selectedProfile, sourceTokenEstimate]
  );

  const meta = LLM_API_STATUS_META[status];
  const isBusy = isResettingSession || status === "preparing" || status === "generating" || status === "formatting";
  const hasSource = source === "transcription" ? transcriptionText.length > 0 : manualText.trim().length > 0;
  const sourceFitsModelContext = !tokenBudget.blockedByContext;
  const backendReady = Boolean(backendResolution.backend);
  const canGenerate = !isBusy && !isImporting && hasSource && sourceFitsModelContext && backendReady;
  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);

  const runGeneration = async () => {
    logger.info("[llm-local][ui] generation requested", {
      profile: llmLocalModelProfile,
      modelId: llmLocalModelId,
      source,
      sourceTokenEstimate,
    });
    emitLlmEvent("LLM_LOCAL_GENERATION_REQUESTED", {
      profile: llmLocalModelProfile,
      modelId: llmLocalModelId || "unset",
      sourceMode: source,
      sourceTokenEstimate,
    });

    if (!backendResolution.backend) {
      const message = backendResolution.error ?? "Aucun backend local disponible.";
      emitLlmEvent("LLM_LOCAL_GENERATION_BLOCKED", {
        profile: llmLocalModelProfile,
        modelId: llmLocalModelId || "unset",
        sourceMode: source,
        reason: "backend_unavailable",
        message,
      });
      setLlmLocalStatus("error", message);
      toast(message);
      return;
    }

    await generateAll({ source, text: source === "text" ? manualText : undefined });
  };

  const applyProfile = (profileId: LlmLocalModelProfile, reason: "direct" | "heavy_confirm" = "direct") => {
    logger.info("[llm-local][ui] profile changed", {
      previousProfile: llmLocalModelProfile,
      nextProfile: profileId,
      reason,
    });
    emitLlmEvent("LLM_LOCAL_PROFILE_CHANGE", {
      previousProfile: llmLocalModelProfile,
      nextProfile: profileId,
      reason,
    });
    setLlmLocalModelProfile(profileId);
    setLlmLocalModelId(resolveLocalLlmModelId(profileId));
  };

  const handleProfileChange = (value: string) => {
    const nextProfile = value as LlmLocalModelProfile;
    const profile = getLocalLlmModelProfile(nextProfile);
    if (profile.heavy) {
      logger.info("[llm-local][ui] heavy profile confirmation opened", {
        previousProfile: llmLocalModelProfile,
        nextProfile,
      });
      emitLlmEvent("LLM_LOCAL_HEAVY_PROFILE_PROMPT_OPEN", {
        previousProfile: llmLocalModelProfile,
        nextProfile,
      });
      setPendingHeavyProfile(nextProfile);
      return;
    }
    applyProfile(nextProfile);
  };

  const handleSourceChange = (value: string) => {
    const nextSource = value === "text" ? "text" : "transcription";
    logger.info("[llm-local][ui] source mode changed", {
      previousSource: source,
      nextSource,
      profile: llmLocalModelProfile,
      modelId: llmLocalModelId || "unset",
    });
    emitLlmEvent("LLM_LOCAL_SOURCE_CHANGE", {
      previousSource: source,
      nextSource,
      profile: llmLocalModelProfile,
      modelId: llmLocalModelId || "unset",
    });
    setSource(nextSource);
  };

  const runDownload = async (format: ReportResultKey) => {
    logger.info("[llm-local][ui] download requested", {
      format,
      profile: llmLocalModelProfile,
      modelId: llmLocalModelId || "unset",
    });
    emitLlmEvent("LLM_LOCAL_DOWNLOAD_REQUESTED", {
      format,
      profile: llmLocalModelProfile,
      modelId: llmLocalModelId || "unset",
    });
    try {
      await downloadDocx(format);
      toast(`DOCX ${format.toUpperCase()} telecharge.`);
      logger.info("[llm-local][ui] download completed", {
        format,
        profile: llmLocalModelProfile,
        modelId: llmLocalModelId || "unset",
      });
      emitLlmEvent("LLM_LOCAL_DOWNLOAD_DONE", {
        format,
        profile: llmLocalModelProfile,
        modelId: llmLocalModelId || "unset",
      });
    } catch (error) {
      toast((error as Error)?.message ?? "Impossible de telecharger le DOCX.");
      logger.error("[llm-local][ui] download failed", {
        format,
        profile: llmLocalModelProfile,
        modelId: llmLocalModelId || "unset",
        message: error instanceof Error ? error.message : String(error),
      });
      emitLlmEvent("LLM_LOCAL_DOWNLOAD_FAILED", {
        format,
        profile: llmLocalModelProfile,
        modelId: llmLocalModelId || "unset",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleSourceFileImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    logger.info("[llm-local][ui] source file import start", {
      fileName: file.name,
      sizeBytes: file.size,
      fileType: file.type,
      sourceMode: source,
      profile: llmLocalModelProfile,
      modelId: llmLocalModelId || "unset",
    });
    emitLlmEvent("LLM_LOCAL_IMPORT_START", {
      fileName: file.name,
      sizeBytes: file.size,
      fileType: file.type,
      sourceMode: source,
      profile: llmLocalModelProfile,
      modelId: llmLocalModelId || "unset",
    });

    try {
      const parsed = await parseTranscriptFile(file);
      const importedText = parsed.text.trim();
      const tokenCount = estimateTokenCount(importedText);

      if (source !== "text") {
        logger.info("[llm-local][ui] source mode changed by import", {
          previousSource: source,
          nextSource: "text",
          profile: llmLocalModelProfile,
          modelId: llmLocalModelId || "unset",
        });
        emitLlmEvent("LLM_LOCAL_SOURCE_CHANGE", {
          previousSource: source,
          nextSource: "text",
          reason: "file_import",
          profile: llmLocalModelProfile,
          modelId: llmLocalModelId || "unset",
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
        `Fichier importe: ${file.name} (${parsed.format.toUpperCase()}, ${formatTokenCount(importedText.length)} caracteres).`
      );
      logger.info("[llm-local][ui] source file import success", {
        fileName: file.name,
        format: parsed.format,
        extraction: parsed.extraction,
        textLength: importedText.length,
        tokenCount,
      });
      emitLlmEvent("LLM_LOCAL_IMPORT_SUCCESS", {
        fileName: file.name,
        format: parsed.format,
        extraction: parsed.extraction,
        textLength: importedText.length,
        tokenCount,
      });
    } catch (error) {
      toast((error as Error)?.message ?? "Impossible d'importer le fichier.");
      logger.error("[llm-local][ui] source file import failed", {
        fileName: file.name,
        message: error instanceof Error ? error.message : String(error),
      });
      emitLlmEvent("LLM_LOCAL_IMPORT_FAILED", {
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

  const handleResetSession = async () => {
    logger.info("[llm-local][ui] reset requested", {
      profile: llmLocalModelProfile,
      modelId: llmLocalModelId || "unset",
      sourceMode: source,
    });
    emitLlmEvent("LLM_LOCAL_RESET_REQUESTED", {
      profile: llmLocalModelProfile,
      modelId: llmLocalModelId || "unset",
      sourceMode: source,
    });
    setManualText("");
    setImportedFileMeta(null);
    try {
      await resetSession();
      logger.info("[llm-local][ui] reset completed", {
        profile: llmLocalModelProfile,
        modelId: llmLocalModelId || "unset",
        sourceMode: source,
      });
      emitLlmEvent("LLM_LOCAL_RESET_DONE", {
        profile: llmLocalModelProfile,
        modelId: llmLocalModelId || "unset",
        sourceMode: source,
      });
    } catch (error) {
      logger.error("[llm-local][ui] reset failed", {
        profile: llmLocalModelProfile,
        modelId: llmLocalModelId || "unset",
        sourceMode: source,
        message: error instanceof Error ? error.message : String(error),
      });
      emitLlmEvent("LLM_LOCAL_RESET_FAILED", {
        profile: llmLocalModelProfile,
        modelId: llmLocalModelId || "unset",
        sourceMode: source,
        message: error instanceof Error ? error.message : String(error),
      });
      toast((error as Error)?.message ?? "Impossible de reinitialiser la session locale.");
    }
  };

  return (
    <>
      <div className="space-y-8">
        <header className="space-y-2">
          <h2 className="text-2xl font-semibold">LLM Local</h2>
          <p className="text-muted-foreground">
            Generez les 3 formats CRI/CRO/CRS localement dans le navigateur, puis telechargez chaque compte rendu en DOCX.
          </p>
          <p className="text-sm font-medium text-emerald-600">
            Traitement 100% local sur ce poste: aucune donnee n'est partagee en dehors de ce poste.
          </p>
        </header>

        <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Configuration locale</CardTitle>
                <CardDescription>
                  Choisissez le profil modele local. Les reglages avances se font dans Parametres &gt; LLM Local.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="llm-local-profile">Profil modele</Label>
                  <Select value={llmLocalModelProfile} onValueChange={handleProfileChange}>
                    <SelectTrigger id="llm-local-profile">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LOCAL_LLM_MODEL_PROFILES.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          {profile.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground space-y-1">
                  <p className="text-sm font-medium text-foreground">Profil actif</p>
                  <p>
                    Modele: <span className="font-medium text-foreground">{selectedProfile.modelId}</span>
                  </p>
                  <p>
                    Contexte: <span className="font-medium text-foreground">{formatTokenCount(selectedProfile.contextWindowTokens)}</span>{" "}
                    tokens
                  </p>
                  <p>
                    Backend auto: <span className="font-medium text-foreground">{backendResolution.backend ?? "indisponible"}</span>
                  </p>
                  <p>
                    Ordre backend:{" "}
                    <span className="font-medium text-foreground">
                      {backendCandidates.length > 0 ? backendCandidates.map((backend) => backend.toUpperCase()).join(" -> ") : "aucun"}
                    </span>
                  </p>
                  {backendResolution.error ? <p className="text-destructive">{backendResolution.error}</p> : null}
                  {selectedProfile.heavyWarning ? <p className="text-warning">{selectedProfile.heavyWarning}</p> : null}
                </div>
                <div>
                  <Button asChild variant="outline" size="sm">
                    <a href="/settings?tab=llmlocal">Ouvrir parametres LLM Local</a>
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Source</CardTitle>
                <CardDescription>Choisissez la transcription de session ou un texte libre.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="llm-local-source">Mode d'entree</Label>
                  <Select value={source} onValueChange={handleSourceChange}>
                    <SelectTrigger id="llm-local-source">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="transcription">Depuis transcription</SelectItem>
                      <SelectItem value="text">Texte libre</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {source === "transcription" ? (
                  <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                    <p>
                      Segments disponibles: <span className="font-medium text-foreground">{segments.length}</span>
                    </p>
                    <p>
                      Taille source approx: <span className="font-medium text-foreground">{transcriptionText.length}</span> caracteres.
                    </p>
                    <p>
                      Tokens source approx:{" "}
                      <span className="font-medium text-foreground">{formatTokenCount(sourceTokenEstimate)}</span> tokens.
                    </p>
                    {!transcriptionText ? <p className="text-destructive">Aucune transcription active dans la session.</p> : null}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="rounded-md border bg-muted/20 p-3">
                      <p className="text-sm font-medium text-foreground">Import de transcription</p>
                      <p className="text-xs text-muted-foreground">
                        Importez un fichier texte pour alimenter la generation des comptes rendus.
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button type="button" onClick={triggerSourceFilePicker} disabled={isImporting || isBusy}>
                          {isImporting ? "Import en cours..." : "Choisir un fichier"}
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          {importedFileMeta ? importedFileMeta.name : "Aucun fichier importe"}
                        </span>
                      </div>
                      <Label htmlFor="llm-local-source-file" className="sr-only">
                        Importer un fichier transcription
                      </Label>
                      <input
                        ref={sourceFileInputRef}
                        id="llm-local-source-file"
                        type="file"
                        accept={LLM_IMPORT_ACCEPT}
                        onChange={handleSourceFileImport}
                        disabled={isImporting || isBusy}
                        className="sr-only"
                      />
                      <p className="mt-2 text-xs text-muted-foreground">
                        Formats acceptes: .txt, .srt, .vtt, .json. Taille max: 50 Mo.
                      </p>
                    </div>
                    {!manualText.trim() ? (
                      <p className="text-xs text-destructive">Importez un fichier pour lancer la generation.</p>
                    ) : null}
                    {importedFileMeta ? (
                      <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                        <p>
                          Fichier importe: <span className="font-medium text-foreground">{importedFileMeta.name}</span>
                        </p>
                        <p>
                          Format detecte:{" "}
                          <span className="font-medium text-foreground">{importedFileMeta.format.toUpperCase()}</span>
                        </p>
                        <p>
                          Taille texte importee:{" "}
                          <span className="font-medium text-foreground">
                            {formatTokenCount(importedFileMeta.charCount)}
                          </span>{" "}
                          caracteres.
                        </p>
                        <p>
                          Tokens du fichier importe approx:{" "}
                          <span className="font-medium text-foreground">
                            {formatTokenCount(importedFileMeta.tokenCount)}
                          </span>{" "}
                          tokens.
                        </p>
                        {typeof importedFileMeta.segmentCount === "number" ? (
                          <p>
                            Segments extraits:{" "}
                            <span className="font-medium text-foreground">
                              {formatTokenCount(importedFileMeta.segmentCount)}
                            </span>
                            .
                          </p>
                        ) : null}
                        <p>
                          Methode d'extraction:{" "}
                          <span className="font-medium text-foreground">{importedFileMeta.extraction}</span>.
                        </p>
                      </div>
                    ) : null}
                  </div>
                )}

                {!sourceFitsModelContext ? (
                  <p className="text-xs text-destructive">
                    Source trop longue pour ce profil local. Raccourcissez la source ou passez a un profil avec plus de contexte.
                  </p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Button onClick={runGeneration} disabled={!canGenerate}>
                    {isBusy ? "Generation en cours..." : "Generer les 3 formats"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      void handleResetSession();
                    }}
                    disabled={isResettingSession}
                  >
                    {isResettingSession ? "Réinitialisation..." : "Reinitialiser session locale"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Progression</CardTitle>
                <CardDescription>Pipeline local (preparation + generation CRI/CRO/CRS).</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant={meta.variant}>{meta.label}</Badge>
                    <Badge variant="outline">{percent}%</Badge>
                  </div>
                  {llmLocalStatusDetail ? <span className="text-sm text-muted-foreground">{llmLocalStatusDetail}</span> : null}
                </div>
                <Progress value={percent} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Apercu des formats</CardTitle>
                <CardDescription>Chaque format est present dans son bloc pour une lecture plus claire.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <FormatIntro format="CRI" description="CRI = restitution narrative fidele, tres detaillee, avec une redaction textuelle longue et complete." />
                  <FormatIntro format="CRO" description="CRO = compte rendu operationnel, axe decisions, actions, priorites et points a executer." />
                  <FormatIntro format="CRS" description="CRS = synthese ultra concise, uniquement l'essentiel critique en format tres court." />
                </div>

                <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "cri" | "cro" | "crs")}>
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="cri">CRI</TabsTrigger>
                    <TabsTrigger value="cro">CRO</TabsTrigger>
                    <TabsTrigger value="crs">CRS</TabsTrigger>
                  </TabsList>
                  <TabsContent value="cri" className="mt-4">
                    <FormatPreview format="cri" />
                  </TabsContent>
                  <TabsContent value="cro" className="mt-4">
                    <FormatPreview format="cro" />
                  </TabsContent>
                  <TabsContent value="crs" className="mt-4">
                    <FormatPreview format="crs" />
                  </TabsContent>
                </Tabs>

                <div className="grid gap-2 md:grid-cols-3">
                  <Button variant="outline" onClick={() => runDownload("cri")} disabled={!results.cri || isBusy}>
                    Telecharger CRI (.docx)
                  </Button>
                  <Button variant="outline" onClick={() => runDownload("cro")} disabled={!results.cro || isBusy}>
                    Telecharger CRO (.docx)
                  </Button>
                  <Button variant="outline" onClick={() => runDownload("crs")} disabled={!results.crs || isBusy}>
                    Telecharger CRS (.docx)
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={pendingHeavyProfile !== null}
        title="Activer Ministral 3 3B ?"
        description="Ce profil est lourd (telechargement + memoire). En cas d'erreur de memoire, l'application basculera automatiquement vers Qwen 1.7B."
        onCancel={() => {
          logger.info("[llm-local][ui] heavy profile confirmation cancelled", {
            previousProfile: llmLocalModelProfile,
            pendingProfile: pendingHeavyProfile,
          });
          emitLlmEvent("LLM_LOCAL_HEAVY_PROFILE_CANCELLED", {
            previousProfile: llmLocalModelProfile,
            pendingProfile: pendingHeavyProfile,
          });
          setPendingHeavyProfile(null);
        }}
        onConfirm={() => {
          if (pendingHeavyProfile) {
            logger.info("[llm-local][ui] heavy profile confirmation accepted", {
              previousProfile: llmLocalModelProfile,
              nextProfile: pendingHeavyProfile,
            });
            emitLlmEvent("LLM_LOCAL_HEAVY_PROFILE_CONFIRMED", {
              previousProfile: llmLocalModelProfile,
              nextProfile: pendingHeavyProfile,
            });
            applyProfile(pendingHeavyProfile, "heavy_confirm");
          }
          setPendingHeavyProfile(null);
        }}
      />
      <ForegroundAlertDialog
        open={Boolean(llmLocalModelSizeAlert)}
        title={llmLocalModelSizeAlert?.title ?? "Alerte modele local"}
        description={llmLocalModelSizeAlert?.description ?? ""}
        severity={llmLocalModelSizeAlert?.severity ?? "warning"}
        onClose={clearLlmLocalModelSizeAlert}
      />
    </>
  );
}

function FormatIntro({ format, description }: { format: string; description: string }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <p className="text-sm font-semibold">{format}</p>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function FormatPreview({ format }: { format: ReportResultKey }) {
  const result = useAsrStore((state) => state.llmLocalResults[format]);

  if (!result) {
    return (
      <div className="rounded-md border bg-muted/20 p-4 text-sm text-muted-foreground">
        Aucun resultat {format.toUpperCase()} pour le moment.
      </div>
    );
  }

  const report = result.report;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{report.format}</Badge>
        <Badge variant="outline">{result.modelId}</Badge>
        <Badge variant="outline">{result.strategy}</Badge>
        <Badge variant="outline">passes {result.pipelinePasses}</Badge>
      </div>

      <div className="space-y-1">
        <h3 className="text-lg font-semibold">{report.title}</h3>
        {report.subtitle ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{report.subtitle}</p>
        ) : null}
      </div>

      {report.sections.map((section) => (
        <div key={`${format}-${section.heading}`} className="rounded-md border bg-background p-4">
          <h4 className="mb-2 text-sm font-semibold">{section.heading}</h4>
          <div className="space-y-2">
            {section.paragraphs.map((paragraph, index) => (
              <TextBlocks key={`${section.heading}-${index}`} text={paragraph} />
            ))}
          </div>
        </div>
      ))}

      <OptionalList title="Points cles" values={report.key_points} />
      <OptionalList title="Actions" values={report.action_items} />
      <OptionalList title="Points de vigilance" values={report.caveats} />
    </div>
  );
}

function OptionalList({ title, values }: { title: string; values?: string[] }) {
  if (!values?.length) return null;

  return (
    <div className="rounded-md border bg-muted/20 p-4">
      <p className="mb-2 text-sm font-semibold">{title}</p>
      <ul className="space-y-2 text-sm text-muted-foreground">
        {values.map((value, index) => (
          <li key={`${title}-${index}`} className="rounded-md border border-border/60 bg-background px-3 py-2">
            <span className="whitespace-pre-wrap leading-relaxed">{value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TextBlocks({ text }: { text: string }) {
  const blocks = splitIntoBlocks(text);
  if (!blocks.length) return null;

  return (
    <div className="space-y-2">
      {blocks.map((block, index) => (
        <p
          key={`${index}-${block.slice(0, 16)}`}
          className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90"
        >
          {block}
        </p>
      ))}
    </div>
  );
}

function splitIntoBlocks(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

export default LLMLocalPage;
