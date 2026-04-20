import type { UserRole } from "./auth";
import { getMarketPriceSnapshot, type PriceSymbol } from "./marketPricing";
import { listUserWallets } from "./userWallets";

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

const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const KNOWN_SOLANA_MINT_SYMBOL: Record<string, AccountAssetSymbol> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  So11111111111111111111111111111111111111112: "SOL",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKjW2GMHSUq": "ETH"
};

function getSolanaRpcCandidates(): string[] {
  const raw = process.env.SOLANA_RPC_URL?.trim() || process.env.VITE_SOLANA_RPC_URL?.trim() || "";
  const custom = raw ? [raw] : [];
  const defaults = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com", "https://rpc.ankr.com/solana"];
  return [...custom, ...defaults.filter((url) => !custom.includes(url))];
}

type RpcJson = { result?: unknown; error?: { message?: string } };

async function fetchSolanaWalletAmounts(walletAddress: string): Promise<Partial<Record<AccountAssetSymbol, number>>> {
  let lastError = "";
  for (const rpcUrl of getSolanaRpcCandidates()) {
    try {
      const [balanceRes, tokenRes] = await Promise.all([
        fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getBalance",
            params: [walletAddress]
          })
        }),
        fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "getTokenAccountsByOwner",
            params: [walletAddress, { programId: SPL_TOKEN_PROGRAM_ID }, { encoding: "jsonParsed" }]
          })
        })
      ]);
      if (!balanceRes.ok || !tokenRes.ok) {
        throw new Error(`Solana RPC HTTP ${!balanceRes.ok ? balanceRes.status : tokenRes.status}`);
      }

      const balanceJson = (await balanceRes.json()) as RpcJson;
      if (balanceJson.error?.message) {
        throw new Error(balanceJson.error.message);
      }
      const tokenJson = (await tokenRes.json()) as RpcJson;
      if (tokenJson.error?.message) {
        throw new Error(tokenJson.error.message);
      }

      const amounts: Partial<Record<AccountAssetSymbol, number>> = {
        SOL: ((balanceJson.result as { value?: number } | undefined)?.value ?? 0) / 1_000_000_000
      };
      const tokenRows =
        (tokenJson.result as
          | {
              value?: Array<{
                account?: { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number | null } } } } };
              }>;
            }
          | undefined)?.value ?? [];
      for (const row of tokenRows) {
        const info = row.account?.data?.parsed?.info;
        const symbol = info?.mint ? KNOWN_SOLANA_MINT_SYMBOL[info.mint] : undefined;
        const amount = info?.tokenAmount?.uiAmount;
        if (!symbol || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
          continue;
        }
        amounts[symbol] = (amounts[symbol] ?? 0) + amount;
      }
      return amounts;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError || "Solana wallet balance fetch failed");
}

function amountsToAssetBalances(
  amounts: Partial<Record<AccountAssetSymbol, number>>,
  priceSnapshot: Awaited<ReturnType<typeof getMarketPriceSnapshot>>
): AccountAssetBalance[] {
  const order: AccountAssetSymbol[] = ["USDC", "USDT", "ETH", "SOL"];
  return order
    .map((symbol) => {
      const amount = amounts[symbol] ?? 0;
      return {
        symbol,
        chain: "Solana",
        amount,
        usdPrice: priceSnapshot.prices[symbol],
        usdValue: Number((amount * priceSnapshot.prices[symbol]).toFixed(2)),
        priceSource: priceSnapshot.source,
        priceUpdatedAt: priceSnapshot.updatedAt
      };
    })
    .filter((asset) => asset.amount > 0);
}

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
  const priceSnapshot = await getMarketPriceSnapshot();
  const linkedWallet = (await listUserWallets(username)).find((wallet) => wallet.chain.toLowerCase() === "solana");
  if (linkedWallet) {
    try {
      const amounts = await fetchSolanaWalletAmounts(linkedWallet.walletAddress);
      return amountsToAssetBalances(amounts, priceSnapshot);
    } catch (error) {
      if (username.startsWith("wallet_")) {
        throw error;
      }
    }
  }

  const rows = DEMO_BALANCES[username] ?? defaultBalancesForRole(role);
  return rows.map((row) => ({
    ...row,
    usdPrice: priceSnapshot.prices[row.symbol],
    usdValue: Number((row.amount * priceSnapshot.prices[row.symbol]).toFixed(2)),
    priceSource: priceSnapshot.source,
    priceUpdatedAt: priceSnapshot.updatedAt
  }));
}
