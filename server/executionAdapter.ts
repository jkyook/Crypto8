import type { ExecutionJob } from "./types";
import { executeAavePlan } from "./adapters/aaveAdapter";
import { executeAerodromePlan } from "./adapters/aerodromeAdapter";
import { executeCurvePlan } from "./adapters/curveAdapter";
import { executeOrcaPlan } from "./adapters/orcaAdapter";
import { executeRaydiumPlan } from "./adapters/raydiumAdapter";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  ExecutionMode,
  ProductNetwork,
  ProtocolExecutionReadiness
} from "./adapters/types";
import { executeUniswapPlan } from "./adapters/uniswapAdapter";

export type ExecutionAdapterBundle = {
  txId: string;
  summary: string;
  mode: ExecutionMode;
  adapterResults: AdapterExecutionResult[];
  skippedProtocols: ProtocolExecutionReadiness[];
};

/** 런타임 정보 API와 동일한 기준의 "실효" 실행 모드(라이브는 확인 플래그까지 필요). */
export function getEffectiveExecutionMode(): ExecutionMode {
  const requested = process.env.EXECUTION_MODE === "live" ? "live" : "dry-run";
  if (requested === "live" && process.env.LIVE_EXECUTION_CONFIRM === "YES") {
    return "live";
  }
  return "dry-run";
}

function getExecutionMode(requestedMode?: ExecutionMode): ExecutionMode {
  const envMode = requestedMode ?? process.env.EXECUTION_MODE;
  if (envMode === "live") {
    return "live";
  }
  return "dry-run";
}

function ensureSafeLiveMode(mode: ExecutionMode): void {
  if (mode !== "live") {
    return;
  }
  if (process.env.LIVE_EXECUTION_CONFIRM !== "YES") {
    throw new Error("live mode requires LIVE_EXECUTION_CONFIRM=YES");
  }
}

function buildSummary(results: AdapterExecutionResult[], mode: ExecutionMode): string {
  const total = results.reduce((acc, item) => acc + item.allocationUsd, 0);
  const lines = results.map((item) => `${item.protocol}/${item.chain}:${item.allocationUsd.toFixed(2)}`);
  return `${mode.toUpperCase()} execution total=$${total.toFixed(2)} | ${lines.join(", ")}`;
}

function isBuiltForLiveExecution(protocol: AdapterExecutionResult["protocol"]): boolean {
  return protocol === "Aave" || protocol === "Uniswap" || protocol === "Orca";
}

function buildDefaultReadiness(result: AdapterExecutionResult, mode: ExecutionMode): ProtocolExecutionReadiness {
  const implemented = isBuiltForLiveExecution(result.protocol);
  const ready = mode !== "live" ? true : implemented;
  return {
    protocol: result.protocol,
    chain: result.chain,
    action: result.action,
    implemented,
    flagOn: mode === "live",
    ready,
    reason: ready ? "실행 가능" : implemented ? "플래그만 ON" : "라이브 미구현"
  };
}

function readinessKey(row: Pick<ProtocolExecutionReadiness, "protocol" | "chain" | "action">): string {
  return `${row.protocol}::${row.chain}::${row.action}`.toLowerCase();
}

function filterLiveResults(
  results: AdapterExecutionResult[],
  mode: ExecutionMode,
  readiness?: ProtocolExecutionReadiness[]
): { results: AdapterExecutionResult[]; skippedProtocols: ProtocolExecutionReadiness[] } {
  if (mode !== "live") {
    return { results, skippedProtocols: [] };
  }
  const readinessMap = new Map<string, ProtocolExecutionReadiness>();
  for (const row of readiness ?? []) {
    readinessMap.set(readinessKey(row), row);
  }

  const kept: AdapterExecutionResult[] = [];
  const skippedProtocols: ProtocolExecutionReadiness[] = [];
  for (const result of results) {
    const defaultReadiness = buildDefaultReadiness(result, mode);
    const row = readinessMap.get(readinessKey(result));
    const effective = row ?? defaultReadiness;
    if (effective.ready) {
      kept.push(result);
    } else {
      skippedProtocols.push({
        protocol: result.protocol,
        chain: result.chain,
        action: result.action,
        implemented: effective.implemented,
        flagOn: effective.flagOn,
        ready: false,
        reason: effective.reason
      });
    }
  }

  return { results: kept, skippedProtocols };
}

/**
 * 네트워크별 어댑터 디스패치.
 * defi_anal.py 분석 기반 배분 비율 (풀별 APY 가중치):
 *
 * Arbitrum Stable  : Aave Arb USDC 50% + Uniswap Arb USDC-USDT 50%
 * Arbitrum Growth  : Aave Arb USDC 35% + Uniswap Arb USDC-USDT 35% + Uniswap Arb ETH-USDC 30%
 * Base Stable      : Aave Base USDC 50% + Aerodrome Base USDC-USDT 50%
 * Base Yield       : Aave Base USDC 35% + Uniswap Base ETH-USDC 40% + Aerodrome USDC-USDT 25%
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
      // uniswapAdapter의 UNISWAP_ALLOC_TABLE에 "Ethereum:eth-stable / eth-bluechip" 항목이 있어
      // executeUniswapPlan이 올바른 Ethereum 풀 결과를 반환한다.
      const [aave, curve, uniswap] = await Promise.all([
        executeAavePlan(context),
        executeCurvePlan(context),
        executeUniswapPlan(context)
      ]);
      return [...aave, ...curve, ...uniswap];
    }

    default: {
      // Multi-chain: 기존 동작 유지
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
  requestedMode?: ExecutionMode,
  protocolReadiness?: ProtocolExecutionReadiness[]
): Promise<ExecutionAdapterBundle> {
  const mode = getExecutionMode(requestedMode);
  ensureSafeLiveMode(mode);

  const context: AdapterExecutionContext = {
    jobId: job.id,
    mode,
    depositUsd: job.input.depositUsd,
    timestamp: new Date().toISOString(),
    productNetwork: job.input.productNetwork,
    productSubtype: job.input.productSubtype,
    protocolReadiness
  };

  const adapterResults = await runAdaptersByNetwork(context);
  const { results, skippedProtocols } = filterLiveResults(adapterResults, mode, context.protocolReadiness);
  const txId = results.map((item) => item.txId).join(",");
  const summary = `${buildSummary(results, mode)}${mode === "live" && skippedProtocols.length > 0 ? ` | skipped=${skippedProtocols.length}` : ""}`;
  return { txId, summary, mode, adapterResults: results, skippedProtocols };
}
