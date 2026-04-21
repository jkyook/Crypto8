import type { AccountAssetBalance, AccountAssetSymbol } from "./api";
import type { ExecutionPreviewRow } from "./executionPreview";

export type DepositSwapPlanRow = {
  target: string;
  protocol: string;
  chain: string;
  action: string;
  sourceAsset: AccountAssetSymbol;
  sourceChain: string;
  requiredAssets: AccountAssetSymbol[];
  requiredUsd: number;
  needsSwap: boolean;
  needsTransfer: boolean;
  route: string;
  note: string;
};

export type DepositAssetReadiness = {
  selectedAsset?: AccountAssetBalance;
  availableUsd: number;
  isSufficient: boolean;
  missingUsd: number;
  swapRows: DepositSwapPlanRow[];
};

function inferRequiredAssets(row: ExecutionPreviewRow): AccountAssetSymbol[] {
  const key = `${row.protocol} ${row.chain} ${row.action}`.toLowerCase();
  if (key.includes("eth-usdc")) return ["ETH", "USDC"];
  if (key.includes("usdc-usdt")) return ["USDC", "USDT"];
  if (key.includes("sol-usdc")) return ["SOL", "USDC"];
  if (key.includes("usdc")) return ["USDC"];
  return ["USDC"];
}

function buildRoute(
  sourceAsset: AccountAssetSymbol,
  sourceChain: string,
  requiredAssets: AccountAssetSymbol[],
  targetChain: string
): Pick<DepositSwapPlanRow, "needsSwap" | "needsTransfer" | "route" | "note"> {
  const needsSwap = requiredAssets.some((asset) => asset !== sourceAsset);
  const needsTransfer = sourceChain !== targetChain;
  const targetAssets = requiredAssets.join("/");
  const route = `${sourceAsset} ${sourceChain} → ${targetAssets} ${targetChain}`;
  if (!needsSwap && !needsTransfer) {
    return { needsSwap, needsTransfer, route, note: "동일 자산·동일 네트워크라 바로 예치 가능" };
  }
  const actions = [];
  if (needsSwap) actions.push("스왑");
  if (needsTransfer) actions.push("브릿지/전송");
  if (!needsSwap && needsTransfer) {
    actions.push("목표 체인 수령 확인");
  }
  return { needsSwap, needsTransfer, route, note: `${actions.join(" + ")} 필요` };
}

export function buildDepositAssetReadiness(
  assets: AccountAssetBalance[],
  selectedSymbol: AccountAssetSymbol,
  depositUsd: number,
  rows: ExecutionPreviewRow[],
  fallbackSourceChain?: string
): DepositAssetReadiness {
  const selectedAssets = assets.filter((asset) => asset.symbol === selectedSymbol);
  const selectedAsset =
    selectedAssets.sort((a, b) => b.usdValue - a.usdValue || b.amount - a.amount || a.chain.localeCompare(b.chain, "ko-KR"))[0];
  const availableUsd = selectedAssets.reduce((sum, asset) => sum + asset.usdValue, 0);
  const sourceChain = selectedAsset?.chain ?? fallbackSourceChain ?? (selectedSymbol === "SOL" ? "Solana" : "Arbitrum");
  const isSufficient = Number.isFinite(depositUsd) && depositUsd > 0 && availableUsd >= depositUsd;
  const swapRows = rows.map((row) => {
    const requiredAssets = inferRequiredAssets(row);
    const route = buildRoute(selectedSymbol, sourceChain, requiredAssets, row.chain);
    return {
      target: `${row.protocol} · ${row.chain} · ${row.action}`,
      protocol: row.protocol,
      chain: row.chain,
      action: row.action,
      sourceAsset: selectedSymbol,
      sourceChain,
      requiredAssets,
      requiredUsd: Number(row.allocationUsd.toFixed(2)),
      ...route
    };
  });

  return {
    selectedAsset,
    availableUsd,
    isSufficient,
    missingUsd: Math.max(0, depositUsd - availableUsd),
    swapRows
  };
}
