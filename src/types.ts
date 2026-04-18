export type Allocation = {
  key: string;
  label: string;
  protocol: string;
  chain: string;
  targetWeight: number;
  expectedApr: number;
};

export type PortfolioPlan = {
  totalDepositUsd: number;
  items: Array<Allocation & { allocationUsd: number; expectedYieldUsd: number }>;
  expectedAnnualYieldUsd: number;
};

export type RiskLevel = "Low" | "Medium" | "High" | "Critical";

export type AgentTask = {
  agent: "Strategy-PM" | "Yield-Operator" | "Protocol-Engineer" | "Security-Guardian" | "Growth-Marketer";
  priority: "P0" | "P1" | "P2" | "P3";
  objective: string;
  doneDefinition: string;
};
