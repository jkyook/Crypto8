import type { ExecutionJob } from "./types";
import { executeAavePlan } from "./adapters/aaveAdapter";
import { executeAerodromePlan } from "./adapters/aerodromeAdapter";
import { executeCurvePlan } from "./adapters/curveAdapter";
import { executeOrcaPlan } from "./adapters/orcaAdapter";
import { executeRaydiumPlan } from "./adapters/raydiumAdapter";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterResultStatus,
  ExecutionMode,
  ProductNetwork
} from "./adapters/types";
import { executeUniswapPlan } from "./adapters/uniswapAdapter";
import { getEffectiveExecutionMode } from "./runtimeMode";

export type ExecutionAdapterBundle = {
  txId?: string;
  simulationId?: string;
  summary: string;
  mode: ExecutionMode;
  adapterResults: AdapterExecutionResult[];
  /** unsupported/failed 어댑터가 있을 때 집계된 경고 목록 */
  warnings: string[];
};

/**
 * 요청된 모드를 안전하게 결정.
 * 외부에서 requestedMode를 넘겨도 환경변수 기반 실효 모드를 우선 적용.
 */
function resolveExecutionMode(requestedMode?: ExecutionMode): ExecutionMode {
  const effective = getEffectiveExecutionMode();
  // 환경이 dry-run이면 요청 모드와 무관하게 dry-run 고정
  if (effective === "dry-run") return "dry-run";
  // 환경이 live여도 요청 모드가 dry-run이면 dry-run
  if (requestedMode === "dry-run") return "dry-run";
  return "live";
}

function buildSummary(results: AdapterExecutionResult[], mode: ExecutionMode): string {
  const total = results.reduce((acc, item) => acc + item.allocationUsd, 0);
  const statusIcon: Record<AdapterResultStatus, string> = {
    "dry-run": "🔵",
    simulated: "🟡",
    unsupported: "⚫",
    submitted: "🟢",
    confirmed: "✅",
    failed: "🔴"
  };
  const lines = results.map(
    (item) => `${statusIcon[item.status]}${item.protocol}/${item.chain}:$${item.allocationUsd.toFixed(2)}`
  );
  return `[${mode.toUpperCase()}] total=$${total.toFixed(2)} | ${lines.join(", ")}`;
}

function uniqueTxIds(results: AdapterExecutionResult[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const result of results) {
    if (result.status !== "submitted" && result.status !== "confirmed" && result.status !== "dry-run" && result.status !== "simulated") {
      continue;
    }
    const txId = result.txId.trim();
    if (!txId || seen.has(txId)) {
      continue;
    }
    seen.add(txId);
    ids.push(txId);
  }
  if (ids.length > 0) {
    return ids;
  }
  return Array.from(new Set(results.map((r) => r.txId.trim()).filter(Boolean)));
}

function collectWarnings(results: AdapterExecutionResult[]): string[] {
  return results
    .filter((r) => r.status === "unsupported" || r.status === "failed")
    .map((r) => {
      const label = r.status === "failed" ? "FAILED" : "UNSUPPORTED";
      const base = `[${label}] ${r.protocol}/${r.chain}/${r.action}`;
      return r.errorMessage ? `${base}: ${r.errorMessage}` : base;
    });
}

function buildSimulationId(job: ExecutionJob): string {
  return `sim_${job.id}`;
}

/**
 * 네트워크별 어댑터 디스패치.
 * defi_anal.py 분석 기반 배분 비율:
 *
 * Arbitrum Stable  : Aave Arb USDC 50% + Uniswap Arb USDC-USDT 50%
 * Base Stable      : Aave Base USDC 50% + Aerodrome Base USDC-USDT 50%
 * Solana Stable    : Orca USDC-USDT 60% + Orca mSOL-SOL 40%
 * Solana Alpha     : Orca SOL-USDC+mSOL-SOL 65% + Raydium SOL-USDC 35%
 * Ethereum Stable  : Aave ETH USDC 40% + Curve 3pool 35% + Uniswap ETH USDC-USDT 25%
 * Ethereum Blue-chip: Aave ETH WETH 30% + Curve stETH-ETH 40% + Uniswap ETH ETH-USDC 30%
 * Multi (기본)      : Aave (Arb+Base) 35% + Uniswap Arb 40% + Orca 20% + Cash 5%
 */
async function runAdaptersByNetwork(
  context: AdapterExecutionContext
): Promise<AdapterExecutionResult[]> {
  const network: ProductNetwork = context.productNetwork ?? "Multi";

  switch (network) {
    case "Arbitrum": {
      const [aave, uniswap] = await Promise.all([
        executeAavePlan(context),
        executeUniswapPlan(context)
      ]);
      return [...aave, ...uniswap];
    }

    case "Base": {
      const [aave, aerodrome] = await Promise.all([
        executeAavePlan(context),
        executeAerodromePlan(context)
      ]);
      return [...aave, ...aerodrome];
    }

    case "Solana": {
      const [orca, raydium] = await Promise.all([
        executeOrcaPlan(context),
        executeRaydiumPlan(context)
      ]);
      return [...orca, ...raydium];
    }

    case "Ethereum": {
      const [aave, curve, uniswap] = await Promise.all([
        executeAavePlan(context),
        executeCurvePlan(context),
        executeUniswapPlan(context)
      ]);
      return [...aave, ...curve, ...uniswap];
    }

    default: {
      // Multi-chain: Aave + Uniswap + Orca
      const [aave, uniswap, orca] = await Promise.all([
        executeAavePlan(context),
        executeUniswapPlan(context),
        executeOrcaPlan(context)
      ]);
      return [...aave, ...uniswap, ...orca];
    }
  }
}

export async function runExecutionAdapter(
  job: ExecutionJob,
  requestedMode?: ExecutionMode
): Promise<ExecutionAdapterBundle> {
  const mode = resolveExecutionMode(requestedMode);

  const context: AdapterExecutionContext = {
    jobId: job.id,
    mode,
    depositUsd: job.input.depositUsd,
    timestamp: new Date().toISOString(),
    productNetwork: job.input.productNetwork,
    productSubtype: job.input.productSubtype
  };

  const adapterResults = await runAdaptersByNetwork(context);

  // live 실행만 txId 연결하고, dry-run은 별도 simulationId로 구분
  const txId = mode === "live" ? uniqueTxIds(adapterResults).join(",") : undefined;
  const simulationId = mode === "dry-run" ? buildSimulationId(job) : undefined;

  const summary = buildSummary(adapterResults, mode);
  const warnings = collectWarnings(adapterResults);

  return { txId, simulationId, summary, mode, adapterResults, warnings };
}
