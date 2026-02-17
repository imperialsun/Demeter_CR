import { useMemo, useRef, useState, type ChangeEvent } from "react";
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
  formatTokenCount,
  resolveModelTokenBudget,
} from "@/lib/llm/modelCatalog";
import { resolveActiveLlmPipelineConfig } from "@/lib/llm/providerSettings";
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
const LLM_PIPELINE_CONFIG_REQUIRED_MESSAGE =
  "Configuration pipeline incomplete: renseignez le Model ID dans Parametres > LLM Cloud.";
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
  const llmApiHfModelId = useAsrStore((state) => state.llmApiHfModelId);
  const llmApiHfTemperature = useAsrStore((state) => state.llmApiHfTemperature);
  const llmApiHfMaxTokens = useAsrStore((state) => state.llmApiHfMaxTokens);
  const llmApiMistralModelId = useAsrStore((state) => state.llmApiMistralModelId);
  const llmApiMistralTemperature = useAsrStore((state) => state.llmApiMistralTemperature);
  const llmApiMistralMaxTokens = useAsrStore((state) => state.llmApiMistralMaxTokens);
  const llmApiStatusDetail = useAsrStore((state) => state.llmApiStatusDetail);
  const cloudMistralApiKey = useAsrStore((state) => state.cloudMistralApiKey);

  const setLlmApiProvider = useAsrStore((state) => state.setLlmApiProvider);
  const setLlmApiHfToken = useAsrStore((state) => state.setLlmApiHfToken);
  const setLlmApiStatus = useAsrStore((state) => state.setLlmApiStatus);
  const resetLlmApiSession = useAsrStore((state) => state.resetLlmApiSession);
  const setCloudMistralApiKey = useAsrStore((state) => state.setCloudMistralApiKey);

  const { status, progress, results, generateAll, downloadDocx } = useLlmReports();

  const [source, setSource] = useState<"transcription" | "text">("transcription");
  const [manualText, setManualText] = useState("");
  const [activeTab, setActiveTab] = useState<"cri" | "cro" | "crs">("cri");
  const [isImporting, setIsImporting] = useState(false);
  const [importedFileMeta, setImportedFileMeta] = useState<ImportedFileMeta | null>(null);
  const sourceFileInputRef = useRef<HTMLInputElement | null>(null);

  const transcriptionText = useMemo(() => {
    return segments
      .map((segment) => segment.text.trim())
      .filter((text) => text.length > 0)
      .join("\n");
  }, [segments]);
  const transcriptionTokenEstimate = useMemo(() => estimateTokenCount(transcriptionText), [transcriptionText]);

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
    llmApiProvider === "huggingface" ? LLM_HF_TOKEN_REQUIRED_MESSAGE : LLM_MISTRAL_TOKEN_REQUIRED_MESSAGE;
  const isLlmTokenMissing =
    llmApiProvider === "huggingface" ? llmApiHfToken.trim().length === 0 : cloudMistralApiKey.trim().length === 0;
  const pipelineConfigValid = activePipelineConfig.modelId.trim().length > 0;
  const sourceFitsModelContext = !tokenBudget.blockedByContext;
  const canGenerate = !isBusy && !isImporting && hasSource && sourceFitsModelContext && pipelineConfigValid;

  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);

  const runGeneration = async () => {
    logger.info("[llm-api][ui] generation requested", {
      provider: llmApiProvider,
      source,
      modelId: activePipelineConfig.modelId,
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

    if (!pipelineConfigValid) {
      logger.warn("[llm-api][ui] generation blocked: invalid pipeline config", {
        modelId: activePipelineConfig.modelId,
      });
      setLlmApiStatus("error", LLM_PIPELINE_CONFIG_REQUIRED_MESSAGE);
      toast(LLM_PIPELINE_CONFIG_REQUIRED_MESSAGE);
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
              <CardDescription>Provider et tokens d'acces. Le pipeline LLM se regle dans Parametres.</CardDescription>
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
                  <p className="text-xs text-muted-foreground">Cle partagee avec la page /cloudupload.</p>
                  {isLlmTokenMissing ? <p className="text-xs text-destructive">{tokenRequiredMessage}</p> : null}
                </div>
              )}

              <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                <p className="text-sm font-medium text-foreground">Configuration pipeline</p>
                <p className="mt-1">
                  Provider: <span className="font-medium text-foreground">{llmApiProvider === "mistral" ? "Mistral" : "Hugging Face"}</span>
                </p>
                <p>
                  Model ID:{" "}
                  <span className="font-medium text-foreground">{activePipelineConfig.modelId.trim() || "non defini"}</span>
                </p>
                <p>
                  Temperature: <span className="font-medium text-foreground">{activePipelineConfig.temperature}</span>
                </p>
                <p>
                  Max tokens:{" "}
                  <span className="font-medium text-foreground">{formatTokenCount(activePipelineConfig.maxTokens)}</span>
                </p>
                <div className="mt-3">
                  <Button asChild variant="outline" size="sm">
                    <a href="/settings?tab=llm">Ouvrir parametres LLM</a>
                  </Button>
                </div>
              </div>

              {!pipelineConfigValid ? (
                <div className="rounded-md border border-destructive/60 bg-destructive/10 p-3 text-xs text-destructive">
                  <p className="font-medium">Configuration pipeline incomplete</p>
                  <p className="mt-1">Le module /llmapi ne peut pas fonctionner sans Model ID configure.</p>
                  <div className="mt-3">
                    <Button asChild variant="outline" size="sm">
                      <a href="/settings?tab=llm">Ouvrir parametres LLM</a>
                    </Button>
                  </div>
                </div>
              ) : null}
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

              {!sourceFitsModelContext ? (
                <p className="text-xs text-destructive">
                  Source trop longue pour ce modele. Ajustez le pipeline dans Parametres &gt; LLM Cloud.
                </p>
              ) : null}

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
