export function buildCloudContext(preset: string, session: string) {
  const trimmedPreset = (preset ?? "").trim();
  const trimmedSession = (session ?? "").trim();
  if (trimmedSession) {
    return trimmedPreset ? `${trimmedPreset}\n${trimmedSession}` : trimmedSession;
  }
  return trimmedPreset;
}
