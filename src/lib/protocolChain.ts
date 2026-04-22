import { PROTOCOL_SORT_ORDER } from "./constants";

/**
 * 프로토콜 + 풀 레이블에서 체인명을 추출한다.
 * 풀 레이블이 "Arbitrum · USDC Supply" 형태면 앞 세그먼트를 체인으로 파싱하고,
 * 실패하면 프로토콜명 기반으로 폴백한다.
 */
export function inferProtocolChain(protocolName: string, poolLabel?: string): string {
  if (poolLabel) {
    const chainPart = poolLabel.split("·")[0].trim().split("/")[0].trim();
    const lc = chainPart.toLowerCase();
    if (lc === "arbitrum" || lc.includes("arbitrum")) return "Arbitrum";
    if (lc === "base" || lc.includes("base")) return "Base";
    if (lc === "solana" || lc.includes("solana")) return "Solana";
    if (lc === "ethereum" || lc.includes("ethereum")) return "Ethereum";
    if (lc === "sol") return "Solana";
    if (lc === "eth") return "Ethereum";
  }
  const key = protocolName.toLowerCase();
  if (key.includes("orca")) return "Solana";
  if (key.includes("aave")) return "Arbitrum";
  if (key.includes("uniswap")) return "Arbitrum";
  return "Multi";
}

/** 프로토콜 노출표 상단 정렬 우선순위. */
export function getProtocolSortRank(protocolName: string): number {
  const key = protocolName.toLowerCase();
  const rank = PROTOCOL_SORT_ORDER.findIndex((name) => key.includes(name.toLowerCase()));
  return rank === -1 ? PROTOCOL_SORT_ORDER.length : rank;
}
