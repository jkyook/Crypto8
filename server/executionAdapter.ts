import type { ExecutionJob } from "./types";
import { executeAavePlan } from "./adapters/aaveAdapter";
import { executeOrcaPlan } from "./adapters/orcaAdapter";
import type { AdapterExecutionContext, AdapterExecutionResult, ExecutionMode } from "./adapters/types";
import { executeUniswapPlan } from "./adapters/uniswapAdapter";

export type ExecutionAdapterBundle = {
  txId: string;
  summary: string;
  mode: ExecutionMode;
  adapterResults: AdapterExecutionResult[];
};

/** 런타임 정보 API와 동일한 기준의 “실효” 실행 모드(라이브는 확인 플래그까지 필요). */
export function getEffectiveExecutionMode(): ExecutionMode {
  const requested = process.env.EXECUTION_MODE === "live" ? "live" : "dry-run";
  if (requested === "live" && process.env.LIVE_EXECUTION_CONFIRM === "YES") {
    return "live";
  }
  return "dry-run";
}

function getExecutionMode(): ExecutionMode {
  const envMode = process.env.EXECUTION_MODE;
  if (envMode === "live") {
    return "live";
  }
  return "dry-run";
}

function ensureSafeLiveMode(mode: ExecutionMode): void {
  if (mode !== "live") {
    return;
  }
  // 실제 체결 모드는 명시적인 플래그가 있어야 켜진다.
  if (process.env.LIVE_EXECUTION_CONFIRM !== "YES") {
    throw new Error("live mode requires LIVE_EXECUTION_CONFIRM=YES");
  }
}

function buildSummary(results: AdapterExecutionResult[], mode: ExecutionMode): string {
  const total = results.reduce((acc, item) => acc + item.allocationUsd, 0);
  const lines = results.map((item) => `${item.protocol}/${item.chain}:${item.allocationUsd.toFixed(2)}`);
  return `${mode.toUpperCase()} execution total=$${total.toFixed(2)} | ${lines.join(", ")}`;
}

export async function runExecutionAdapter(job: ExecutionJob): Promise<ExecutionAdapterBundle> {
  const mode = getExecutionMode();
  ensureSafeLiveMode(mode);

  const context: AdapterExecutionContext = {
    jobId: job.id,
    mode,
    depositUsd: job.input.depositUsd,
    timestamp: new Date().toISOString()
  };

  const [aave, uniswap, orca] = await Promise.all([
    executeAavePlan(context),
    executeUniswapPlan(context),
    executeOrcaPlan(context)
  ]);
  const adapterResults = [...aave, ...uniswap, ...orca];
  const txId = adapterResults.map((item) => item.txId).join(",");
  const summary = buildSummary(adapterResults, mode);
  return { txId, summary, mode, adapterResults };
}
