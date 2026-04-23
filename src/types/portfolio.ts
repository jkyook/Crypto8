import type { DepositPositionPayload } from "../lib/api";
export type { YieldProduct } from "../lib/productCatalog";

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


/** 풀 카탈로그 테이블 행. PortfolioPanel에서 사용. */
export type PoolCatalogRow = {
  key: string;
  productNames: string[];
  protocol: string;
  chain: string;
  pool: string;
  depositPossible: boolean;
  queryable: boolean;
  memo: string;
};

/** 프로토콜 풀 매칭 상태. */
export type ProtocolPoolMatchState = "matched" | "drift" | "missing" | "unsupported" | "error" | "available";

/** 풀 라이브 상태. */
export type PoolLiveState = "checking" | "live" | "down";
