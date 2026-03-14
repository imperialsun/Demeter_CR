import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAsrStore } from "@/store/asr-store";
import logger from "@/lib/logger";
import {
  findSuggestedReportModel,
  formatTokenCount,
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
import { DEMETER_SANTE_MAX_TOKENS } from "@/lib/llm/providerSettings";
import { SESSION_ONLY_SECRET_NOTICE } from "@/lib/secret-storage-copy";

interface LlmCloudSettingsTabProps {
  showHuggingFace?: boolean;
  showMistral?: boolean;
  showDemeter?: boolean;
}

export function LlmCloudSettingsTab({
  showHuggingFace = true,
  showMistral = true,
  showDemeter = true,
}: LlmCloudSettingsTabProps) {
  const {
    llmApiProvider,
    hfApiToken,
    llmApiHfModelId,
    llmApiHfTemperature,
    llmApiHfMaxTokens,
    llmApiMistralModelId,
    llmApiMistralTemperature,
    llmApiMistralMaxTokens,
    mistralApiKey,
    cloudMistralApiUrl,
    setHfApiToken,
    setLlmApiHfModelId,
    setLlmApiHfTemperature,
    setLlmApiHfMaxTokens,
    setLlmApiMistralModelId,
    setLlmApiMistralTemperature,
    setLlmApiMistralMaxTokens,
    setMistralApiKey,
    setCloudMistralApiUrl,
  } = useAsrStore(
    useShallow((state) => ({
      llmApiProvider: state.llmApiProvider,
      hfApiToken: state.hfApiToken,
      llmApiHfModelId: state.llmApiHfModelId,
      llmApiHfTemperature: state.llmApiHfTemperature,
      llmApiHfMaxTokens: state.llmApiHfMaxTokens,
      llmApiMistralModelId: state.llmApiMistralModelId,
      llmApiMistralTemperature: state.llmApiMistralTemperature,
      llmApiMistralMaxTokens: state.llmApiMistralMaxTokens,
      mistralApiKey: state.mistralApiKey,
      cloudMistralApiUrl: state.cloudMistralApiUrl,
      setHfApiToken: state.setHfApiToken,
      setLlmApiHfModelId: state.setLlmApiHfModelId,
      setLlmApiHfTemperature: state.setLlmApiHfTemperature,
      setLlmApiHfMaxTokens: state.setLlmApiHfMaxTokens,
      setLlmApiMistralModelId: state.setLlmApiMistralModelId,
      setLlmApiMistralTemperature: state.setLlmApiMistralTemperature,
      setLlmApiMistralMaxTokens: state.setLlmApiMistralMaxTokens,
      setMistralApiKey: state.setMistralApiKey,
      setCloudMistralApiUrl: state.setCloudMistralApiUrl,
    }))
  );

  const [mistralModels, setMistralModels] = useState<MistralModelMetadata[]>([]);
  const [isMistralModelsLoading, setIsMistralModelsLoading] = useState(false);
  const demeterOnlyMode = showDemeter && !showMistral;
  const noProviderVisible = !showHuggingFace && !showMistral && !showDemeter;
  const mistralCredentialsReady =
    mistralApiKey.trim().length > 0 && cloudMistralApiUrl.trim().length > 0;
  const availableMistralModels = useMemo(() => mistralModels, [mistralModels]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!showMistral) {
        if (!cancelled) {
          setMistralModels([]);
          setIsMistralModelsLoading(false);
        }
        return;
      }

      const key = mistralApiKey.trim();
      const apiUrl = cloudMistralApiUrl.trim();
      if (!key || !apiUrl) {
        if (!cancelled) {
          setMistralModels([]);
          setIsMistralModelsLoading(false);
        }
        return;
      }

      setIsMistralModelsLoading(true);
      logger.info("[settings][llm] mistral model list loading", {
        apiUrl,
      });

      const models = await fetchMistralModelsSafe({
        apiUrl,
        apiKey: key,
      });

      if (cancelled) return;
      const sortedModels = [...models].sort((a, b) => a.id.localeCompare(b.id));
      setMistralModels(sortedModels);
      setIsMistralModelsLoading(false);
      logger.info("[settings][llm] mistral model list loaded", {
        modelCount: sortedModels.length,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [cloudMistralApiUrl, mistralApiKey, showMistral]);

  const selectedSuggestedModel = useMemo(
    () => findSuggestedReportModel(llmApiHfModelId),
    [llmApiHfModelId]
  );

  const selectedMistralModel = useMemo(
    () => findMistralModelMetadata(availableMistralModels, llmApiMistralModelId),
    [availableMistralModels, llmApiMistralModelId]
  );
  const mistralModelMetadata = selectedMistralModel ?? null;
  const hfSettingMaxTokens = useMemo(
    () => resolveSuggestedModelMaxTokens(llmApiHfModelId),
    [llmApiHfModelId]
  );
  const mistralSettingMaxTokens = useMemo(
    () => resolveMistralMaxTokens(mistralModelMetadata ?? undefined),
    [mistralModelMetadata]
  );
  const modelSelectValue = selectedSuggestedModel ? selectedSuggestedModel.id : "__custom__";
  const mistralModelSelectValue = selectedMistralModel?.id ?? "__custom__";

  useEffect(() => {
    if (typeof hfSettingMaxTokens !== "number") return;
    if (llmApiHfMaxTokens !== hfSettingMaxTokens) {
      setLlmApiHfMaxTokens(hfSettingMaxTokens);
    }
  }, [hfSettingMaxTokens, llmApiHfMaxTokens, setLlmApiHfMaxTokens]);

  useEffect(() => {
    if (llmApiMistralMaxTokens !== mistralSettingMaxTokens) {
      setLlmApiMistralMaxTokens(mistralSettingMaxTokens);
    }
  }, [llmApiMistralMaxTokens, mistralSettingMaxTokens, setLlmApiMistralMaxTokens]);

  if (noProviderVisible) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>LLM Cloud indisponible</CardTitle>
          <CardDescription>Aucun provider LLM cloud n'est activé par le backend.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Accès refusé par vos permissions backend.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Pipeline /llmapi</CardTitle>
          <CardDescription>
            Reglages avances de generation du module LLM Cloud. Le provider actif se change sur /llmapi.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-sm font-medium">
              Provider actif: {llmApiProvider === "mistral" ? "Mistral" : llmApiProvider === "demeter_sante" ? "Demeter Santé" : "Hugging Face"}
            </p>
            <p className="text-xs text-muted-foreground">
              {demeterOnlyMode
                ? "Mode Demeter-only: seuls les reglages pipeline utiles a Demeter sont exposes."
                : "Les tokens et les parametres des providers autorises sont modifies ici."}
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        {showHuggingFace ? (
        <Card>
          <CardHeader>
            <CardTitle>Hugging Face</CardTitle>
            <CardDescription>Token et configuration pipeline dedies au provider Hugging Face.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="settings-llm-hf-token">Token Hugging Face (LLM)</Label>
              <Input
                id="settings-llm-hf-token"
                type="password"
                value={hfApiToken}
                onChange={(event) => setHfApiToken(event.target.value)}
                placeholder="hf_..."
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">Token partage avec /llmapi.</p>
              <p className="text-xs text-muted-foreground">{SESSION_ONLY_SECRET_NOTICE}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-llm-hf-model-preset">Modele suggere (HF)</Label>
              <Select
                value={modelSelectValue}
                onValueChange={(value) => {
                  if (value !== "__custom__") {
                    setLlmApiHfModelId(value);
                  }
                }}
              >
                <SelectTrigger id="settings-llm-hf-model-preset">
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

            <div className="space-y-2">
              <Label htmlFor="settings-llm-hf-model-id">Model ID (HF)</Label>
              <Input
                id="settings-llm-hf-model-id"
                value={llmApiHfModelId}
                onChange={(event) => setLlmApiHfModelId(event.target.value)}
                placeholder="openai/gpt-oss-20b"
              />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="settings-llm-hf-temperature">Temperature (HF)</Label>
                <Input
                  id="settings-llm-hf-temperature"
                  type="number"
                  step={0.1}
                  min={0}
                  max={2}
                  value={llmApiHfTemperature}
                  onChange={(event) => setLlmApiHfTemperature(Number(event.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="settings-llm-hf-max-tokens">Max tokens (HF)</Label>
                <Input
                  id="settings-llm-hf-max-tokens"
                  type="number"
                  min={128}
                  max={typeof hfSettingMaxTokens === "number" ? hfSettingMaxTokens : 262144}
                  step={128}
                  value={llmApiHfMaxTokens}
                  disabled={Boolean(selectedSuggestedModel)}
                  onChange={(event) => setLlmApiHfMaxTokens(Number(event.target.value))}
                />
              </div>
            </div>

            <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
              {selectedSuggestedModel ? (
                <div className="space-y-1">
                  <p>
                    Contexte modele:{" "}
                    <span className="font-medium text-foreground">
                      {formatTokenCount(selectedSuggestedModel.contextWindowTokens)}
                    </span>{" "}
                    tokens.
                  </p>
                  <p>
                    Max tokens regle automatiquement:{" "}
                    <span className="font-medium text-foreground">
                      {typeof hfSettingMaxTokens === "number" ? formatTokenCount(hfSettingMaxTokens) : "non calcule"}
                    </span>{" "}
                    tokens.
                  </p>
                </div>
              ) : (
                <p>Modele custom: max tokens editable manuellement.</p>
              )}
            </div>
          </CardContent>
        </Card>
        ) : null}

        {showMistral ? (
        <Card>
          <CardHeader>
            <CardTitle>Mistral</CardTitle>
            <CardDescription>Cle, URL et pipeline dedies au provider Mistral.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="settings-llm-mistral-api-key">Cle API Mistral (LLM)</Label>
              <Input
                id="settings-llm-mistral-api-key"
                type="password"
                value={mistralApiKey}
                onChange={(event) => setMistralApiKey(event.target.value)}
                placeholder="mistral_..."
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">Cle partagee avec /llmapi et /cloudupload.</p>
              <p className="text-xs text-muted-foreground">{SESSION_ONLY_SECRET_NOTICE}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-llm-mistral-api-url">URL API Mistral (LLM)</Label>
              <Input
                id="settings-llm-mistral-api-url"
                value={cloudMistralApiUrl}
                onChange={(event) => setCloudMistralApiUrl(event.target.value)}
                placeholder="https://api.mistral.ai"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">URL partagee avec /cloudupload.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-llm-mistral-model-preset">Modeles Mistral disponibles (LLM)</Label>
              <Select
                value={mistralModelSelectValue}
                onValueChange={(value) => {
                  if (value !== "__custom__") {
                    setLlmApiMistralModelId(value);
                  }
                }}
                disabled={isMistralModelsLoading || !mistralCredentialsReady}
              >
                <SelectTrigger id="settings-llm-mistral-model-preset">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableMistralModels.map((model) => (
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
                {!mistralCredentialsReady
                  ? "Renseignez cle + URL Mistral pour charger la liste."
                  : isMistralModelsLoading
                    ? "Chargement automatique des modeles Mistral..."
                    : availableMistralModels.length > 0
                      ? `${formatTokenCount(availableMistralModels.length)} modeles detectes via /v1/models.`
                      : "Aucun modele detecte: vous pouvez saisir un Model ID manuellement."}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-llm-mistral-model-id">Model ID (Mistral)</Label>
              <Input
                id="settings-llm-mistral-model-id"
                value={llmApiMistralModelId}
                onChange={(event) => setLlmApiMistralModelId(event.target.value)}
                placeholder={DEFAULT_MISTRAL_LLM_MODEL_ID}
              />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="settings-llm-mistral-temperature">Temperature (Mistral)</Label>
                <Input
                  id="settings-llm-mistral-temperature"
                  type="number"
                  step={0.1}
                  min={0}
                  max={2}
                  value={llmApiMistralTemperature}
                  onChange={(event) => setLlmApiMistralTemperature(Number(event.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="settings-llm-mistral-max-tokens">Max tokens (Mistral)</Label>
                <Input
                  id="settings-llm-mistral-max-tokens"
                  type="number"
                  min={128}
                  max={262144}
                  step={128}
                  value={llmApiMistralMaxTokens}
                  disabled
                  onChange={(event) => setLlmApiMistralMaxTokens(Number(event.target.value))}
                />
              </div>
            </div>

            <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
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
                  <span className="font-medium text-foreground">
                    {formatTokenCount(mistralSettingMaxTokens ?? FALLBACK_MISTRAL_MAX_TOKENS)}
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
              </div>
            </div>
          </CardContent>
        </Card>
        ) : null}

        {demeterOnlyMode ? (
          <Card>
            <CardHeader>
              <CardTitle>Demeter Santé</CardTitle>
              <CardDescription>Paramètres pipeline utilisés par le backend Demeter.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                Les clés/API URL Mistral sont masquées: elles ne sont pas utilisées en mode Demeter-only.
              </div>

              <div className="space-y-2">
                <Label htmlFor="settings-llm-demeter-model-id">Model ID (Demeter)</Label>
                <Input
                  id="settings-llm-demeter-model-id"
                  value={llmApiMistralModelId}
                  onChange={(event) => setLlmApiMistralModelId(event.target.value)}
                  placeholder={DEFAULT_MISTRAL_LLM_MODEL_ID}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="settings-llm-demeter-temperature">Temperature (Demeter)</Label>
                  <Input
                    id="settings-llm-demeter-temperature"
                    type="number"
                    step={0.1}
                    min={0}
                    max={2}
                    value={llmApiMistralTemperature}
                    onChange={(event) => setLlmApiMistralTemperature(Number(event.target.value))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="settings-llm-demeter-max-tokens">Max tokens (Demeter)</Label>
                  <Input
                    id="settings-llm-demeter-max-tokens"
                    type="number"
                    min={128}
                    max={262144}
                    step={128}
                    value={DEMETER_SANTE_MAX_TOKENS}
                    disabled
                  />
                </div>
              </div>

              <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                Max tokens Demeter impose par le backend: {formatTokenCount(DEMETER_SANTE_MAX_TOKENS)} tokens.
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
