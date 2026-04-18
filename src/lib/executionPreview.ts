/**
 * 서버 `executionAdapter` 분배 비율과 동일한 **시뮬 견적 행**(UI 미리보기용).
 * (approve 행 등 allocationUsd 0은 제외)
 */
export type ExecutionPreviewRow = {
  protocol: string;
  chain: string;
  action: string;
  allocationUsd: number;
};

export function buildExecutionPreviewRows(depositUsd: number): ExecutionPreviewRow[] {
  if (!Number.isFinite(depositUsd) || depositUsd <= 0) {
    return [];
  }
  return [
    { protocol: "Aave", chain: "Arbitrum", action: "USDC Supply", allocationUsd: Number((depositUsd * 0.2).toFixed(2)) },
    { protocol: "Aave", chain: "Base", action: "USDC Supply", allocationUsd: Number((depositUsd * 0.15).toFixed(2)) },
    { protocol: "Uniswap", chain: "Arbitrum", action: "USDC-USDT mint", allocationUsd: Number((depositUsd * 0.25).toFixed(2)) },
    { protocol: "Uniswap", chain: "Arbitrum", action: "ETH-USDC LP route", allocationUsd: Number((depositUsd * 0.15).toFixed(2)) },
    { protocol: "Orca", chain: "Solana", action: "USDC-USDT Whirlpool", allocationUsd: Number((depositUsd * 0.2).toFixed(2)) }
  ];
}
