import type { RiskLevel } from "../types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787";
const TOKEN_KEY = "crypto8_access_token";
const REFRESH_TOKEN_KEY = "crypto8_refresh_token";
const ROLE_KEY = "crypto8_role";
const USERNAME_KEY = "crypto8_username";

export type JobInput = {
  depositUsd: number;
  isRangeOut: boolean;
  isDepegAlert: boolean;
  hasPendingRelease: boolean;
};

export type Job = {
  id: string;
  createdAt: string;
  status: "queued" | "blocked" | "executed";
  input: JobInput;
  riskLevel: RiskLevel;
};

export type AuthRole = "orchestrator" | "security" | "viewer";

export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  role: AuthRole;
  username: string;
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

export type ExecutionEventPayload = {
  v: 1;
  mode: "dry-run" | "live";
  correlationId?: string;
  positionId?: string;
  adapterResults?: Array<{
    protocol: string;
    chain: string;
    action: string;
    allocationUsd: number;
    txId: string;
    status: "simulated" | "submitted";
  }>;
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
  payload?: ExecutionEventPayload;
};

export type MarketAprSnapshot = {
  aave: number;
  uniswap: number;
  orca: number;
  updatedAt: string;
};
export type ProtocolNewsItem = {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
};

export type ProtocolNewsBundle = {
  items: ProtocolNewsItem[];
  digest: string;
  scannedSources: string[];
};

export type DepositPositionPayload = {
  id: string;
  productName: string;
  amountUsd: number;
  expectedApr: number;
  protocolMix: Array<{ name: string; weight: number; pool?: string }>;
  createdAt: string;
};

export type RuntimeInfo = {
  executionMode: "dry-run" | "live";
  executionModeRequested: string;
  liveExecutionConfirmed: boolean;
  walletUiPolicy: string;
  serverExecutionNote: string;
};

function getProtocolNewsFallback(protocol: string): ProtocolNewsBundle {
  const now = new Date().toISOString();
  const key = protocol.toLowerCase();
  let items: ProtocolNewsItem[];
  if (key.includes("aave")) {
    items = [
      {
        title: "Aave 거버넌스 최신 제안",
        source: "Aave Governance",
        url: "https://governance.aave.com/",
        publishedAt: now
      },
      {
        title: "Aave Snapshot 최신 투표",
        source: "Snapshot",
        url: "https://snapshot.org/#/aave.eth",
        publishedAt: now
      },
      { title: "Aave 공식 사이트", source: "참고 허브", url: "https://aave.com/", publishedAt: now }
    ];
  } else if (key.includes("orca")) {
    items = [
      {
        title: "Orca 공식 블로그 최신 글",
        source: "Orca Blog",
        url: "https://www.orca.so/blog",
        publishedAt: now
      },
      {
        title: "Orca 공식 채널 공지",
        source: "X",
        url: "https://x.com/orca_so",
        publishedAt: now
      }
    ];
  } else if (key.includes("uniswap")) {
    items = [
      {
        title: "Uniswap Labs 블로그 업데이트",
        source: "Uniswap Labs",
        url: "https://blog.uniswap.org/",
        publishedAt: now
      },
      {
        title: "Uniswap 거버넌스 포럼",
        source: "Uniswap Governance",
        url: "https://gov.uniswap.org/",
        publishedAt: now
      }
    ];
  } else {
    items = [
      {
        title: `${protocol} 관련 공식 채널 업데이트`,
        source: "Official",
        url: "https://www.coingecko.com/",
        publishedAt: now
      }
    ];
  }
  return {
    items,
    digest: `API 서버에 연결하지 못해 로컬 참고 링크만 표시합니다. (${protocol})`,
    scannedSources: ["client-fallback"]
  };
}

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function getSession(): AuthSession | null {
  const accessToken = localStorage.getItem(TOKEN_KEY);
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  const role = localStorage.getItem(ROLE_KEY) as AuthRole | null;
  const username = localStorage.getItem(USERNAME_KEY);
  if (!accessToken || !refreshToken || !role || !username) {
    return null;
  }
  return { accessToken, refreshToken, role, username };
}

export async function clearSession(): Promise<void> {
  const refreshToken = getRefreshToken();
  if (refreshToken) {
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken })
    });
  }
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(USERNAME_KEY);
}

export async function login(username: string, password: string): Promise<AuthSession> {
  const response = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const data = (await response.json()) as {
    ok: boolean;
    accessToken?: string;
    refreshToken?: string;
    role?: AuthRole;
    message?: string;
  };
  if (!response.ok || !data.accessToken || !data.refreshToken || !data.role) {
    throw new Error(data.message ?? "로그인 실패");
  }
  const session: AuthSession = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    role: data.role,
    username
  };
  localStorage.setItem(TOKEN_KEY, session.accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, session.refreshToken);
  localStorage.setItem(ROLE_KEY, session.role);
  localStorage.setItem(USERNAME_KEY, session.username);
  return session;
}

async function refreshAccessTokenOrThrow(): Promise<string> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    throw new Error("세션이 만료되었습니다. 다시 로그인하세요.");
  }
  const response = await fetch(`${API_BASE}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken })
  });
  const data = (await response.json()) as { accessToken?: string; role?: AuthRole; username?: string; message?: string };
  if (!response.ok || !data.accessToken || !data.role || !data.username) {
    throw new Error(data.message ?? "토큰 갱신 실패");
  }
  localStorage.setItem(TOKEN_KEY, data.accessToken);
  localStorage.setItem(ROLE_KEY, data.role);
  localStorage.setItem(USERNAME_KEY, data.username);
  return data.accessToken;
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const currentToken = getToken();
  if (!currentToken) {
    throw new Error("로그인이 필요합니다.");
  }

  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${currentToken}`);
  const first = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (first.status !== 401) {
    return first;
  }

  const newToken = await refreshAccessTokenOrThrow();
  const retryHeaders = new Headers(init.headers ?? {});
  retryHeaders.set("Authorization", `Bearer ${newToken}`);
  return fetch(`${API_BASE}${path}`, { ...init, headers: retryHeaders });
}

async function readErrorFromApiResponse(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => "");
  if (response.status === 403 && /access forbidden/i.test(text)) {
    return "접근이 거부되었습니다(403). API 주소(VITE_API_BASE_URL)·프록시·방화벽을 확인하세요.";
  }
  try {
    const j = JSON.parse(text) as { message?: string };
    const m = j.message;
    if (
      response.status === 403 &&
      (m === "forbidden: insufficient role" || (typeof m === "string" && m.includes("insufficient role")))
    ) {
      return "권한이 없습니다. 이 작업은 운영 전용으로 로그인한 경우에만 할 수 있습니다.";
    }
    if (typeof m === "string" && m.length > 0) return m;
  } catch {
    const t = text.trim();
    if (t.length > 0 && t.length < 400) return t;
  }
  return fallback;
}

export async function createOrchestratorJob(input: JobInput): Promise<Job> {
  const response = await authedFetch("/api/orchestrator/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error(await readErrorFromApiResponse(response, "작업 생성 실패"));
  }
  const data = (await response.json()) as { job: Job };
  return data.job;
}

export async function listJobs(): Promise<Job[]> {
  const response = await authedFetch("/api/orchestrator/jobs");
  if (!response.ok) {
    throw new Error("작업 목록 조회 실패");
  }
  const data = (await response.json()) as { jobs: Job[] };
  return data.jobs;
}

export async function approveJob(jobId: string): Promise<void> {
  const session = getSession();
  if (!session) {
    throw new Error("로그인이 필요합니다.");
  }
  const response = await authedFetch("/api/security/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobId,
      approver: session.username,
      ttlHours: 24,
      decision: "Go",
      reason: "MVP 자동 승인 테스트"
    })
  });
  if (!response.ok) {
    throw new Error(await readErrorFromApiResponse(response, "보안 승인 실패"));
  }
}

export type ExecuteJobResponse = {
  ok: boolean;
  message: string;
  requestId?: string;
  txId?: string;
  summary?: string;
  payload?: ExecutionEventPayload;
};

export async function executeJob(
  jobId: string,
  options?: { idempotencyKey?: string; correlationId?: string; positionId?: string }
): Promise<ExecuteJobResponse> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options?.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  const body: { correlationId?: string; positionId?: string } = {};
  if (options?.correlationId) {
    body.correlationId = options.correlationId;
  }
  if (options?.positionId) {
    body.positionId = options.positionId;
  }
  const response = await authedFetch(`/api/orchestrator/execute/${jobId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data = {} as ExecuteJobResponse & { message?: string };
  try {
    if (text) {
      data = JSON.parse(text) as typeof data;
    }
  } catch {
    /* ignore */
  }
  if (!response.ok) {
    const trimmed = text.trim();
    const msg =
      typeof data.message === "string" && data.message.length > 0
        ? data.message
        : trimmed.length > 0 && trimmed.length < 400
          ? trimmed
          : "실행 요청 실패";
    throw new Error(msg);
  }
  const requestIdHeader = response.headers.get("X-Request-Id") ?? undefined;
  return { ...data, requestId: data.requestId ?? requestIdHeader };
}

export type ApiHealth = {
  ok: boolean;
  service: string;
  version?: string;
  database?: string;
  executionMode?: string;
  uptimeSec?: number;
};

export async function fetchApiHealth(): Promise<ApiHealth | null> {
  try {
    const response = await fetch(`${API_BASE}/api/health`);
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as ApiHealth;
  } catch {
    return null;
  }
}

export async function listApprovals(): Promise<ApprovalLog[]> {
  const response = await authedFetch("/api/security/approvals");
  if (!response.ok) {
    throw new Error("승인 로그 조회 실패");
  }
  const data = (await response.json()) as { approvals: ApprovalLog[] };
  return data.approvals;
}

export async function listExecutionEvents(jobId?: string): Promise<ExecutionEvent[]> {
  const query = jobId ? `?jobId=${encodeURIComponent(jobId)}` : "";
  const response = await authedFetch(`/api/orchestrator/execution-events${query}`);
  if (!response.ok) {
    throw new Error("실행 이벤트 조회 실패");
  }
  const data = (await response.json()) as { events: ExecutionEvent[] };
  return data.events;
}

export async function listDepositPositions(): Promise<DepositPositionPayload[]> {
  const response = await authedFetch("/api/portfolio/positions");
  if (!response.ok) {
    throw new Error("예치 포지션 조회 실패");
  }
  const data = (await response.json()) as { positions?: DepositPositionPayload[] };
  return data.positions ?? [];
}

export type PortfolioWithdrawLine = {
  id: string;
  amountUsd: number;
  createdAt: string;
};

export async function listWithdrawalLedger(): Promise<PortfolioWithdrawLine[]> {
  const response = await authedFetch("/api/portfolio/withdrawals");
  if (!response.ok) {
    throw new Error("출금 내역 조회 실패");
  }
  const data = (await response.json()) as { withdrawals?: PortfolioWithdrawLine[] };
  return data.withdrawals ?? [];
}

export async function createDepositPositionRemote(payload: {
  productName: string;
  amountUsd: number;
  expectedApr: number;
  protocolMix: Array<{ name: string; weight: number; pool?: string }>;
}): Promise<DepositPositionPayload> {
  const response = await authedFetch("/api/portfolio/positions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data = {} as { ok?: boolean; position?: DepositPositionPayload; message?: string };
  try {
    if (text) data = JSON.parse(text) as typeof data;
  } catch {
    // 비 JSON 응답
  }
  if (!response.ok || !data.position) {
    let msg = data.message;
    if (
      response.status === 403 &&
      (msg === "forbidden: insufficient role" || !msg || (typeof msg === "string" && msg.includes("insufficient role")))
    ) {
      msg = "권한이 없습니다. 예치 저장은 운영 전용으로 로그인한 경우에만 할 수 있습니다.";
    }
    throw new Error(msg ?? "예치 포지션 저장 실패");
  }
  return data.position;
}

export async function withdrawDepositRemote(amountUsd: number): Promise<{ withdrawnUsd: number }> {
  const response = await authedFetch("/api/portfolio/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amountUsd })
  });
  const text = await response.text();
  let data = {} as { ok?: boolean; withdrawnUsd?: number; message?: string };
  try {
    if (text) {
      data = JSON.parse(text) as typeof data;
    }
  } catch {
    /* 비 JSON */
  }
  if (!response.ok) {
    let msg = data.message;
    if (
      response.status === 403 &&
      (msg === "forbidden: insufficient role" || !msg || (typeof msg === "string" && msg.includes("insufficient role")))
    ) {
      msg = "권한이 없습니다. 인출 반영은 운영 전용으로 로그인한 경우에만 할 수 있습니다.";
    }
    const trimmed = text.trim();
    if (typeof msg === "string" && msg.length > 0) {
      throw new Error(msg);
    }
    if (trimmed.length > 0 && trimmed.length < 400) {
      throw new Error(trimmed);
    }
    throw new Error("인출 반영 실패");
  }
  const withdrawnUsd = typeof data.withdrawnUsd === "number" ? data.withdrawnUsd : 0;
  return { withdrawnUsd };
}

export async function fetchRuntimeInfo(): Promise<RuntimeInfo> {
  const candidates = [`${API_BASE}/api/runtime/info`, "http://localhost:8787/api/runtime/info"];
  for (const url of candidates) {
    try {
      const response = await fetch(url);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        continue;
      }
      const data = (await response.json()) as RuntimeInfo & { ok?: boolean };
      if (response.ok && data.executionMode) {
        return data;
      }
    } catch {
      // try next
    }
  }
  return {
    executionMode: "dry-run",
    executionModeRequested: "dry-run",
    liveExecutionConfirmed: false,
    walletUiPolicy: "phantom-solana",
    serverExecutionNote: "서버에 연결할 수 없어 실행 모드를 확인하지 못했습니다. 기본값은 dry-run으로 간주합니다."
  };
}

export async function fetchMarketAprSnapshot(): Promise<MarketAprSnapshot> {
  const candidates = [`${API_BASE}/api/market/rates`, "http://localhost:8787/api/market/rates"];
  for (const url of candidates) {
    try {
      const response = await fetch(url);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        continue;
      }
      const data = (await response.json()) as {
        ok: boolean;
        rates?: MarketAprSnapshot;
        message?: string;
      };
      if (response.ok && data.rates) {
        return data.rates;
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error("시장 이율 조회 실패");
}

export async function fetchProtocolNews(protocol: string): Promise<ProtocolNewsBundle> {
  const encoded = encodeURIComponent(protocol);
  const candidates = [
    `/api/insights/news?protocol=${encoded}`,
    `${API_BASE}/api/insights/news?protocol=${encoded}`,
    `http://localhost:8787/api/insights/news?protocol=${encoded}`
  ];
  for (const url of candidates) {
    try {
      const response = await fetch(url);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        continue;
      }
      const data = (await response.json()) as {
        ok: boolean;
        items?: ProtocolNewsItem[];
        digest?: string;
        scannedSources?: string[];
        message?: string;
      };
      if (response.ok && data.items) {
        return {
          items: data.items,
          digest: typeof data.digest === "string" ? data.digest : "",
          scannedSources: Array.isArray(data.scannedSources) ? data.scannedSources : []
        };
      }
    } catch {
      // try next candidate
    }
  }
  return getProtocolNewsFallback(protocol);
}
