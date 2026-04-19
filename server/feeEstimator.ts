import { getMarketPriceSnapshot } from "./marketPricing";

export type FeeEstimateInputRow = {
  protocol: string;
  chain: string;
  action: string;
  allocationUsd: number;
};

export type FeeEstimateRow = FeeEstimateInputRow & {
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

export type FeeEstimateResponse = {
  rows: FeeEstimateRow[];
  totalFeeUsd: number;
  priceSource: string;
  updatedAt: string;
};

async function fetchJsonRpcNumber(rpcUrl: string, method: string): Promise<number | null> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
      signal: AbortSignal.timeout(3500)
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { result?: string | number };
    if (typeof data.result === "string") return Number(BigInt(data.result));
    if (typeof data.result === "number") return data.result;
  } catch {
    return null;
  }
  return null;
}

async function estimateEvmGasPriceGwei(chain: string): Promise<{ gwei: number; confidence: "medium" | "low" }> {
  const envKey = chain.toLowerCase().includes("base") ? "BASE_RPC_URL" : "ARBITRUM_RPC_URL";
  const fallback = chain.toLowerCase().includes("base") ? 0.025 : 0.02;
  const rpcUrl = process.env[envKey];
  if (!rpcUrl) return { gwei: fallback, confidence: "low" };
  const wei = await fetchJsonRpcNumber(rpcUrl, "eth_gasPrice");
  if (!wei || !Number.isFinite(wei) || wei <= 0) return { gwei: fallback, confidence: "low" };
  return { gwei: wei / 1_000_000_000, confidence: "medium" };
}

function estimateGasUnits(row: FeeEstimateInputRow): number {
  const key = `${row.protocol} ${row.action}`.toLowerCase();
  if (key.includes("aave")) return 180_000;
  if (key.includes("eth-usdc")) return 560_000;
  if (key.includes("usdc-usdt")) return 430_000;
  if (key.includes("direct deposit")) return 240_000;
  return 320_000;
}

function estimateSwapFeeUsd(row: FeeEstimateInputRow): number {
  const key = row.action.toLowerCase();
  if (key.includes("usdc-usdt")) return row.allocationUsd * 0.0005;
  if (key.includes("eth-usdc")) return row.allocationUsd * 0.003;
  if (key.includes("sol-usdc")) return row.allocationUsd * 0.003;
  return 0;
}

function estimateBridgeFeeUsd(row: FeeEstimateInputRow): number {
  const key = `${row.chain} ${row.action}`.toLowerCase();
  if (key.includes("solana") || key.includes("base")) {
    return Math.max(0.25, row.allocationUsd * 0.0002);
  }
  return 0;
}

export async function estimateProtocolFees(rows: FeeEstimateInputRow[]): Promise<FeeEstimateResponse> {
  const prices = await getMarketPriceSnapshot();
  const out: FeeEstimateRow[] = [];
  for (const row of rows) {
    const chainKey = row.chain.toLowerCase();
    if (chainKey.includes("solana") || row.protocol.toLowerCase().includes("orca")) {
      const networkFeeUsd = Number((0.000025 * prices.prices.SOL).toFixed(4));
      const swapFeeUsd = estimateSwapFeeUsd(row);
      const bridgeFeeUsd = estimateBridgeFeeUsd(row);
      out.push({
        ...row,
        nativeAsset: "SOL",
        gasUnits: 2,
        networkFeeUsd,
        swapFeeUsd,
        bridgeFeeUsd,
        estimatedFeeUsd: Number((networkFeeUsd + swapFeeUsd + bridgeFeeUsd).toFixed(4)),
        confidence: "low",
        note: "Solana 기본 수수료+우선순위 수수료 fallback, Whirlpool 스왑 수수료 포함"
      });
      continue;
    }
    const gasUnits = estimateGasUnits(row);
    const gas = await estimateEvmGasPriceGwei(row.chain);
    const networkFeeUsd = Number((((gasUnits * gas.gwei) / 1_000_000_000) * prices.prices.ETH).toFixed(4));
    const swapFeeUsd = estimateSwapFeeUsd(row);
    const bridgeFeeUsd = estimateBridgeFeeUsd(row);
    out.push({
      ...row,
      nativeAsset: "ETH",
      gasUnits,
      gasPriceGwei: Number(gas.gwei.toFixed(6)),
      networkFeeUsd,
      swapFeeUsd,
      bridgeFeeUsd,
      estimatedFeeUsd: Number((networkFeeUsd + swapFeeUsd + bridgeFeeUsd).toFixed(4)),
      confidence: gas.confidence,
      note: `${row.chain} RPC gasPrice ${gas.confidence === "medium" ? "조회" : "fallback"} + 풀별 예상 트랜잭션 수`
    });
  }
  return {
    rows: out,
    totalFeeUsd: Number(out.reduce((acc, row) => acc + row.estimatedFeeUsd, 0).toFixed(4)),
    priceSource: prices.source,
    updatedAt: prices.updatedAt
  };
}
