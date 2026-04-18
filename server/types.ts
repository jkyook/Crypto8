export type RiskLevel = "Low" | "Medium" | "High" | "Critical";

export type JobInput = {
  depositUsd: number;
  isRangeOut: boolean;
  isDepegAlert: boolean;
  hasPendingRelease: boolean;
};

export type ExecutionJob = {
  id: string;
  createdAt: string;
  status: "queued" | "blocked" | "executed";
  input: JobInput;
  riskLevel: RiskLevel;
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
