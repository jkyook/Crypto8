import type { DepositPositionPayload } from "../lib/api";

/** 포트폴리오 전반에서 쓰는 단일 예치 포지션 타입 (API 페이로드와 동일). */
export type DepositPosition = DepositPositionPayload;

/**
 * 프로토콜 노출 집계 행.
 * 포트폴리오 페이지 테이블과 풀/프로토콜 기준 인출 대상을 표현한다.
 */
export type ProtocolDetailRow = {
  key: string;
  name: string;
  chain: string;
  pool: string;
  amount: number;
};

/** 상품 카탈로그 단일 항목. ProductsPanel에서 사용. */
export type YieldProduct = {
  id: string;
  name: string;
  networkGroup: "multi" | "arbitrum" | "base" | "solana" | "ethereum";
  subtype: string;
  targetApr: number;
  estFeeBps: number;
  lockDays: number;
  protocolMix: Array<{ name: string; weight: number; pool: string }>;
  detail: string;
};
