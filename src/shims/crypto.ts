export function randomBytes(length: number): Uint8Array {
  if (length <= 0) return new Uint8Array();
  const cryptoApi = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const bytes = new Uint8Array(length);
    cryptoApi.getRandomValues(bytes);
    return bytes;
  }
  throw new Error("WebCrypto n'est pas disponible pour générer des octets aléatoires.");
}

const cryptoShim = { randomBytes };

export default cryptoShim;
