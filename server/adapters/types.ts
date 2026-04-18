export type ExecutionMode = "dry-run" | "live";

export type AdapterExecutionContext = {
  jobId: string;
  mode: ExecutionMode;
  depositUsd: number;
  timestamp: string;
};

export type AdapterExecutionResult = {
  protocol: "Aave" | "Uniswap" | "Orca";
  chain: "Arbitrum" | "Base" | "Solana";
  action: string;
  allocationUsd: number;
  txId: string;
  status: "simulated" | "submitted";
};
