const STORAGE_KEY = "crypto8.orcaMinAllocationEnabled";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function getOrcaMinimumAllocationPreference(): boolean {
  if (!canUseStorage()) return true;
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value !== "0";
}

export function setOrcaMinimumAllocationPreference(enabled: boolean): void {
  if (!canUseStorage()) return;
  window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  window.dispatchEvent(new Event("storage"));
}
