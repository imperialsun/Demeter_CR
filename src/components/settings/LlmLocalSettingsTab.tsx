import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAsrStore, type LlmLocalModelSettings, type ModelDtype } from "@/store/asr-store";
import { formatTokenCount } from "@/lib/llm/modelCatalog";
import {
  createDefaultLocalModelSettings,
  getLocalLlmModelProfile,
  type LlmLocalModelProfile,
} from "@/lib/llm/localModelCatalog";

const DTYPE_OPTIONS: ModelDtype[] = ["q4f16", "q4", "q8", "fp16", "auto"];
const PROFILE_ORDER: LlmLocalModelProfile[] = ["qwen_0_6b", "qwen_1_7b", "ministral_3_3b"];

export function LlmLocalSettingsTab() {
  const {
    llmLocalModelProfile,
    llmLocalSettingsByProfile,
    llmLocalForceSingleThread,
    setLlmLocalForceSingleThread,
    setLlmLocalModelSettings,
    resetLlmLocalModelSettings,
  } = useAsrStore(
    useShallow((state) => ({
      llmLocalModelProfile: state.llmLocalModelProfile,
      llmLocalSettingsByProfile: state.llmLocalSettingsByProfile,
      llmLocalForceSingleThread: state.llmLocalForceSingleThread,
      setLlmLocalForceSingleThread: state.setLlmLocalForceSingleThread,
      setLlmLocalModelSettings: state.setLlmLocalModelSettings,
      resetLlmLocalModelSettings: state.resetLlmLocalModelSettings,
    }))
  );

  const activeProfile = useMemo(() => getLocalLlmModelProfile(llmLocalModelProfile), [llmLocalModelProfile]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Pipeline /llmlocal</CardTitle>
          <CardDescription>
            Reglages avances de generation locale par modele. Le profil actif se choisit sur /llmlocal.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Profil actif: <span className="font-medium text-foreground">{activeProfile.label}</span>
          </p>
          <p>
            Les backends restent automatiques sur /llmlocal (WebGPU puis WASM si autorise).
          </p>
          <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Multithread WASM (LLM local)</p>
              <p className="text-xs text-muted-foreground">
                Si desactive, /llmlocal utilise WASM en single-thread.
              </p>
            </div>
            <Switch
              className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
              aria-label="llm-local-multithread-switch"
              checked={!llmLocalForceSingleThread}
              onCheckedChange={(enabled) => setLlmLocalForceSingleThread(!enabled)}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        {PROFILE_ORDER.map((profileId) => {
          const settings = llmLocalSettingsByProfile[profileId] ?? createDefaultLocalModelSettings(profileId);
          const isActive = llmLocalModelProfile === profileId;

          return (
            <ModelSettingsCard
              key={profileId}
              profileId={profileId}
              isActive={isActive}
              settings={settings}
              onChange={(patch) => setLlmLocalModelSettings(profileId, patch)}
              onReset={() => resetLlmLocalModelSettings(profileId)}
            />
          );
        })}
      </div>
    </div>
  );
}

function ModelSettingsCard({
  profileId,
  isActive,
  settings,
  onChange,
  onReset,
}: {
  profileId: LlmLocalModelProfile;
  isActive: boolean;
  settings: LlmLocalModelSettings;
  onChange: (patch: Partial<LlmLocalModelSettings>) => void;
  onReset: () => void;
}) {
  const profile = useMemo(() => getLocalLlmModelProfile(profileId), [profileId]);
  const allowWasm = profile.allowedBackends.includes("wasm");

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{profile.label}</CardTitle>
          {isActive ? <Badge variant="success">Actif</Badge> : null}
          {profile.heavy ? <Badge variant="warning">Lourd</Badge> : null}
        </div>
        <CardDescription>{profile.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={`settings-llm-local-${profileId}-model-id`}>Model ID</Label>
          <Input
            id={`settings-llm-local-${profileId}-model-id`}
            value={settings.modelId}
            onChange={(event) => onChange({ modelId: event.target.value })}
          />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`settings-llm-local-${profileId}-temperature`}>Temperature</Label>
            <Input
              id={`settings-llm-local-${profileId}-temperature`}
              type="number"
              step={0.1}
              min={0}
              max={2}
              value={settings.temperature}
              onChange={(event) => onChange({ temperature: Number(event.target.value) })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`settings-llm-local-${profileId}-max-tokens`}>Max tokens</Label>
            <Input
              id={`settings-llm-local-${profileId}-max-tokens`}
              type="number"
              min={128}
              max={profile.maxGenerationTokens}
              step={128}
              value={settings.maxTokens}
              onChange={(event) => onChange({ maxTokens: Number(event.target.value) })}
            />
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`settings-llm-local-${profileId}-dtype-webgpu`}>Dtype WebGPU</Label>
            <Select value={settings.dtypeWebgpu} onValueChange={(value) => onChange({ dtypeWebgpu: value as ModelDtype })}>
              <SelectTrigger id={`settings-llm-local-${profileId}-dtype-webgpu`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DTYPE_OPTIONS.map((dtype) => (
                  <SelectItem key={`settings-llm-local-${profileId}-webgpu-${dtype}`} value={dtype}>
                    {dtype}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`settings-llm-local-${profileId}-dtype-wasm`}>Dtype WASM</Label>
            <Select
              value={settings.dtypeWasm}
              onValueChange={(value) => onChange({ dtypeWasm: value as ModelDtype })}
              disabled={!allowWasm}
            >
              <SelectTrigger id={`settings-llm-local-${profileId}-dtype-wasm`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DTYPE_OPTIONS.map((dtype) => (
                  <SelectItem key={`settings-llm-local-${profileId}-wasm-${dtype}`} value={dtype}>
                    {dtype}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!allowWasm ? <p className="text-xs text-muted-foreground">WASM desactive: ce profil exige WebGPU.</p> : null}
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
          <div className="space-y-1">
            <p className="text-sm font-medium">appendNoThinkDirective</p>
            <p className="text-xs text-muted-foreground">Ajoute /no_think au prompt utilisateur pour ce profil.</p>
          </div>
          <Switch
            className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
            aria-label={`append-no-think-${profileId}`}
            checked={settings.appendNoThinkDirective}
            onCheckedChange={(checked) => onChange({ appendNoThinkDirective: checked })}
          />
        </div>

        <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground space-y-1">
          <p>
            Contexte max: <span className="font-medium text-foreground">{formatTokenCount(profile.contextWindowTokens)}</span> tokens
          </p>
          <p>
            Max generation: <span className="font-medium text-foreground">{formatTokenCount(profile.maxGenerationTokens)}</span> tokens
          </p>
          <p>
            Backends autorises: <span className="font-medium text-foreground">{profile.allowedBackends.map((b) => b.toUpperCase()).join(" -> ")}</span>
          </p>
          {profile.heavyWarning ? <p className="text-warning">{profile.heavyWarning}</p> : null}
        </div>

        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={onReset}>
            Reinitialiser ce modele
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
