let secureIdCounter = 0;

export function createSecureId(prefix = ""): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return prefix ? `${prefix}${cryptoApi.randomUUID()}` : cryptoApi.randomUUID();
  }

  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return prefix ? `${prefix}${hex}` : hex;
  }

  const fallback = `${Date.now()}-${secureIdCounter += 1}`;
  return prefix ? `${prefix}${fallback}` : fallback;
}
