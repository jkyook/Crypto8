const STORAGE_KEY = "crypto8.mainnetLiveEnabled";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function getMainnetLivePreference(): boolean {
  if (!canUseStorage()) return false;
  return window.localStorage.getItem(STORAGE_KEY) === "1";
}

export function setMainnetLivePreference(enabled: boolean): void {
  if (!canUseStorage()) return;
  window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  window.dispatchEvent(new Event("storage"));
}
