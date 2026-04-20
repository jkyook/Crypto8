import type { RiskLevel } from "../types";

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** 개발 시 기본값은 빈 문자열 → `http://localhost:5173/api/...`로 요청되어 Vite 프록시가 8787로 넘김(로그인·갱신·입금이 같은 백엔드를 씀). */
function resolveApiBase(): string {
  const raw = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return stripTrailingSlash(raw.trim());
  }
  if (import.meta.env.DEV) {
    return "";
  }
  return "http://localhost:8787";
}

const API_BASE = resolveApiBase();
/** 프록시 실패·잘못된 VITE 설정으로 HTML이 올 때 개발 모드에서만 직접 붙일 API */
const DEV_DIRECT_APIS = ["http://localhost:8787", "http://127.0.0.1:8787"] as const;
const DEV_DIRECT_API = DEV_DIRECT_APIS[0];
const CSRF_STORAGE_KEY = "crypto8.csrfToken";

function buildApiUrl(base: string, path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (!base) {
    return p;
  }
  return `${base}${p}`;
}

/** 백서 PDF — API 서버가 `/api/whitepaper.pdf`로 제공(정적 호스트가 아님). */
export function getWhitepaperPdfUrl(): string {
  return buildApiUrl(API_BASE, "/api/whitepaper.pdf");
}

/** Vite dev·localhost preview 등에서 /api 프록시가 깨져도 8787 직접 호출을 시도합니다. */
function shouldUseLocal8787Fallback(): boolean {
  if (import.meta.env.DEV) {
    return true;
  }
  if (typeof window === "undefined") {
    return false;
  }
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1";
}

/** Content-Type이 없거나 빗나가도, 본문이 HTML이면 감지합니다. */
async function responseLooksLikeHtml(res: Response): Promise<boolean> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/html")) {
    return true;
  }
  if (ct.includes("application/json")) {
    return false;
  }
  try {
    const head = (await res.clone().text()).trimStart().slice(0, 256);
    return head.startsWith("<") || head.startsWith("<!");
  } catch {
    return false;
  }
}

async function fetchWithLocal8787Fallback(path: string, init: RequestInit, context: string): Promise<Response> {
  const fetchFrom = (base: string) => fetch(buildApiUrl(base, path), { ...init, credentials: "include" });
  const fallbackBases = shouldUseLocal8787Fallback()
    ? DEV_DIRECT_APIS.filter((base) => stripTrailingSlash(API_BASE) !== stripTrailingSlash(base))
    : [];
  const tryFallbacks = async (): Promise<Response | null> => {
    for (const base of fallbackBases) {
      try {
        return await fetchFrom(base);
      } catch {
        // 다음 로컬 호스트 후보 시도
      }
    }
    return null;
  };
  try {
    const first = await fetchFrom(API_BASE);
    if (
      fallbackBases.length > 0 &&
      (await responseLooksLikeHtml(first))
    ) {
      return (await tryFallbacks()) ?? first;
    }
    return first;
  } catch (err) {
    if (fallbackBases.length > 0) {
      const fallback = await tryFallbacks();
      if (fallback) return fallback;
    }
    wrapNetworkError(err, context);
  }
}

/** 로컬 세션 표시만 지움(리프레시 실패 등). `App`이 이 이벤트로 UI 동기화. */
export const AUTH_CLEARED_EVENT = "crypto8:auth-cleared";
/** 같은 탭에서 로그인·토큰 갱신 후 세션 표시를 다시 읽도록(예: 예치 실행 모달). */
export const AUTH_UPDATED_EVENT = "crypto8:session-updated";

const LEGACY_TOKEN_KEY = "crypto8_access_token";
const LEGACY_REFRESH_TOKEN_KEY = "crypto8_refresh_token";
const ROLE_KEY = "crypto8_role";
const USERNAME_KEY = "crypto8_username";
const CSRF_COOKIE_NAME = "csrf_token";

export type ProductNetwork = "Ethereum" | "Arbitrum" | "Base" | "Solana" | "Multi";

export type ProductSubtype =
  | "multi-stable"
  | "multi-balanced"
  | "arb-stable"
  | "base-stable"
  | "sol-stable"
  | "eth-stable"
  | "eth-bluechip";

export type JobInput = {
  depositUsd: number;
  isRangeOut: boolean;
  isDepegAlert: boolean;
  hasPendingRelease: boolean;
  sourceAsset?: AccountAssetSymbol;
  /** 예치상품의 대상 네트워크. 미지정 시 Multi(전체 체인) 전략으로 실행. */
  productNetwork?: ProductNetwork;
  /** 상품 서브타입. 동일 네트워크 내 배분 비율 결정에 사용. */
  productSubtype?: ProductSubtype;
};

export type Job = {
  id: string;
  createdAt: string;
  status: "queued" | "blocked" | "executed" | "cancelled";
  input: JobInput;
  riskLevel: RiskLevel;
  /** 서버에 기록된 요청자(로그인 사용자명). */
  requestedBy?: string | null;
};

export type AuthRole = "orchestrator" | "security" | "viewer";

export type AuthSession = {
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
    status: "simulated" | "submitted" | "confirmed" | "unsupported" | "failed";
  }>;
  retries?: number;
  errorMessage?: string;
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

export type MarketAprHistoryPoint = {
  t: string;
  aave: number;
  uniswap: number;
  orca: number;
};

export type MarketPoolAprHistorySeries = {
  key: string;
  label: string;
  poolLabel: string;
  matchedLabel?: string;
  matchedProject?: string;
  matchedChain?: string;
  matchedSymbol?: string;
};

export type MarketPoolAprHistoryPoint = {
  t: string;
  pools: Record<string, number>;
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

export type OnchainPositionVerifySnapshot = {
  status: "verified" | "drift" | "closed_onchain" | "rpc_error" | "unsupported";
  onchainAmountUsd: number | null;
  onchainRaw: string | null;
  driftPct: number | null;
  detail: string;
  verifiedAt: string;
  walletAddress: string | null;
};

export type OnchainPositionPayload = {
  id: string;
  executionId: string;
  username: string;
  protocol: string;
  chain: string;
  asset: string;
  poolAddress: string | null;
  positionToken: string | null;
  positionRaw: string | null;
  amountUsd: number;
  depositTxHash: string;
  lastSyncedAt: string | null;
  status: "active" | "closed" | "liquidated";
  openedAt: string;
  closedAt: string | null;
  onchainDataJson: string | null;
  verify?: OnchainPositionVerifySnapshot | null;
};

export type AccountAssetSymbol = "USDC" | "USDT" | "ETH" | "SOL";

export type AaveUsdcChain = "Arbitrum" | "Base";

export type AaveTxRequest = {
  kind: "approve" | "supply" | "withdraw";
  chain: AaveUsdcChain;
  chainId: number;
  from: string;
  to: string;
  data: string;
  value: "0x0";
  description: string;
};

export type AaveUsdcPositionSnapshot = {
  chain: AaveUsdcChain;
  chainId: number;
  walletAddress: string;
  poolAddress: string;
  underlyingAddress: string;
  aTokenAddress: string;
  walletUsdc: number;
  walletUsdcRaw: string;
  allowanceRaw: string;
  suppliedUsdc: number;
  suppliedUsdcRaw: string;
  liquidityRateRay: string;
};

export type AccountAssetBalance = {
  symbol: AccountAssetSymbol;
  chain: string;
  amount: number;
  usdPrice: number;
  usdValue: number;
  priceSource: string;
  priceUpdatedAt: string;
};

export type UserWallet = {
  id: string;
  username: string;
  walletAddress: string;
  chain: string;
  provider: string;
  createdAt: string;
};

export type ProtocolFeeEstimateRow = {
  protocol: string;
  chain: string;
  action: string;
  allocationUsd: number;
  nativeAsset: "ETH" | "SOL";
  gasUnits: number;
  gasPriceGwei?: number;
  networkFeeUsd: number;
  swapFeeUsd: number;
  bridgeFeeUsd: number;
  estimatedFeeUsd: number;
  confidence: "medium" | "low";
  note: string;
};

export type ProtocolFeeEstimate = {
  rows: ProtocolFeeEstimateRow[];
  totalFeeUsd: number;
  priceSource: string;
  updatedAt: string;
};

export type MarketPriceSnapshot = {
  prices: Record<AccountAssetSymbol, number>;
  updatedAt: string;
  source: string;
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

function readCookie(name: string): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const prefix = `${name}=`;
  const raw = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  if (!raw) {
    return null;
  }
  return decodeURIComponent(raw.slice(prefix.length));
}

function readStoredCsrfToken(): string | null {
  if (typeof sessionStorage !== "undefined") {
    const token = sessionStorage.getItem(CSRF_STORAGE_KEY);
    if (token) return token;
  }
  return readCookie(CSRF_COOKIE_NAME);
}

function storeCsrfToken(token: unknown): void {
  if (typeof token !== "string" || token.length === 0) {
    return;
  }
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.setItem(CSRF_STORAGE_KEY, token);
  }
}

function clearStoredCsrfToken(): void {
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem(CSRF_STORAGE_KEY);
  }
}

function storeCsrfTokenFromResponse(response: Response, data?: Record<string, unknown>): void {
  const headerToken = response.headers.get("X-CSRF-Token");
  storeCsrfToken(headerToken ?? data?.csrfToken);
}

async function responseIsCsrfMismatch(response: Response): Promise<boolean> {
  if (response.status !== 403) {
    return false;
  }
  try {
    const text = await response.clone().text();
    return /csrf token mismatch/i.test(text);
  } catch {
    return false;
  }
}

function isUnsafeMethod(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return !["GET", "HEAD", "OPTIONS"].includes(normalized);
}

async function ensureCsrfToken(): Promise<string | null> {
  const current = readStoredCsrfToken();
  if (current) {
    return current;
  }
  try {
    const response = await fetch(buildApiUrl(API_BASE, "/api/auth/csrf"), {
      credentials: "include"
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    storeCsrfTokenFromResponse(response, data);
    return readStoredCsrfToken();
  } catch {
    return null;
  }
}

async function addCsrfHeader(headers: Headers, method: string | undefined): Promise<void> {
  if (!isUnsafeMethod(method)) {
    return;
  }
  const csrfToken = await ensureCsrfToken();
  if (csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }
}

export function getSession(): AuthSession | null {
  const role = localStorage.getItem(ROLE_KEY) as AuthRole | null;
  const username = localStorage.getItem(USERNAME_KEY);
  if (!role || !username) {
    return null;
  }
  return { role, username };
}

/** `useSyncExternalStore`용: HttpOnly 쿠키 대신 로컬 세션 마커만 구독합니다. */
export function readAccessTokenSnapshot(): string {
  if (typeof localStorage === "undefined") {
    return "";
  }
  const role = localStorage.getItem(ROLE_KEY) ?? "";
  const username = localStorage.getItem(USERNAME_KEY) ?? "";
  return role && username ? `${username}:${role}` : "";
}

export function subscribeLocalAuth(callback: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const onStorage = (e: StorageEvent): void => {
    if (
      e.key === LEGACY_TOKEN_KEY ||
      e.key === LEGACY_REFRESH_TOKEN_KEY ||
      e.key === ROLE_KEY ||
      e.key === USERNAME_KEY ||
      e.key === null
    ) {
      callback();
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(AUTH_CLEARED_EVENT, callback);
  window.addEventListener(AUTH_UPDATED_EVENT, callback);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(AUTH_CLEARED_EVENT, callback);
    window.removeEventListener(AUTH_UPDATED_EVENT, callback);
  };
}

function clearAuthStorageSync(): void {
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(USERNAME_KEY);
  clearStoredCsrfToken();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_CLEARED_EVENT));
  }
}

export async function clearSession(): Promise<void> {
  try {
    const headers = new Headers({ "Content-Type": "application/json" });
    await addCsrfHeader(headers, "POST");
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify({})
    });
  } catch {
    /* 서버 없음·토큰 무효여도 로컬은 정리 */
  }
  clearAuthStorageSync();
}

async function readJsonFromApiResponse(response: Response, context: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<") || trimmed.startsWith("<!")) {
    throw new Error(
      `${context}: 서버가 JSON 대신 HTML(웹 페이지)을 돌려주었습니다. 보통 API 주소가 잘못됐거나(프론트 5173만 호출), API 프로세스가 꺼져 있을 때입니다. 로컬이면 \`npm run dev:api\`(8787)를 실행하고, 개발 시 \`VITE_API_BASE_URL\`은 비워 두어 /api 프록시를 쓰거나 \`http://localhost:8787\`로 맞추세요.`
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${context}: JSON이 아닙니다. (${text.slice(0, 120)}…)`);
  }
}

function wrapNetworkError(err: unknown, context: string): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg === "Failed to fetch" ||
    msg.includes("Load failed") ||
    msg.includes("NetworkError") ||
    msg.includes("Network request failed") ||
    msg.includes("CORS") ||
    msg.includes("fetch") ||
    msg.includes("ECONNREFUSED")
  ) {
    throw new Error(
      `${context}: API 서버에 연결할 수 없습니다. 로컬 개발 중이라면 터미널에서 \`npm run dev:api\`를 실행해 주세요. (포트 8787)`
    );
  }
  throw err instanceof Error ? err : new Error(msg);
}

export async function login(username: string, password: string): Promise<AuthSession> {
  const response = await fetchWithLocal8787Fallback(
    "/api/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    },
    "로그인"
  );
  const data = (await readJsonFromApiResponse(response, "로그인")) as {
    ok: boolean;
    role?: AuthRole;
    username?: string;
    csrfToken?: string;
    message?: string;
  };
  if (!response.ok || !data.role) {
    const raw = data.message ?? "로그인 실패";
    if (response.status === 401 && /invalid credentials/i.test(raw)) {
      throw new Error(
        "아이디·비밀번호가 맞지 않거나, 붙어 있는 API 서버에 사용자 데이터가 없습니다. orchestrator_admin / orchestrator123 조합을 확인하고, 로컬이면 API를 한 번 재시작하거나 터미널에서 npx prisma db seed 를 실행해 보세요."
      );
    }
    throw new Error(raw);
  }
  const session: AuthSession = {
    role: data.role,
    username: data.username ?? username
  };
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY);
  storeCsrfTokenFromResponse(response, data);
  localStorage.setItem(ROLE_KEY, session.role);
  localStorage.setItem(USERNAME_KEY, session.username);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_UPDATED_EVENT));
  }
  return session;
}

export async function loginWithWallet(walletAddress: string): Promise<AuthSession> {
  const challengeResponse = await fetchWithLocal8787Fallback(
    "/api/auth/wallet/challenge",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress })
    },
    "지갑 로그인 메시지 생성"
  );
  const challenge = (await readJsonFromApiResponse(challengeResponse, "지갑 로그인 메시지 생성")) as {
    ok?: boolean;
    nonce?: string;
    message?: string;
  };
  if (!challengeResponse.ok || !challenge.nonce || !challenge.message) {
    throw new Error(typeof challenge.message === "string" ? challenge.message : "지갑 로그인 메시지 생성 실패");
  }
  const provider = (window as {
    phantom?: {
      solana?: {
        isPhantom?: boolean;
        signMessage?: (message: Uint8Array) => Promise<Uint8Array | { signature?: Uint8Array | number[] }>;
      };
    };
  }).phantom?.solana;
  if (!provider?.isPhantom || typeof provider.signMessage !== "function") {
    throw new Error("Phantom 지갑 서명이 필요합니다.");
  }
  const signed = await provider.signMessage(new TextEncoder().encode(challenge.message));
  const signatureBytes =
    signed instanceof Uint8Array
      ? signed
      : signed.signature instanceof Uint8Array
        ? signed.signature
        : Array.isArray(signed.signature)
          ? new Uint8Array(signed.signature)
          : null;
  if (!signatureBytes) {
    throw new Error("지갑 서명 결과를 읽지 못했습니다.");
  }
  const signature = btoa(String.fromCharCode(...signatureBytes));
  const response = await fetchWithLocal8787Fallback(
    "/api/auth/wallet",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress, nonce: challenge.nonce, signature })
    },
    "지갑 로그인"
  );
  const data = (await readJsonFromApiResponse(response, "지갑 로그인")) as {
    ok?: boolean;
    role?: AuthRole;
    username?: string;
    csrfToken?: string;
    message?: string;
  };
  if (!response.ok || !data.role || !data.username) {
    throw new Error(typeof data.message === "string" ? data.message : "지갑 로그인 실패");
  }
  const session: AuthSession = { role: data.role, username: data.username };
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY);
  storeCsrfTokenFromResponse(response, data);
  localStorage.setItem(ROLE_KEY, session.role);
  localStorage.setItem(USERNAME_KEY, session.username);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_UPDATED_EVENT));
  }
  return session;
}

function mapRegisterError(status: number, code: string | undefined): string {
  if (status === 404) {
    return "회원가입 API를 찾을 수 없습니다. API 서버를 최신 코드로 재시작했는지 확인하세요.";
  }
  if (status === 409 || code === "username taken") {
    return "이미 사용 중인 아이디입니다.";
  }
  if (code === "username length invalid") {
    return "아이디는 3~64자여야 합니다.";
  }
  if (code === "username format invalid") {
    return "아이디는 영문·숫자·밑줄·점·하이픈만 사용할 수 있습니다.";
  }
  if (code === "password length invalid") {
    return "비밀번호는 8~200자여야 합니다.";
  }
  if (code === "username/password required") {
    return "아이디와 비밀번호를 입력하세요.";
  }
  return "회원가입에 실패했습니다.";
}

/** 일반 이용자 회원가입(역할 `viewer`). 성공 시 로그인과 동일하게 토큰을 저장합니다. */
export async function register(username: string, password: string): Promise<AuthSession> {
  const trimmed = username.trim();
  const response = await fetchWithLocal8787Fallback(
    "/api/auth/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: trimmed, password })
    },
    "회원가입"
  );
  const data = (await readJsonFromApiResponse(response, "회원가입")) as {
    ok?: boolean;
    role?: AuthRole;
    username?: string;
    csrfToken?: string;
    message?: string;
  };
  if (!response.ok || !data.role) {
    throw new Error(mapRegisterError(response.status, typeof data.message === "string" ? data.message : undefined));
  }
  const session: AuthSession = {
    role: data.role,
    username: data.username ?? trimmed
  };
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY);
  storeCsrfTokenFromResponse(response, data);
  localStorage.setItem(ROLE_KEY, session.role);
  localStorage.setItem(USERNAME_KEY, session.username);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_UPDATED_EVENT));
  }
  return session;
}

export type SelfRegistrationRow = {
  username: string;
  role: string;
  registeredAt: string | null;
};

/** 운영자(orchestrator) 전용: 직접 가입(`registered_at` 있음) 계정 목록. */
export async function listSelfRegistrations(): Promise<SelfRegistrationRow[]> {
  const response = await authedFetch("/api/admin/self-registrations");
  const raw = (await readJsonFromApiResponse(response, "회원가입 내역")) as {
    message?: string;
    registrations?: SelfRegistrationRow[];
  };
  if (!response.ok) {
    throw new Error(typeof raw.message === "string" && raw.message.length > 0 ? raw.message : "회원가입 내역 조회 실패");
  }
  const regs = raw.registrations;
  return Array.isArray(regs) ? regs : [];
}

export async function listAccountAssets(init: Pick<RequestInit, "signal"> = {}): Promise<AccountAssetBalance[]> {
  const response = await authedFetch("/api/account/assets", init);
  const raw = (await readJsonFromApiResponse(response, "계정 자산 조회")) as {
    message?: string;
    assets?: AccountAssetBalance[];
  };
  if (!response.ok) {
    throw new Error(typeof raw.message === "string" && raw.message.length > 0 ? raw.message : "계정 자산 조회 실패");
  }
  return Array.isArray(raw.assets) ? raw.assets : [];
}

// 지갑 잔고는 온체인 공개 데이터 → 인증 없이 직접 fetch (authedFetch 불필요)
// 로그인 여부와 관계없이 지갑을 연결하면 실제 잔고를 바로 표시한다.
export async function listWalletAssets(
  walletAddress: string,
  init: Pick<RequestInit, "signal"> = {},
  evmAddress?: string
): Promise<AccountAssetBalance[]> {
  const query = new URLSearchParams();
  if (walletAddress) {
    query.set("walletAddress", walletAddress);
  }
  if (evmAddress) {
    query.set("evmAddress", evmAddress);
  }
  const path = `/api/account/wallet-assets?${query.toString()}`;
  const response = await fetchWithLocal8787Fallback(path, { signal: init.signal }, "연결 지갑 자산 조회");
  const raw = (await readJsonFromApiResponse(response, "연결 지갑 자산 조회")) as {
    message?: string;
    assets?: AccountAssetBalance[];
  };
  if (!response.ok) {
    throw new Error(typeof raw.message === "string" && raw.message.length > 0 ? raw.message : "연결 지갑 자산 조회 실패");
  }
  return Array.isArray(raw.assets) ? raw.assets : [];
}

export async function listAccountWallets(init: Pick<RequestInit, "signal"> = {}): Promise<UserWallet[]> {
  const response = await authedFetch("/api/account/wallets", init);
  const raw = (await readJsonFromApiResponse(response, "계정 지갑 조회")) as { message?: string; wallets?: UserWallet[] };
  if (!response.ok) {
    throw new Error(typeof raw.message === "string" && raw.message.length > 0 ? raw.message : "계정 지갑 조회 실패");
  }
  return Array.isArray(raw.wallets) ? raw.wallets : [];
}

export async function linkAccountWallet(walletAddress: string, chain = "Solana", provider = "phantom"): Promise<UserWallet> {
  const response = await authedFetch("/api/account/wallets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress, chain, provider })
  });
  const raw = (await readJsonFromApiResponse(response, "계정 지갑 연결")) as { message?: string; wallet?: UserWallet };
  if (!response.ok || !raw.wallet) {
    throw new Error(typeof raw.message === "string" && raw.message.length > 0 ? raw.message : "계정 지갑 연결 실패");
  }
  return raw.wallet;
}

export async function fetchMarketPrices(init: Pick<RequestInit, "signal"> = {}): Promise<MarketPriceSnapshot> {
  const response = await fetchWithLocal8787Fallback("/api/market/prices", { signal: init.signal }, "시장 가격 조회");
  const raw = (await readJsonFromApiResponse(response, "시장 가격 조회")) as MarketPriceSnapshot & { ok?: boolean; message?: string };
  if (!response.ok) {
    throw new Error(typeof raw.message === "string" && raw.message.length > 0 ? raw.message : "시장 가격 조회 실패");
  }
  return {
    prices: raw.prices,
    updatedAt: raw.updatedAt,
    source: raw.source
  };
}

export async function estimateProtocolFees(
  rows: Array<{ protocol: string; chain: string; action: string; allocationUsd: number }>,
  init: Pick<RequestInit, "signal"> = {}
): Promise<ProtocolFeeEstimate> {
  const response = await authedFetch("/api/orchestrator/fee-estimate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: init.signal,
    body: JSON.stringify({ rows })
  });
  const raw = (await readJsonFromApiResponse(response, "프로토콜 수수료 추정")) as ProtocolFeeEstimate & { message?: string };
  if (!response.ok) {
    throw new Error(typeof raw.message === "string" && raw.message.length > 0 ? raw.message : "프로토콜 수수료 추정 실패");
  }
  return {
    rows: Array.isArray(raw.rows) ? raw.rows : [],
    totalFeeUsd: typeof raw.totalFeeUsd === "number" ? raw.totalFeeUsd : 0,
    priceSource: typeof raw.priceSource === "string" ? raw.priceSource : "unknown",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString()
  };
}

async function refreshAccessTokenOrThrow(): Promise<AuthSession> {
  const postRefresh = async (): Promise<Response> => {
    const headers = new Headers({ "Content-Type": "application/json" });
    await addCsrfHeader(headers, "POST");
    return fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify({})
    });
  };
  let response = await postRefresh();
  if (await responseIsCsrfMismatch(response)) {
    clearStoredCsrfToken();
    await ensureCsrfToken();
    response = await postRefresh();
  }
  const data = (await response.json()) as { role?: AuthRole; username?: string; csrfToken?: string; message?: string };
  if (!response.ok || !data.role || !data.username) {
    clearAuthStorageSync();
    const raw = data.message ?? "토큰 갱신 실패";
    if (/invalid refresh token/i.test(raw)) {
      throw new Error(
        "로그인 세션이 서버와 맞지 않습니다. (API 주소가 바뀌었거나 서버·DB를 다시 띄운 경우 흔합니다.) 다시 로그인해 주세요."
      );
    }
    throw new Error(raw);
  }
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY);
  storeCsrfTokenFromResponse(response, data);
  localStorage.setItem(ROLE_KEY, data.role);
  localStorage.setItem(USERNAME_KEY, data.username);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_UPDATED_EVENT));
  }
  return { role: data.role, username: data.username };
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!getSession()) {
    throw new Error("로그인이 필요합니다.");
  }

  const headers = new Headers(init.headers ?? {});
  await addCsrfHeader(headers, init.method);

  const fetchOnce = (base: string): Promise<Response> => {
    return fetch(buildApiUrl(base, path), { ...init, credentials: "include", headers: new Headers(headers) });
  };

  let first = await fetchOnce(API_BASE);
  if (
    shouldUseLocal8787Fallback() &&
    stripTrailingSlash(API_BASE) !== stripTrailingSlash(DEV_DIRECT_API) &&
    (await responseLooksLikeHtml(first))
  ) {
    first = await fetchOnce(DEV_DIRECT_API);
  }

  if (await responseIsCsrfMismatch(first)) {
    clearStoredCsrfToken();
    await ensureCsrfToken();
    const freshHeaders = new Headers(init.headers ?? {});
    await addCsrfHeader(freshHeaders, init.method);
    first = await fetch(buildApiUrl(API_BASE, path), { ...init, credentials: "include", headers: freshHeaders });
  }

  if (first.status !== 401) {
    return first;
  }

  await refreshAccessTokenOrThrow();
  const retryHeaders = new Headers(init.headers ?? {});
  await addCsrfHeader(retryHeaders, init.method);

  const retryFetch = (base: string): Promise<Response> => {
    return fetch(buildApiUrl(base, path), { ...init, credentials: "include", headers: retryHeaders });
  };

  let second = await retryFetch(API_BASE);
  if (
    shouldUseLocal8787Fallback() &&
    stripTrailingSlash(API_BASE) !== stripTrailingSlash(DEV_DIRECT_API) &&
    (await responseLooksLikeHtml(second))
  ) {
    second = await retryFetch(DEV_DIRECT_API);
  }
  return second;
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
      return "권한이 없습니다. 로그인 상태와 계정 권한을 확인하세요.";
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

export async function listJobs(init: Pick<RequestInit, "signal"> = {}): Promise<Job[]> {
  const response = await authedFetch("/api/orchestrator/jobs", init);
  if (!response.ok) {
    throw new Error("작업 목록 조회 실패");
  }
  const data = (await response.json()) as { jobs: Job[] };
  return data.jobs;
}

export async function cancelJob(jobId: string): Promise<Job> {
  const response = await authedFetch(`/api/orchestrator/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST"
  });
  if (!response.ok) {
    throw new Error(await readErrorFromApiResponse(response, "작업 취소 실패"));
  }
  const data = (await response.json()) as { job: Job };
  return data.job;
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
    throw new Error(await readErrorFromApiResponse(response, "승인 로그 기록 실패"));
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
  options?: { idempotencyKey?: string; correlationId?: string; positionId?: string; requestedMode?: "dry-run" | "live" }
): Promise<ExecuteJobResponse> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options?.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  const body: { correlationId?: string; positionId?: string; requestedMode?: "dry-run" | "live" } = {};
  if (options?.correlationId) {
    body.correlationId = options.correlationId;
  }
  if (options?.positionId) {
    body.positionId = options.positionId;
  }
  if (options?.requestedMode) {
    body.requestedMode = options.requestedMode;
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

export async function listExecutionEvents(jobId?: string, init: Pick<RequestInit, "signal"> = {}): Promise<ExecutionEvent[]> {
  const query = jobId ? `?jobId=${encodeURIComponent(jobId)}` : "";
  const response = await authedFetch(`/api/orchestrator/execution-events${query}`, init);
  if (!response.ok) {
    throw new Error("실행 이벤트 조회 실패");
  }
  const data = (await response.json()) as { events: ExecutionEvent[] };
  return data.events;
}

export async function listDepositPositions(init: Pick<RequestInit, "signal"> = {}): Promise<DepositPositionPayload[]> {
  const response = await authedFetch("/api/portfolio/positions", init);
  if (!response.ok) {
    throw new Error("예치 포지션 조회 실패");
  }
  const data = (await response.json()) as { positions?: DepositPositionPayload[] };
  return data.positions ?? [];
}

export async function listOnchainPositions(init: Pick<RequestInit, "signal"> = {}): Promise<OnchainPositionPayload[]> {
  const response = await authedFetch("/api/positions", init);
  if (!response.ok) {
    throw new Error("온체인 포지션 조회 실패");
  }
  const data = (await response.json()) as { positions?: OnchainPositionPayload[] };
  return data.positions ?? [];
}

export type PortfolioWithdrawLine = {
  id: string;
  amountUsd: number;
  createdAt: string;
};

export async function listWithdrawalLedger(init: Pick<RequestInit, "signal"> = {}): Promise<PortfolioWithdrawLine[]> {
  const response = await authedFetch("/api/portfolio/withdrawals", init);
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
      msg = "권한이 없습니다. 로그인 후 다시 시도하세요.";
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
      msg = "권한이 없습니다. 로그인 후 다시 시도하세요.";
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

export async function withdrawProtocolExposureRemote(payload: {
  amountUsd: number;
  protocol: string;
  chain?: string;
  pool?: string;
}): Promise<{ withdrawnUsd: number }> {
  const response = await authedFetch("/api/portfolio/withdraw-protocol", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
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
      msg = "권한이 없습니다. 로그인 후 다시 시도하세요.";
    }
    throw new Error(msg ?? "프로토콜별 인출 반영 실패");
  }
  const withdrawnUsd = typeof data.withdrawnUsd === "number" ? data.withdrawnUsd : 0;
  return { withdrawnUsd };
}

export async function withdrawProductDepositRemote(payload: {
  amountUsd: number;
  productName: string;
}): Promise<{ withdrawnUsd: number }> {
  const response = await authedFetch("/api/portfolio/withdraw-product", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
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
      msg = "권한이 없습니다. 로그인 후 다시 시도하세요.";
    }
    throw new Error(msg ?? "상품별 인출 반영 실패");
  }
  const withdrawnUsd = typeof data.withdrawnUsd === "number" ? data.withdrawnUsd : 0;
  return { withdrawnUsd };
}

export async function fetchAaveUsdcPosition(
  chain: AaveUsdcChain,
  walletAddress: string,
  init: Pick<RequestInit, "signal"> = {}
): Promise<AaveUsdcPositionSnapshot> {
  const query = new URLSearchParams({ chain, walletAddress });
  const response = await authedFetch(`/api/aave/usdc/position?${query.toString()}`, init);
  const raw = (await readJsonFromApiResponse(response, "Aave USDC 포지션 조회")) as {
    message?: string;
    position?: AaveUsdcPositionSnapshot;
  };
  if (!response.ok || !raw.position) {
    throw new Error(typeof raw.message === "string" && raw.message.length > 0 ? raw.message : "Aave USDC 포지션 조회 실패");
  }
  return raw.position;
}

export async function buildAaveUsdcSupplyTx(
  chain: AaveUsdcChain,
  walletAddress: string,
  amountUsdc: number
): Promise<{ amountRaw: string; transactions: AaveTxRequest[]; position: AaveUsdcPositionSnapshot }> {
  const response = await authedFetch("/api/aave/usdc/supply-tx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chain, walletAddress, amountUsdc })
  });
  const raw = (await readJsonFromApiResponse(response, "Aave USDC 입금 트랜잭션 생성")) as {
    message?: string;
    amountRaw?: string;
    transactions?: AaveTxRequest[];
    position?: AaveUsdcPositionSnapshot;
  };
  if (!response.ok || !raw.amountRaw || !Array.isArray(raw.transactions) || !raw.position) {
    throw new Error(typeof raw.message === "string" && raw.message.length > 0 ? raw.message : "Aave USDC 입금 트랜잭션 생성 실패");
  }
  return { amountRaw: raw.amountRaw, transactions: raw.transactions, position: raw.position };
}

export async function buildAaveUsdcWithdrawTx(
  chain: AaveUsdcChain,
  walletAddress: string,
  amountUsdc: number
): Promise<{ amountRaw: string; transaction: AaveTxRequest; position: AaveUsdcPositionSnapshot }> {
  const response = await authedFetch("/api/aave/usdc/withdraw-tx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chain, walletAddress, amountUsdc })
  });
  const raw = (await readJsonFromApiResponse(response, "Aave USDC 출금 트랜잭션 생성")) as {
    message?: string;
    amountRaw?: string;
    transaction?: AaveTxRequest;
    position?: AaveUsdcPositionSnapshot;
  };
  if (!response.ok || !raw.amountRaw || !raw.transaction || !raw.position) {
    throw new Error(typeof raw.message === "string" && raw.message.length > 0 ? raw.message : "Aave USDC 출금 트랜잭션 생성 실패");
  }
  return { amountRaw: raw.amountRaw, transaction: raw.transaction, position: raw.position };
}

export async function confirmAaveUsdcTx(
  chain: AaveUsdcChain,
  walletAddress: string,
  txHash: string,
  kind: "supply" | "withdraw",
  amountUsdc: number
): Promise<{ status: "pending" | "confirmed"; position?: unknown }> {
  const response = await authedFetch("/api/aave/usdc/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chain, walletAddress, txHash, kind, amountUsdc })
  });
  const raw = (await readJsonFromApiResponse(response, "Aave USDC 트랜잭션 확인")) as {
    message?: string;
    status?: "pending" | "confirmed";
    position?: unknown;
  };
  if (!response.ok || (raw.status !== "pending" && raw.status !== "confirmed")) {
    throw new Error(typeof raw.message === "string" && raw.message.length > 0 ? raw.message : "Aave USDC 트랜잭션 확인 실패");
  }
  return { status: raw.status, position: raw.position };
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

export async function fetchMarketAprHistory(opts?: {
  hours?: number;
  bucket?: "auto" | "hour" | "day";
}): Promise<{ granularity: "hour" | "day"; points: MarketAprHistoryPoint[] }> {
  const hours = opts?.hours ?? 168;
  const bucket = opts?.bucket ?? "auto";
  const qs = new URLSearchParams({ hours: String(hours), bucket });
  const path = `/api/market/rates/history?${qs.toString()}`;
  const candidates = [buildApiUrl(API_BASE, path), `http://localhost:8787${path}`];
  for (const url of candidates) {
    try {
      const response = await fetch(url);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        continue;
      }
      const data = (await response.json()) as {
        ok?: boolean;
        granularity?: "hour" | "day";
        points?: MarketAprHistoryPoint[];
      };
      if (response.ok && data.points && data.granularity) {
        return { granularity: data.granularity, points: data.points };
      }
    } catch {
      // try next
    }
  }
  const h = opts?.hours ?? 168;
  return { granularity: h <= 72 ? "hour" : "day", points: [] };
}

/** `apy_history.csv` 기반 일별 APY (Aave Arb+Base / Uniswap Arb / Orca Sol 평균). */
export async function fetchDailyApyHistoryFromCsv(opts?: { days?: number }): Promise<{
  ok: boolean;
  source?: string;
  granularity: "day";
  points: MarketAprHistoryPoint[];
  message?: string;
}> {
  const days = opts?.days ?? 90;
  const path = `/api/market/apy-history-csv?days=${days}`;
  const candidates = [buildApiUrl(API_BASE, path), `http://localhost:8787${path}`];
  for (const url of candidates) {
    try {
      const response = await fetch(url);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        continue;
      }
      const data = (await response.json()) as {
        ok?: boolean;
        source?: string;
        granularity?: "day";
        points?: MarketAprHistoryPoint[];
        message?: string;
      };
      if (response.ok && data.points && data.granularity === "day") {
        return {
          ok: Boolean(data.ok),
          source: data.source,
          granularity: "day",
          points: data.points,
          message: data.message
        };
      }
    } catch {
      // try next
    }
  }
  return { ok: false, granularity: "day", points: [], message: "CSV 이력 API에 연결하지 못했습니다." };
}

export async function fetchPoolApyHistoryFromCsv(opts: { days?: number; pools: string[] }): Promise<{
  ok: boolean;
  source?: string;
  granularity: "day";
  series: MarketPoolAprHistorySeries[];
  points: MarketPoolAprHistoryPoint[];
  message?: string;
}> {
  const days = opts.days ?? 90;
  const qs = new URLSearchParams({ days: String(days) });
  for (const pool of opts.pools) {
    qs.append("pool", pool);
  }
  const path = `/api/market/pool-apy-history-csv?${qs.toString()}`;
  const candidates = [buildApiUrl(API_BASE, path), `http://localhost:8787${path}`];
  for (const url of candidates) {
    try {
      const response = await fetch(url);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        continue;
      }
      const data = (await response.json()) as {
        ok?: boolean;
        source?: string;
        granularity?: "day";
        series?: MarketPoolAprHistorySeries[];
        points?: MarketPoolAprHistoryPoint[];
        message?: string;
      };
      if (response.ok && data.points && data.series && data.granularity === "day") {
        return {
          ok: Boolean(data.ok),
          source: data.source,
          granularity: "day",
          series: data.series,
          points: data.points,
          message: data.message
        };
      }
    } catch {
      // try next
    }
  }
  return {
    ok: false,
    granularity: "day",
    series: [],
    points: [],
    message: "CSV 풀 이력 API에 연결하지 못했습니다."
  };
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
