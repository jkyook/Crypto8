export type RiskLevel = "Low" | "Medium" | "High" | "Critical";

export type JobInput = {
  depositUsd: number;
  isRangeOut: boolean;
  isDepegAlert: boolean;
  hasPendingRelease: boolean;
  sourceAsset?: "USDC" | "USDT" | "ETH" | "SOL";
  /** 예치상품이 대상으로 하는 네트워크. 미지정 시 Multi(전체 체인) 전략으로 실행. */
  productNetwork?: "Ethereum" | "Arbitrum" | "Base" | "Solana" | "Multi";
};

export type ExecutionJob = {
  id: string;
  createdAt: string;
  status: "queued" | "blocked" | "executed" | "cancelled";
  input: JobInput;
  riskLevel: RiskLevel;
  /** 요청을 생성한 로그인 사용자(없으면 마이그레이션 이전 데이터). */
  requestedBy?: string | null;
};

export type ApprovalLog = {
  id: string;
  jobId: string;
  approver: string;
  approvedAt: string;
  expiresAt: string;
  decision: "Go" | "Conditional Go" | "No-Go";
  reason: string;
};

export type PersistedState = {
  jobs: ExecutionJob[];
  approvals: ApprovalLog[];
};

export type AuthUser = {
  username: string;
  role: "orchestrator" | "security" | "viewer";
};

export type JobListScope = Pick<AuthUser, "username" | "role">;

/** 어댑터별 시뮬/제출 한 줄(실행 페이로드에 JSON으로 저장). */
export type AdapterResultSnapshot = {
  protocol: string;
  chain: string;
  action: string;
  allocationUsd: number;
  txId: string;
  status: "simulated" | "submitted";
};

/** 실행 이벤트에 저장되는 구조화 페이로드(v1). */
export type ExecutionEventPayloadV1 = {
  v: 1;
  mode: "dry-run" | "live";
  correlationId?: string;
  positionId?: string;
  adapterResults?: AdapterResultSnapshot[];
  retries?: number;
};

export type ExecutionEvent = {
  id: string;
  jobId: string;
  requestedAt: string;
  status: "accepted" | "blocked" | "skipped" | "failed";
  message: string;
  idempotencyKey?: string;
  txId?: string;
  summary?: string;
  payload?: ExecutionEventPayloadV1;
};
