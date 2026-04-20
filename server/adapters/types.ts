import { isProtocolLiveExecutionEnabled } from "../runtimeMode";

export type ExecutionMode = "dry-run" | "live";

export type ProductNetwork = "Ethereum" | "Arbitrum" | "Base" | "Solana" | "Multi";

/**
 * 상품 서브타입 — 동일 네트워크 내에서 배분 비율이 다른 상품을 구분.
 * 각 어댑터는 (productNetwork + productSubtype) 조합으로 정확한 비율을 조회한다.
 *
 * 현재 정의된 상품:
 *   multi-stable    → Multi-network Stable 8%      (Aave Arb 45% + Uniswap Arb 35% + Orca 20%)
 *   multi-balanced  → Multi-network Balanced 7.2%  (Aave Base 50% + Uniswap Arb 30% + Orca 20%)
 *   arb-stable      → Arbitrum Stable 7.6%         (Aave Arb 45% + Uni Arb USDC-USDT 35% + Uni Arb ETH-USDC 20%)
 *   base-stable     → Base USDC Core 7.0%           (Aave Base 50% + Uni Base ETH-USDC 30% + Uni Base USDC-USDT 20%)
 *   sol-stable      → Solana Orca Blend 7.4%        (Orca USDC-USDT 40% + Orca SOL-USDC 35% + Orca mSOL-SOL 25%)
 */
export type ProductSubtype =
  | "multi-stable"
  | "multi-balanced"
  | "arb-stable"
  | "base-stable"
  | "sol-stable"
  | "eth-stable"
  | "eth-bluechip";

/**
 * 어댑터 실행 결과 상태.
 *
 * dry-run     : EXECUTION_MODE=dry-run 에서 반환된 시뮬레이션 결과 (온체인 의도 없음)
 * simulated   : live 모드 요청됐으나 어댑터가 시뮬레이션으로 폴백한 결과
 * unsupported : live 모드 요청됐으나 해당 어댑터/체인이 live 실행을 지원하지 않음
 * submitted   : 트랜잭션이 체인에 제출됨 (미확정)
 * confirmed   : receipt 확인 완료
 * failed      : 트랜잭션 제출 또는 실행 실패
 */
export type AdapterResultStatus =
  | "dry-run"
  | "simulated"
  | "unsupported"
  | "submitted"
  | "confirmed"
  | "failed";

export type AdapterExecutionContext = {
  jobId: string;
  mode: ExecutionMode;
  depositUsd: number;
  timestamp: string;
  /** 예치상품의 대상 네트워크. 미지정 시 "Multi"로 처리. */
  productNetwork?: ProductNetwork;
  /** 상품 서브타입. 동일 네트워크 내 배분 비율 분기에 사용. */
  productSubtype?: ProductSubtype;
};

export type AdapterExecutionResult = {
  protocol: "Aave" | "Uniswap" | "Orca" | "Aerodrome" | "Raydium" | "Curve";
  chain: "Arbitrum" | "Base" | "Solana" | "Ethereum";
  action: string;
  allocationUsd: number;
  txId: string;
  status: AdapterResultStatus;
  /** status가 "failed" 또는 "unsupported"일 때 원문 에러 또는 사유 */
  errorMessage?: string;
};

/**
 * 어댑터별 live 실행 지원 여부를 환경변수에서 읽는다.
 * 반드시 LIVE_EXECUTION_CONFIRM=YES 와 함께 설정해야 한다.
 */
export function isAdapterLiveEnabled(
  protocol: "Aave" | "Uniswap" | "Orca" | "Aerodrome" | "Raydium" | "Curve"
): boolean {
  return isProtocolLiveExecutionEnabled(protocol);
}

/**
 * 어댑터가 live 실행을 지원하지 않을 때 unsupported 결과를 생성.
 * live 모드 요청 시 가짜 txId를 반환하지 않고 명시적으로 실패 처리한다.
 */
export function buildUnsupportedResult(
  params: Pick<AdapterExecutionResult, "protocol" | "chain" | "action" | "allocationUsd">,
  reason?: string
): AdapterExecutionResult {
  return {
    ...params,
    txId: "",
    status: "unsupported",
    errorMessage: reason ?? `${params.protocol} live execution is not yet supported on ${params.chain}`
  };
}
