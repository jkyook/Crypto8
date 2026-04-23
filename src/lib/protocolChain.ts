import type { OnchainPositionPayload } from "./api";
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

/** 해당 프로토콜/체인 조합에 입금 경로가 있는지 여부. */
export function isPoolDepositPossible(protocolName: string, chain: string): boolean {
  const protocol = protocolName.toLowerCase();
  const lcChain = chain.toLowerCase();
  if (protocol.includes("aave")) return lcChain === "arbitrum" || lcChain === "base" || lcChain === "ethereum";
  if (protocol.includes("uniswap")) return lcChain === "arbitrum" || lcChain === "base" || lcChain === "ethereum";
  if (protocol.includes("orca")) return lcChain === "solana";
  if (protocol.includes("aerodrome")) return lcChain === "base";
  if (protocol.includes("curve")) return lcChain === "ethereum";
  if (protocol.includes("raydium")) return lcChain === "solana";
  return false;
}

/** 해당 프로토콜의 온체인 포지션 조회가 구현되어 있는지 여부. */
export function isPoolPositionQueryable(protocolName: string): boolean {
  const protocol = protocolName.toLowerCase();
  return protocol.includes("aave") || protocol.includes("orca") || protocol.includes("uniswap");
}

/** 입금 경로 안내 메시지. */
export function getPoolDepositReason(protocolName: string, chain: string): string {
  const protocol = protocolName.toLowerCase();
  const lcChain = chain.toLowerCase();
  if (protocol.includes("aave")) {
    return lcChain === "arbitrum" || lcChain === "base" || lcChain === "ethereum"
      ? "Aave는 Arbitrum / Base / Ethereum 입금 경로가 있습니다."
      : "Aave 입금 경로가 없는 체인입니다.";
  }
  if (protocol.includes("uniswap")) {
    return lcChain === "arbitrum" || lcChain === "base" || lcChain === "ethereum"
      ? "Uniswap은 이 체인에 대해 입금 경로가 있습니다."
      : "Uniswap 입금 경로가 없는 체인입니다.";
  }
  if (protocol.includes("orca")) {
    return lcChain === "solana" ? "Orca는 Solana 입금 경로가 있습니다." : "Orca 입금 경로는 Solana에서만 지원됩니다.";
  }
  if (protocol.includes("aerodrome")) {
    return lcChain === "base" ? "Aerodrome은 Base 입금 경로가 있습니다." : "Aerodrome 입금 경로는 Base에서만 지원됩니다.";
  }
  if (protocol.includes("curve")) {
    return lcChain === "ethereum" ? "Curve는 Ethereum 입금 경로가 있습니다." : "Curve 입금 경로는 Ethereum에서만 지원됩니다.";
  }
  if (protocol.includes("raydium")) {
    return lcChain === "solana" ? "Raydium은 Solana 입금 경로가 있습니다." : "Raydium 입금 경로는 Solana에서만 지원됩니다.";
  }
  return "해당 프로토콜의 입금 경로를 현재 정의하지 않았습니다.";
}

/** 온체인 포지션 조회 가능 여부 안내 메시지. */
export function getPoolQueryReason(protocolName: string): string {
  const protocol = protocolName.toLowerCase();
  if (protocol.includes("aave")) return "Aave는 현재 온체인 포지션 검증기가 연결되어 있습니다.";
  if (protocol.includes("uniswap")) return "Uniswap v3 NonfungiblePositionManager NFT 스캔 어댑터가 연결되어 있습니다.";
  if (protocol.includes("orca")) return "Orca Whirlpool 포지션 조회 어댑터가 연결되어 있습니다.";
  if (protocol.includes("aerodrome")) return "Aerodrome 포지션 조회 어댑터는 아직 미구현입니다.";
  if (protocol.includes("curve")) return "Curve 포지션 조회 어댑터는 아직 미구현입니다.";
  if (protocol.includes("raydium")) return "Raydium 포지션 조회 어댑터는 아직 미구현입니다.";
  return "해당 프로토콜의 포지션 조회 기준을 현재 정의하지 않았습니다.";
}

/** 포지션 ID 축약 표시 (14자 초과 시 앞뒤 6자만). */
export function shortPositionId(value?: string | null): string {
  if (!value) return "—";
  return value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;
}

/** 온체인 verify 상태 한국어 레이블. */
export function onchainVerifyLabel(status?: NonNullable<OnchainPositionPayload["verify"]>["status"]): string {
  if (status === "verified") return "조회완료";
  if (status === "drift") return "차이";
  if (status === "closed_onchain") return "잔고없음";
  if (status === "rpc_error") return "오류";
  if (status === "unsupported") return "미지원";
  return "미확인";
}

/** 온체인 verify 상태 배지 CSS 클래스. */
export function onchainVerifyBadgeClass(status?: NonNullable<OnchainPositionPayload["verify"]>["status"]): string {
  if (status === "verified") return "protocol-match-badge protocol-match-badge--ok";
  if (status === "drift") return "protocol-match-badge protocol-match-badge--drift";
  if (status === "closed_onchain") return "protocol-match-badge protocol-match-badge--missing";
  if (status === "rpc_error") return "protocol-match-badge protocol-match-badge--error";
  if (status === "unsupported") return "protocol-match-badge protocol-match-badge--unsupported";
  return "protocol-match-badge protocol-match-badge--pending";
}
