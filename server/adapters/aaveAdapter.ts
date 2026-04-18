import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";

function buildTxId(prefix: string, context: AdapterExecutionContext): string {
  return `${prefix}_${context.jobId}_${Date.now()}`;
}

export async function executeAavePlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const arbAmount = Number((context.depositUsd * 0.2).toFixed(2));
  const baseAmount = Number((context.depositUsd * 0.15).toFixed(2));
  const status = context.mode === "live" ? "submitted" : "simulated";
  const txPrefix = context.mode === "live" ? "aave_live" : "aave_sim";

  return [
    {
      protocol: "Aave",
      chain: "Arbitrum",
      action: "USDC Supply",
      allocationUsd: arbAmount,
      txId: buildTxId(txPrefix, context),
      status
    },
    {
      protocol: "Aave",
      chain: "Base",
      action: "USDC Supply",
      allocationUsd: baseAmount,
      txId: buildTxId(txPrefix, context),
      status
    }
  ];
}
