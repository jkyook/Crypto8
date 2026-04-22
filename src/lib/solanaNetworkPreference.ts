export type SolanaNetworkPreference = "mainnet" | "devnet";

const STORAGE_KEY = "crypto8.solanaNetworkPreference";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function getSolanaNetworkPreference(): SolanaNetworkPreference {
  if (!canUseStorage()) return "mainnet";
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === "devnet" ? "devnet" : "mainnet";
}

export function setSolanaNetworkPreference(network: SolanaNetworkPreference): void {
  if (!canUseStorage()) return;
  window.localStorage.setItem(STORAGE_KEY, network);
  window.dispatchEvent(new Event("storage"));
}
