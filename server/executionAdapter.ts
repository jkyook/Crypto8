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

export type ExecutionAdapterBundle = {
  txId: string;
  summary: string;
  mode: ExecutionMode;
  adapterResults: AdapterExecutionResult[];
  /** unsupported/failed 어댑터가 있을 때 집계된 경고 목록 */
  warnings: string[];
};

/**
 * 런타임 정보 API와 동일한 기준의 "실효" 실행 모드.
 * live 실행은 EXECUTION_MODE=live + LIVE_EXECUTION_CONFIRM=YES 가 모두 필요.
 * 그 외 모든 경우는 dry-run 으로 강제.
 */
export function getEffectiveExecutionMode(): ExecutionMode {
  if (
    process.env.EXECUTION_MODE === "live" &&
    process.env.LIVE_EXECUTION_CONFIRM === "YES"
  ) {
    return "live";
  }
  return "dry-run";
}

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

function collectWarnings(results: AdapterExecutionResult[]): string[] {
  return results
    .filter((r) => r.status === "unsupported" || r.status === "failed")
    .map((r) => {
      const label = r.status === "failed" ? "FAILED" : "UNSUPPORTED";
      const base = `[${label}] ${r.protocol}/${r.chain}/${r.action}`;
      return r.errorMessage ? `${base}: ${r.errorMessage}` : base;
    });
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

  // submitted/confirmed 결과만 txId 연결 (unsupported/failed/dry-run은 제외)
  const liveTxIds = adapterResults
    .filter((r) => r.status === "submitted" || r.status === "confirmed")
    .map((r) => r.txId)
    .filter(Boolean);

  const txId = liveTxIds.length > 0
    ? liveTxIds.join(",")
    : adapterResults.map((r) => r.txId).filter(Boolean).join(",");

  const summary = buildSummary(adapterResults, mode);
  const warnings = collectWarnings(adapterResults);

  return { txId, summary, mode, adapterResults, warnings };
}
