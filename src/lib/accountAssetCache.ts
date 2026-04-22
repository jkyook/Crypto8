import type { AccountAssetBalance } from "./api";

export type AccountAssetCacheScope = {
  kind: "wallet" | "orchestrator";
  mode: "dry-run" | "live";
  username?: string | null;
  solanaAddress?: string | null;
  evmAddress?: string | null;
};

type AccountAssetCacheEntry = {
  savedAt: string;
  assets: AccountAssetBalance[];
};

function normalizePart(value?: string | null): string {
  if (!value) return "_";
  return value.trim().toLowerCase() || "_";
}

function buildCacheKey(scope: AccountAssetCacheScope): string {
  return [
    "crypto8",
    "account-assets",
    scope.kind,
    scope.mode,
    normalizePart(scope.username),
    normalizePart(scope.solanaAddress),
    normalizePart(scope.evmAddress)
  ].join("::");
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function loadCachedAccountAssets(scope: AccountAssetCacheScope): AccountAssetBalance[] | null {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(buildCacheKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AccountAssetCacheEntry>;
    return Array.isArray(parsed.assets) ? parsed.assets : null;
  } catch {
    return null;
  }
}

export function saveCachedAccountAssets(scope: AccountAssetCacheScope, assets: AccountAssetBalance[]): void {
  if (!canUseStorage()) return;
  try {
    const entry: AccountAssetCacheEntry = {
      savedAt: new Date().toISOString(),
      assets
    };
    window.localStorage.setItem(buildCacheKey(scope), JSON.stringify(entry));
  } catch {
    // 캐시 실패는 자산 표시 자체를 막지 않는다.
  }
}
