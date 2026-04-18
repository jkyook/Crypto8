import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";

function buildTxId(prefix: string, context: AdapterExecutionContext): string {
  return `${prefix}_${context.jobId}_${Date.now()}`;
}

export async function executeOrcaPlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const amount = Number((context.depositUsd * 0.2).toFixed(2));
  const status = context.mode === "live" ? "submitted" : "simulated";
  const txPrefix = context.mode === "live" ? "orca_live" : "orca_sim";

  return [
    {
      protocol: "Orca",
      chain: "Solana",
      action: "USDC-USDT Whirlpool",
      allocationUsd: amount,
      txId: buildTxId(txPrefix, context),
      status
    }
  ];
}
