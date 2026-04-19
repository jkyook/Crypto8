import type { UserRole } from "./auth";
import { getMarketPriceSnapshot, type PriceSymbol } from "./marketPricing";

export type AccountAssetSymbol = PriceSymbol;

export type AccountAssetBalance = {
  symbol: AccountAssetSymbol;
  chain: string;
  amount: number;
  usdPrice: number;
  usdValue: number;
  priceSource: string;
  priceUpdatedAt: string;
};

const DEMO_BALANCES: Record<string, Array<Pick<AccountAssetBalance, "symbol" | "chain" | "amount">>> = {
  orchestrator_admin: [
    { symbol: "USDC", chain: "Arbitrum", amount: 250000 },
    { symbol: "USDT", chain: "Arbitrum", amount: 80000 },
    { symbol: "ETH", chain: "Arbitrum", amount: 18 },
    { symbol: "SOL", chain: "Solana", amount: 420 }
  ],
  security_admin: [
    { symbol: "USDC", chain: "Arbitrum", amount: 35000 },
    { symbol: "USDT", chain: "Arbitrum", amount: 12000 },
    { symbol: "ETH", chain: "Arbitrum", amount: 3 },
    { symbol: "SOL", chain: "Solana", amount: 80 }
  ],
  viewer_admin: [
    { symbol: "USDC", chain: "Arbitrum", amount: 12000 },
    { symbol: "USDT", chain: "Arbitrum", amount: 4000 },
    { symbol: "ETH", chain: "Arbitrum", amount: 1.5 },
    { symbol: "SOL", chain: "Solana", amount: 35 }
  ]
};

function defaultBalancesForRole(role: UserRole): Array<Pick<AccountAssetBalance, "symbol" | "chain" | "amount">> {
  const usdc = role === "orchestrator" ? 50000 : role === "security" ? 25000 : 10000;
  return [
    { symbol: "USDC", chain: "Arbitrum", amount: usdc },
    { symbol: "USDT", chain: "Arbitrum", amount: Math.round(usdc * 0.25) },
    { symbol: "ETH", chain: "Arbitrum", amount: Number((usdc / 20000).toFixed(4)) },
    { symbol: "SOL", chain: "Solana", amount: Number((usdc / 500).toFixed(4)) }
  ];
}

export async function listAccountAssets(username: string, role: UserRole): Promise<AccountAssetBalance[]> {
  const rows = DEMO_BALANCES[username] ?? defaultBalancesForRole(role);
  const priceSnapshot = await getMarketPriceSnapshot();
  return rows.map((row) => ({
    ...row,
    usdPrice: priceSnapshot.prices[row.symbol],
    usdValue: Number((row.amount * priceSnapshot.prices[row.symbol]).toFixed(2)),
    priceSource: priceSnapshot.source,
    priceUpdatedAt: priceSnapshot.updatedAt
  }));
}
