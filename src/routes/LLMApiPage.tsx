import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/use-toast";
import { useAsrStore, type LlmApiProvider } from "@/store/asr-store";
import { useLlmReports } from "@/hooks/useLlmReports";
import { buildReportFormatDescription } from "@/lib/llm/reportPrompts";
import { LLM_API_STATUS_META } from "@/lib/llm/llmStatusMeta";
import type { ReportResultKey } from "@/lib/llm/reportSchema";
import {
  findSuggestedReportModel,
  formatTokenCount,
  resolveModelTokenBudget,
  resolveSuggestedModelMaxTokens,
  SUGGESTED_REPORT_MODELS,
} from "@/lib/llm/modelCatalog";
import {
  DEFAULT_MISTRAL_LLM_MODEL_ID,
  FALLBACK_MISTRAL_MAX_TOKENS,
  fetchMistralModelsSafe,
  findMistralModelMetadata,
  resolveMistralMaxTokens,
  type MistralModelMetadata,
} from "@/lib/llm/mistralModelsClient";
import { parseTranscriptFile, type ParsedTranscriptFile } from "@/lib/transcript/parseTranscriptFile";
import { estimateTokenCount } from "@/lib/tokens";
import logger from "@/lib/logger";

const FORMAT_PREVIEW_META = [
  { format: "CRI" as const, description: buildReportFormatDescription("CRI") },
  { format: "CRO" as const, description: buildReportFormatDescription("CRO") },
  { format: "CRS" as const, description: buildReportFormatDescription("CRS") },
];

const LLM_HF_TOKEN_REQUIRED_MESSAGE = "Ce module ne peut pas fonctionner sans cle API Hugging Face.";
const LLM_MISTRAL_TOKEN_REQUIRED_MESSAGE = "Ce module ne peut pas fonctionner sans cle API Mistral.";
const LLM_IMPORT_ACCEPT = ".txt,.srt,.vtt,.json,application/json,text/plain,text/vtt";

type ImportedFileMeta = {
  name: string;
  format: ParsedTranscriptFile["format"];
  extraction: ParsedTranscriptFile["extraction"];
  segmentCount?: number;
  charCount: number;
  tokenCount: number;
};

function LLMApiPage() {
  const segments = useAsrStore((state) => state.segments);
  const llmApiProvider = useAsrStore((state) => state.llmApiProvider);
  const llmApiHfToken = useAsrStore((state) => state.llmApiHfToken);
  const llmApiModelId = useAsrStore((state) => state.llmApiModelId);
  const llmApiTemperature = useAsrStore((state) => state.llmApiTemperature);
  const llmApiMaxTokens = useAsrStore((state) => state.llmApiMaxTokens);
  const llmApiStatusDetail = useAsrStore((state) => state.llmApiStatusDetail);
  const cloudMistralApiKey = useAsrStore((state) => state.cloudMistralApiKey);
  const cloudMistralApiUrl = useAsrStore((state) => state.cloudMistralApiUrl);

  const setLlmApiProvider = useAsrStore((state) => state.setLlmApiProvider);
  const setLlmApiHfToken = useAsrStore((state) => state.setLlmApiHfToken);
  const setLlmApiModelId = useAsrStore((state) => state.setLlmApiModelId);
  const setLlmApiTemperature = useAsrStore((state) => state.setLlmApiTemperature);
  const setLlmApiMaxTokens = useAsrStore((state) => state.setLlmApiMaxTokens);
  const setLlmApiStatus = useAsrStore((state) => state.setLlmApiStatus);
  const resetLlmApiSession = useAsrStore((state) => state.resetLlmApiSession);
  const setCloudMistralApiKey = useAsrStore((state) => state.setCloudMistralApiKey);
  const setCloudMistralApiUrl = useAsrStore((state) => state.setCloudMistralApiUrl);

  const { status, progress, results, generateAll, downloadDocx } = useLlmReports();

  const [source, setSource] = useState<"transcription" | "text">("transcription");
  const [manualText, setManualText] = useState("");
  const [activeTab, setActiveTab] = useState<"cri" | "cro" | "crs">("cri");
  const [isImporting, setIsImporting] = useState(false);
  const [importedFileMeta, setImportedFileMeta] = useState<ImportedFileMeta | null>(null);
  const [mistralModels, setMistralModels] = useState<MistralModelMetadata[]>([]);
  const [mistralModelMetadata, setMistralModelMetadata] = useState<MistralModelMetadata | null>(null);
  const [isMistralModelsLoading, setIsMistralModelsLoading] = useState(false);
  const sourceFileInputRef = useRef<HTMLInputElement | null>(null);

  const transcriptionText = useMemo(() => {
    return segments
      .map((segment) => segment.text.trim())
      .filter((text) => text.length > 0)
      .join("\n");
  }, [segments]);
  const transcriptionTokenEstimate = useMemo(() => estimateTokenCount(transcriptionText), [transcriptionText]);

  useEffect(() => {
    if (llmApiProvider !== "mistral") {
      setMistralModels([]);
      setMistralModelMetadata(null);
      setIsMistralModelsLoading(false);
      return;
    }

    const key = cloudMistralApiKey.trim();
    if (!key) {
      setMistralModels([]);
      setMistralModelMetadata(null);
      setIsMistralModelsLoading(false);
      return;
    }

    let cancelled = false;
    setIsMistralModelsLoading(true);
    logger.info("[llm-api][ui] mistral model list loading", {
      apiUrl: cloudMistralApiUrl,
    });
    void (async () => {
      const models = await fetchMistralModelsSafe({
        apiUrl: cloudMistralApiUrl,
        apiKey: key,
      });
      if (cancelled) return;
      const sortedModels = [...models].sort((a, b) => a.id.localeCompare(b.id));
      setMistralModels(sortedModels);
      setIsMistralModelsLoading(false);
      logger.info("[llm-api][ui] mistral model list loaded", {
        modelCount: sortedModels.length,
        apiUrl: cloudMistralApiUrl,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [cloudMistralApiKey, cloudMistralApiUrl, llmApiProvider]);

  useEffect(() => {
    if (llmApiProvider !== "mistral") return;
    setMistralModelMetadata(findMistralModelMetadata(mistralModels, llmApiModelId) ?? null);
  }, [llmApiModelId, llmApiProvider, mistralModels]);

  useEffect(() => {
    if (llmApiProvider !== "mistral") return;
    const currentModelId = llmApiModelId.trim();
    if (!currentModelId || findSuggestedReportModel(currentModelId)) {
      setLlmApiModelId(DEFAULT_MISTRAL_LLM_MODEL_ID);
    }
  }, [llmApiModelId, llmApiProvider, setLlmApiModelId]);

  const sourceTextForBudget = source === "transcription" ? transcriptionText : manualText;
  const sourceTokenEstimate = useMemo(() => estimateTokenCount(sourceTextForBudget), [sourceTextForBudget]);
  const selectedSuggestedModel = useMemo(
    () => (llmApiProvider === "huggingface" ? findSuggestedReportModel(llmApiModelId) : undefined),
    [llmApiModelId, llmApiProvider]
  );
  const runtimeLimits = useMemo(
    () =>
      llmApiProvider === "mistral" && typeof mistralModelMetadata?.maxContextTokens === "number"
        ? { contextWindowTokens: mistralModelMetadata.maxContextTokens }
        : undefined,
    [llmApiProvider, mistralModelMetadata]
  );
  const settingMaxTokens = useMemo(() => {
    if (llmApiProvider === "mistral") {
      return resolveMistralMaxTokens(mistralModelMetadata ?? undefined);
    }
    return resolveSuggestedModelMaxTokens(llmApiModelId);
  }, [llmApiModelId, llmApiProvider, mistralModelMetadata]);
  const tokenBudget = useMemo(
    () =>
      resolveModelTokenBudget({
        modelId: llmApiModelId,
        sourceTokens: sourceTokenEstimate,
        runtimeLimits,
      }),
    [llmApiModelId, runtimeLimits, sourceTokenEstimate]
  );
  const modelTokenCap = tokenBudget.effectiveMaxGenerationTokens;
  const sourceFitsModelContext = !tokenBudget.blockedByContext;

  const meta = LLM_API_STATUS_META[status];
  const isBusy = status === "preparing" || status === "generating" || status === "formatting";
  const hasSource = source === "transcription" ? transcriptionText.length > 0 : manualText.trim().length > 0;
  const tokenRequiredMessage =
    llmApiProvider === "huggingface" ? LLM_HF_TOKEN_REQUIRED_MESSAGE : LLM_MISTRAL_TOKEN_REQUIRED_MESSAGE;
  const isLlmTokenMissing =
    llmApiProvider === "huggingface" ? llmApiHfToken.trim().length === 0 : cloudMistralApiKey.trim().length === 0;
  const canGenerate =
    !isBusy &&
    !isImporting &&
    hasSource &&
    sourceFitsModelContext &&
    llmApiModelId.trim().length > 0;
  const modelSelectValue = selectedSuggestedModel ? selectedSuggestedModel.id : "__custom__";
  const selectedMistralModel = useMemo(
    () => (llmApiProvider === "mistral" ? findMistralModelMetadata(mistralModels, llmApiModelId) : undefined),
    [llmApiModelId, llmApiProvider, mistralModels]
  );
  const mistralModelSelectValue = selectedMistralModel?.id ?? "__custom__";

  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);

  useEffect(() => {
    if (typeof settingMaxTokens !== "number") return;
    if (llmApiMaxTokens !== settingMaxTokens) {
      setLlmApiMaxTokens(settingMaxTokens);
    }
  }, [llmApiMaxTokens, setLlmApiMaxTokens, settingMaxTokens]);

  const runGeneration = async () => {
    logger.info("[llm-api][ui] generation requested", {
      provider: llmApiProvider,
      source,
      modelId: llmApiModelId,
      sourceTokenEstimate,
    });
    if (isLlmTokenMissing) {
      logger.warn("[llm-api][ui] generation blocked: missing token", {
        provider: llmApiProvider,
      });
      setLlmApiStatus("error", tokenRequiredMessage);
      toast(tokenRequiredMessage);
      return;
    }
    await generateAll({ source, text: source === "text" ? manualText : undefined });
  };

  const handleProviderChange = (value: string) => {
    const nextProvider: LlmApiProvider = value === "mistral" ? "mistral" : "huggingface";
    logger.info("[llm-api][ui] provider changed", { previousProvider: llmApiProvider, nextProvider });
    setLlmApiProvider(nextProvider);
  };

  const runDownload = async (format: ReportResultKey) => {
    logger.info("[llm-api][ui] download requested", { format });
    try {
      await downloadDocx(format);
      toast(`DOCX ${format.toUpperCase()} telecharge.`);
      logger.info("[llm-api][ui] download completed", { format });
    } catch (error) {
      toast((error as Error)?.message ?? "Impossible de telecharger le DOCX.");
      logger.error("[llm-api][ui] download failed", {
        format,
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
    try {
      const parsed = await parseTranscriptFile(file);
      const importedText = parsed.text.trim();
      const tokenCount = estimateTokenCount(importedText);

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
      logger.info("[llm-api][ui] source file import success", {
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
        <h2 className="text-2xl font-semibold">LLM Cloud</h2>
        <p className="text-muted-foreground">
          Generez les 3 formats CRI/CRO/CRS via provider LLM cloud, puis telechargez chaque compte rendu en DOCX.
        </p>
      </header>

      <div className="grid gap-6 xl:grid-cols-[380px,1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Configuration API</CardTitle>
              <CardDescription>Token, modele et parametres de generation.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="llm-provider">Provider LLM</Label>
                <Select value={llmApiProvider} onValueChange={handleProviderChange}>
                  <SelectTrigger id="llm-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="huggingface">Hugging Face</SelectItem>
                    <SelectItem value="mistral">Mistral</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {llmApiProvider === "huggingface" ? (
                <div className="space-y-2">
                  <Label htmlFor="llm-api-token">Token Hugging Face</Label>
                  <Input
                    id="llm-api-token"
                    type="password"
                    value={llmApiHfToken}
                    onChange={(event) => setLlmApiHfToken(event.target.value)}
                    placeholder="hf_..."
                    autoComplete="off"
                  />
                  {isLlmTokenMissing ? <p className="text-xs text-destructive">{tokenRequiredMessage}</p> : null}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="llm-mistral-api-key">Cle API Mistral</Label>
                    <Input
                      id="llm-mistral-api-key"
                      type="password"
                      value={cloudMistralApiKey}
                      onChange={(event) => setCloudMistralApiKey(event.target.value)}
                      placeholder="mistral_..."
                      autoComplete="off"
                    />
                    {isLlmTokenMissing ? <p className="text-xs text-destructive">{tokenRequiredMessage}</p> : null}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="llm-mistral-api-url">URL API Mistral</Label>
                    <Input
                      id="llm-mistral-api-url"
                      value={cloudMistralApiUrl}
                      onChange={(event) => setCloudMistralApiUrl(event.target.value)}
                      placeholder="https://api.mistral.ai"
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">
                      Cle et URL partagees avec la page /cloudupload.
                    </p>
                  </div>
                </div>
              )}

              {llmApiProvider === "huggingface" ? (
                <div className="space-y-2">
                  <Label htmlFor="llm-model-preset">Modele suggere</Label>
                  <Select
                    value={modelSelectValue}
                    onValueChange={(value) => {
                      if (value !== "__custom__") {
                        setLlmApiModelId(value);
                      }
                    }}
                  >
                    <SelectTrigger id="llm-model-preset">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SUGGESTED_REPORT_MODELS.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {`${model.label} (${formatTokenCount(model.contextWindowTokens)} ctx)`}
                        </SelectItem>
                      ))}
                      <SelectItem value="__custom__">Modele personnalise</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="llm-mistral-model-preset">Modeles Mistral disponibles</Label>
                  <Select
                    value={mistralModelSelectValue}
                    onValueChange={(value) => {
                      if (value !== "__custom__") {
                        setLlmApiModelId(value);
                      }
                    }}
                    disabled={isMistralModelsLoading || isLlmTokenMissing}
                  >
                    <SelectTrigger id="llm-mistral-model-preset">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {mistralModels.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {typeof model.maxContextTokens === "number"
                            ? `${model.id} (${formatTokenCount(model.maxContextTokens)} ctx)`
                            : model.id}
                        </SelectItem>
                      ))}
                      <SelectItem value="__custom__">Model ID personnalise</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {isLlmTokenMissing
                      ? "Renseignez la cle API Mistral pour charger la liste."
                      : isMistralModelsLoading
                        ? "Chargement automatique des modeles Mistral..."
                        : mistralModels.length > 0
                          ? `${formatTokenCount(mistralModels.length)} modeles detectes via /v1/models.`
                          : "Aucun modele detecte: vous pouvez saisir un Model ID manuellement."}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="llm-model-id">Model ID</Label>
                <Input
                  id="llm-model-id"
                  value={llmApiModelId}
                  onChange={(event) => setLlmApiModelId(event.target.value)}
                  placeholder={llmApiProvider === "mistral" ? DEFAULT_MISTRAL_LLM_MODEL_ID : "openai/gpt-oss-20b"}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="llm-temperature">Temperature</Label>
                  <Input
                    id="llm-temperature"
                    type="number"
                    step={0.1}
                    min={0}
                    max={2}
                    value={llmApiTemperature}
                    onChange={(event) => setLlmApiTemperature(Number(event.target.value))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="llm-max-tokens">Max tokens</Label>
                  <Input
                    id="llm-max-tokens"
                    type="number"
                    min={128}
                    max={settingMaxTokens}
                    step={128}
                    value={llmApiMaxTokens}
                    disabled={llmApiProvider === "mistral" || Boolean(selectedSuggestedModel)}
                    onChange={(event) => setLlmApiMaxTokens(Number(event.target.value))}
                  />
                </div>
              </div>

              <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                {llmApiProvider === "huggingface" && selectedSuggestedModel ? (
                  <div className="space-y-1">
                    <p>
                      Contexte modele:{" "}
                      <span className="font-medium text-foreground">
                        {formatTokenCount(selectedSuggestedModel.contextWindowTokens)}
                      </span>{" "}
                      tokens.
                    </p>
                    <p>
                      Sortie max officielle:{" "}
                      <span className="font-medium text-foreground">
                        {typeof tokenBudget.modelMaxGenerationTokens === "number"
                          ? formatTokenCount(tokenBudget.modelMaxGenerationTokens)
                          : "non publiee"}
                      </span>
                      .
                    </p>
                    <p>
                      Max tokens regle automatiquement:{" "}
                      <span className="font-medium text-foreground">
                        {typeof settingMaxTokens === "number" ? formatTokenCount(settingMaxTokens) : "non calcule"}
                      </span>{" "}
                      tokens.
                    </p>
                    <p>
                      Cap selon la source actuelle (~{formatTokenCount(sourceTokenEstimate)} tokens):{" "}
                      <span className="font-medium text-foreground">
                        {typeof modelTokenCap === "number" ? formatTokenCount(modelTokenCap) : "non calcule"}
                      </span>{" "}
                      tokens.
                    </p>
                    {tokenBudget.blockedByContext ? (
                      <p className="font-medium text-destructive">
                        Source trop longue pour ce modele. Reduisez la source ou choisissez un modele avec plus de
                        contexte.
                      </p>
                    ) : null}
                  </div>
                ) : llmApiProvider === "mistral" ? (
                  <div className="space-y-1">
                    <p>
                      Contexte modele:{" "}
                      <span className="font-medium text-foreground">
                        {typeof mistralModelMetadata?.maxContextTokens === "number"
                          ? formatTokenCount(mistralModelMetadata.maxContextTokens)
                          : "non publie"}
                      </span>{" "}
                      tokens.
                    </p>
                    <p>
                      Max tokens regle automatiquement:{" "}
                      <span className="font-medium text-foreground">{formatTokenCount(settingMaxTokens ?? FALLBACK_MISTRAL_MAX_TOKENS)}</span>{" "}
                      tokens.
                    </p>
                    <p>
                      Cap selon la source actuelle (~{formatTokenCount(sourceTokenEstimate)} tokens):{" "}
                      <span className="font-medium text-foreground">
                        {typeof modelTokenCap === "number" ? formatTokenCount(modelTokenCap) : "non calcule"}
                      </span>{" "}
                      tokens.
                    </p>
                    {isMistralModelsLoading ? (
                      <p>Chargement des metadonnees du modele Mistral...</p>
                    ) : !mistralModelMetadata ? (
                      <p>
                        Metadonnees Mistral indisponibles: fallback {formatTokenCount(FALLBACK_MISTRAL_MAX_TOKENS)} tokens.
                      </p>
                    ) : null}
                    {tokenBudget.blockedByContext ? (
                      <p className="font-medium text-destructive">
                        Source trop longue pour ce modele. Reduisez la source ou choisissez un modele avec plus de
                        contexte.
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p>Modele personnalise: limites de tokens non verifiees automatiquement.</p>
                )}
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
                <Label htmlFor="llm-source">Mode d'entree</Label>
                <Select value={source} onValueChange={(value) => setSource(value as "transcription" | "text")}>
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
                <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                  <p>
                    Segments disponibles: <span className="font-medium text-foreground">{segments.length}</span>
                  </p>
                  <p>
                    Taille source approx: <span className="font-medium text-foreground">{transcriptionText.length}</span>{" "}
                    caracteres.
                  </p>
                  <p>
                    Tokens source approx:{" "}
                    <span className="font-medium text-foreground">{formatTokenCount(transcriptionTokenEstimate)}</span>{" "}
                    tokens.
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
                    <Label htmlFor="llm-source-file" className="sr-only">
                      Importer un fichier transcription
                    </Label>
                    <input
                      ref={sourceFileInputRef}
                      id="llm-source-file"
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

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={runGeneration} disabled={!canGenerate}>
                  Generer les 3 formats
                </Button>
                <Button variant="outline" onClick={resetLlmApiSession} disabled={isBusy}>
                  Reinitialiser session LLM
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Progression</CardTitle>
              <CardDescription>Pipeline long input + generation CRI/CRO/CRS.</CardDescription>
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
              <CardTitle>Apercu des formats</CardTitle>
              <CardDescription>Chaque format est presente dans son bloc pour une lecture plus claire.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 md:grid-cols-3">
                {FORMAT_PREVIEW_META.map((item) => (
                  <div key={item.format} className="rounded-md border bg-muted/20 p-3">
                    <p className="text-xs font-semibold tracking-wide text-foreground">{item.format}</p>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                      {item.description}
                    </p>
                  </div>
                ))}
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

              <div className="flex flex-wrap gap-2 border-t pt-4">
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
  );
}

function FormatPreview({ format }: { format: ReportResultKey }) {
  const result = useAsrStore((state) => state.llmApiResults[format]);

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

export default LLMApiPage;
