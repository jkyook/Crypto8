/**
 * Solana 트랜잭션 컨펌/실입금 모니터링 유틸.
 *
 * - Orca Whirlpool 등의 예치 tx 가 buildAndExecute 직후 반환한 signature 를
 *   네트워크 상에서 finalized / confirmed 상태로 안정화되는지 폴링으로 검증.
 * - RPC 후보를 순회하며 일시적 장애를 완충.
 * - 예치 후 잔고 변화를 확인하고 싶을 때 쓸 수 있는 보조 헬퍼도 포함.
 */

export type SolanaTxConfirmationStatus = "processed" | "confirmed" | "finalized";

export type SolanaTxConfirmationResult = {
  signature: string;
  status: SolanaTxConfirmationStatus | "unknown";
  /** RPC가 tx err 를 보고하면 여기에 serialize된 형태로 들어감. */
  error?: string;
  /** 최종 확정된 slot (있을 경우). */
  slot?: number;
  /** 폴링 과정에 사용된 RPC URL. */
  rpcUsed?: string;
  /** 타임아웃/미확인. */
  timedOut?: boolean;
};

type SignatureStatusRow = {
  slot?: number;
  confirmations?: number | null;
  err?: unknown;
  confirmationStatus?: SolanaTxConfirmationStatus;
};

type GetSignatureStatusesResponse = {
  result?: {
    value?: Array<SignatureStatusRow | null>;
  };
  error?: { message?: string };
};

async function fetchSignatureStatuses(rpcUrl: string, signatures: string[]): Promise<Array<SignatureStatusRow | null>> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignatureStatuses",
      params: [signatures, { searchTransactionHistory: true }]
    })
  });
  if (!response.ok) {
    throw new Error(`rpc http ${response.status}`);
  }
  const json = (await response.json()) as GetSignatureStatusesResponse;
  if (json.error?.message) {
    throw new Error(json.error.message);
  }
  return json.result?.value ?? [];
}

function serializeRpcError(value: unknown): string | undefined {
  if (value == null) return undefined;
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isFinalOrBetter(target: SolanaTxConfirmationStatus, actual: SolanaTxConfirmationStatus): boolean {
  const rank: Record<SolanaTxConfirmationStatus, number> = { processed: 0, confirmed: 1, finalized: 2 };
  return rank[actual] >= rank[target];
}

/**
 * 주어진 signature 가 목표 상태(`target`, 기본 confirmed)에 도달할 때까지 폴링.
 * 타임아웃되면 status="unknown" 으로 반환 (예외는 던지지 않음 — 호출자가 처리).
 */
export async function waitForSolanaTxConfirmation(params: {
  signature: string;
  rpcCandidates: string[];
  target?: SolanaTxConfirmationStatus;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<SolanaTxConfirmationResult> {
  const { signature, rpcCandidates } = params;
  const target: SolanaTxConfirmationStatus = params.target ?? "confirmed";
  const timeoutMs = params.timeoutMs ?? 90_000;
  const intervalMs = params.intervalMs ?? 2_500;
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  let lastRpcUsed: string | undefined;

  if (!rpcCandidates || rpcCandidates.length === 0) {
    return { signature, status: "unknown", error: "no rpc candidates provided" };
  }

  while (Date.now() < deadline) {
    for (const rpcUrl of rpcCandidates) {
      try {
        const rows = await fetchSignatureStatuses(rpcUrl, [signature]);
        const row = rows[0];
        lastRpcUsed = rpcUrl;
        if (!row) {
          // 아직 네트워크에 전파 안 됨.
          break;
        }
        if (row.err !== null && row.err !== undefined) {
          return {
            signature,
            status: row.confirmationStatus ?? "unknown",
            error: serializeRpcError(row.err),
            slot: row.slot,
            rpcUsed: rpcUrl
          };
        }
        const effectiveStatus: SolanaTxConfirmationStatus = row.confirmationStatus ?? "processed";
        if (isFinalOrBetter(target, effectiveStatus)) {
          return {
            signature,
            status: effectiveStatus,
            slot: row.slot,
            rpcUsed: rpcUrl
          };
        }
        // 아직 목표 수준이 아님 — 동일 RPC 대기
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        // 다음 RPC 후보로 넘어감
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    signature,
    status: "unknown",
    error: lastError || "timeout waiting for confirmation",
    rpcUsed: lastRpcUsed,
    timedOut: true
  };
}

/**
 * 여러 signature 를 병렬로 확인. 실입금 다중 풀 예치 후 한꺼번에 검증하려 할 때 유용.
 */
export async function waitForSolanaTxConfirmations(params: {
  signatures: string[];
  rpcCandidates: string[];
  target?: SolanaTxConfirmationStatus;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<SolanaTxConfirmationResult[]> {
  return Promise.all(
    params.signatures.map((signature) =>
      waitForSolanaTxConfirmation({
        signature,
        rpcCandidates: params.rpcCandidates,
        target: params.target,
        timeoutMs: params.timeoutMs,
        intervalMs: params.intervalMs
      })
    )
  );
}

/** Solscan explorer URL — 네트워크에 맞게 cluster 쿼리 추가. */
export function solscanTxUrl(signature: string, network: "mainnet" | "devnet"): string {
  const base = `https://solscan.io/tx/${signature}`;
  return network === "devnet" ? `${base}?cluster=devnet` : base;
}

/**
 * 예치 전후 잔고 비교 스냅샷.
 * OnChainPortfolio 두 개를 받아, 소모(감소)된 토큰·증가한 토큰을 리스트로 반환.
 * 예치가 "실제로 실행됐는지" 감지용.
 */
export type BalanceDelta = {
  symbol: string;
  mint?: string;
  before: number;
  after: number;
  delta: number;
  direction: "in" | "out" | "none";
};

type PortfolioLike = {
  sol: number;
  tokens: Array<{ mint: string; symbol: string; amount: number; decimals?: number }>;
};

export function diffOnChainPortfolios(
  before: PortfolioLike,
  after: PortfolioLike,
  opts?: { epsilon?: number }
): BalanceDelta[] {
  const epsilon = opts?.epsilon ?? 1e-9;
  const out: BalanceDelta[] = [];

  // 네이티브 SOL
  const solDelta = (after.sol ?? 0) - (before.sol ?? 0);
  if (Math.abs(solDelta) > epsilon) {
    out.push({
      symbol: "SOL",
      before: before.sol ?? 0,
      after: after.sol ?? 0,
      delta: solDelta,
      direction: solDelta > 0 ? "in" : "out"
    });
  }

  // 토큰 매핑 (mint 기준)
  const beforeByMint = new Map<string, (typeof before.tokens)[number]>();
  for (const row of before.tokens) beforeByMint.set(row.mint, row);
  const afterByMint = new Map<string, (typeof after.tokens)[number]>();
  for (const row of after.tokens) afterByMint.set(row.mint, row);

  const mints = new Set<string>([...beforeByMint.keys(), ...afterByMint.keys()]);
  for (const mint of mints) {
    const bRow = beforeByMint.get(mint);
    const aRow = afterByMint.get(mint);
    const beforeAmount = bRow?.amount ?? 0;
    const afterAmount = aRow?.amount ?? 0;
    const delta = afterAmount - beforeAmount;
    if (Math.abs(delta) <= epsilon) continue;
    out.push({
      symbol: aRow?.symbol ?? bRow?.symbol ?? mint,
      mint,
      before: beforeAmount,
      after: afterAmount,
      delta,
      direction: delta > 0 ? "in" : "out"
    });
  }

  out.sort((l, r) => Math.abs(r.delta) - Math.abs(l.delta));
  return out;
}

/**
 * 잔고 델타에서 "입금 실행으로 간주할 만한 유의미한 out(차감) 움직임" 이 있는지 요약.
 * UI 에서 "실입금 감지됨" 배지를 띄울 때 사용.
 */
export function summarizeDepositEvidence(deltas: BalanceDelta[]): {
  hasOutflow: boolean;
  outflowSymbols: string[];
  topOutflow?: BalanceDelta;
} {
  const outflows = deltas.filter((row) => row.direction === "out");
  const topOutflow = outflows[0];
  return {
    hasOutflow: outflows.length > 0,
    outflowSymbols: outflows.map((row) => row.symbol),
    topOutflow
  };
}
