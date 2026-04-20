import type { UserRole } from "./auth";
import { getMarketPriceSnapshot, type PriceSymbol } from "./marketPricing";
import { listUserWallets } from "./userWallets";
import { PublicKey } from "@solana/web3.js";
import { createPublicClient, formatUnits, http, isAddress, type Address, type Chain } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";

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

type WalletAssetLookup = {
  source: "solana" | "evm";
  rows: AccountAssetBalance[];
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

const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  }
] as const;

type EvmChainKey = "Ethereum" | "Arbitrum" | "Base";

const EVM_CHAINS: Record<
  EvmChainKey,
  {
    chain: Chain;
    envKeys: string[];
    fallbackRpcUrls: string[];
    tokens: Partial<Record<Exclude<AccountAssetSymbol, "ETH" | "SOL">, { address: Address; decimals: number }>>;
  }
> = {
  Ethereum: {
    chain: mainnet,
    envKeys: ["ETHEREUM_RPC_URL", "MAINNET_RPC_URL"],
    fallbackRpcUrls: ["https://ethereum-rpc.publicnode.com", "https://rpc.ankr.com/eth", "https://cloudflare-eth.com"],
    tokens: {
      USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
      USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 }
    }
  },
  Arbitrum: {
    chain: arbitrum,
    envKeys: ["ARBITRUM_RPC_URL"],
    fallbackRpcUrls: ["https://arbitrum-one-rpc.publicnode.com", "https://rpc.ankr.com/arbitrum"],
    tokens: {
      USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
      USDT: { address: "0xFd086bC7CD5C481DCC9C85ebe478A1C0b69FCbb9", decimals: 6 }
    }
  },
  Base: {
    chain: base,
    envKeys: ["BASE_RPC_URL"],
    fallbackRpcUrls: ["https://base-rpc.publicnode.com", "https://rpc.ankr.com/base"],
    tokens: {
      USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
      USDT: { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 }
    }
  }
};

function getSolanaRpcCandidates(): string[] {
  const raw = process.env.SOLANA_RPC_URL?.trim() || process.env.VITE_SOLANA_RPC_URL?.trim() || "";
  const custom = raw ? [raw] : [];
  const defaults = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com", "https://rpc.ankr.com/solana"];
  return [...custom, ...defaults.filter((url) => !custom.includes(url))];
}

function getEvmRpcCandidates(chainKey: EvmChainKey): string[] {
  const config = EVM_CHAINS[chainKey];
  const envUrls = config.envKeys.map((key) => process.env[key]?.trim()).filter((url): url is string => Boolean(url));
  return [...envUrls, ...config.fallbackRpcUrls.filter((url) => !envUrls.includes(url))];
}

type RpcJson = { result?: unknown; error?: { message?: string } };

function assertSolanaWalletAddress(walletAddress: string): string {
  const address = walletAddress.trim();
  try {
    new PublicKey(address);
    return address;
  } catch {
    throw new Error("wallet address invalid");
  }
}

function assertEvmWalletAddress(walletAddress: string): Address {
  const address = walletAddress.trim();
  if (!isAddress(address)) {
    throw new Error("evm wallet address invalid");
  }
  return address;
}

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

async function fetchEvmChainAssets(
  chainKey: EvmChainKey,
  walletAddress: Address,
  priceSnapshot: Awaited<ReturnType<typeof getMarketPriceSnapshot>>
): Promise<AccountAssetBalance[]> {
  let lastError = "";
  const config = EVM_CHAINS[chainKey];
  for (const rpcUrl of getEvmRpcCandidates(chainKey)) {
    try {
      const client = createPublicClient({ chain: config.chain, transport: http(rpcUrl, { timeout: 8000 }) });
      const [nativeBalance, ...tokenBalances] = await Promise.all([
        client.getBalance({ address: walletAddress }),
        ...Object.entries(config.tokens).map(async ([symbol, token]) => ({
          symbol: symbol as AccountAssetSymbol,
          amount: await client.readContract({
            address: token.address,
            abi: erc20BalanceAbi,
            functionName: "balanceOf",
            args: [walletAddress]
          }),
          decimals: token.decimals
        }))
      ]);
      const rows: AccountAssetBalance[] = [];
      const ethAmount = Number(formatUnits(nativeBalance, 18));
      if (Number.isFinite(ethAmount) && ethAmount > 0) {
        rows.push({
          symbol: "ETH",
          chain: chainKey,
          amount: ethAmount,
          usdPrice: priceSnapshot.prices.ETH,
          usdValue: Number((ethAmount * priceSnapshot.prices.ETH).toFixed(2)),
          priceSource: priceSnapshot.source,
          priceUpdatedAt: priceSnapshot.updatedAt
        });
      }
      for (const token of tokenBalances) {
        const amount = Number(formatUnits(token.amount, token.decimals));
        if (!Number.isFinite(amount) || amount <= 0) {
          continue;
        }
        rows.push({
          symbol: token.symbol,
          chain: chainKey,
          amount,
          usdPrice: priceSnapshot.prices[token.symbol],
          usdValue: Number((amount * priceSnapshot.prices[token.symbol]).toFixed(2)),
          priceSource: priceSnapshot.source,
          priceUpdatedAt: priceSnapshot.updatedAt
        });
      }
      return rows;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError || `${chainKey} wallet balance fetch failed`);
}

async function fetchEvmWalletAssets(
  walletAddress: string,
  priceSnapshot: Awaited<ReturnType<typeof getMarketPriceSnapshot>>
): Promise<AccountAssetBalance[]> {
  const address = assertEvmWalletAddress(walletAddress);
  const results = await Promise.allSettled(
    (Object.keys(EVM_CHAINS) as EvmChainKey[]).map((chainKey) => fetchEvmChainAssets(chainKey, address, priceSnapshot))
  );
  const rows = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  if (rows.length === 0 && results.every((result) => result.status === "rejected")) {
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
    throw firstError instanceof Error ? firstError : new Error("EVM wallet balance fetch failed");
  }
  return rows;
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
  const linkedWallets = await listUserWallets(username);
  if (linkedWallets.length > 0) {
    const results = await Promise.allSettled(
      linkedWallets.map(async (wallet): Promise<WalletAssetLookup> => {
        const chain = wallet.chain.toLowerCase();
        if (chain === "solana") {
          const amounts = await fetchSolanaWalletAmounts(assertSolanaWalletAddress(wallet.walletAddress));
          return { source: "solana", rows: amountsToAssetBalances(amounts, priceSnapshot) };
        }
        if (chain === "ethereum" || chain === "evm") {
          return { source: "evm", rows: await fetchEvmWalletAssets(wallet.walletAddress, priceSnapshot) };
        }
        return { source: "solana", rows: [] };
      })
    );
    const rows = results.flatMap((result) => (result.status === "fulfilled" ? result.value.rows : []));
    const hasLinkedEvmWallet = linkedWallets.some((wallet) => {
      const chain = wallet.chain.toLowerCase();
      return chain === "ethereum" || chain === "evm";
    });
    const hasFulfilledEvm = results.some((result) => result.status === "fulfilled" && result.value.source === "evm");
    if (rows.length === 0 && hasLinkedEvmWallet && !hasFulfilledEvm) {
      const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
      throw firstError instanceof Error ? firstError : new Error("EVM wallet balance fetch failed");
    }
    if (rows.length > 0 || results.some((result) => result.status === "fulfilled")) {
      return rows;
    }
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
    throw firstError instanceof Error ? firstError : new Error("linked wallet balance fetch failed");
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

export async function listWalletAssets(walletAddress: string, evmAddress?: string): Promise<AccountAssetBalance[]> {
  const priceSnapshot = await getMarketPriceSnapshot();
  const tasks: Array<Promise<WalletAssetLookup>> = [];
  if (walletAddress.trim()) {
    const address = assertSolanaWalletAddress(walletAddress);
    tasks.push(fetchSolanaWalletAmounts(address).then((amounts) => ({ source: "solana", rows: amountsToAssetBalances(amounts, priceSnapshot) })));
  }
  if (evmAddress?.trim()) {
    tasks.push(fetchEvmWalletAssets(evmAddress, priceSnapshot).then((rows) => ({ source: "evm", rows })));
  }
  if (tasks.length === 0) {
    throw new Error("walletAddress required");
  }
  const results = await Promise.allSettled(tasks);
  const rows = results.flatMap((result) => (result.status === "fulfilled" ? result.value.rows : []));
  const hasEvmAddress = Boolean(evmAddress?.trim());
  const hasFulfilledEvm = results.some((result) => result.status === "fulfilled" && result.value.source === "evm");
  const hasRejectedEvm = hasEvmAddress && !hasFulfilledEvm;
  if (rows.length === 0 && hasRejectedEvm) {
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
    throw firstError instanceof Error ? firstError : new Error("EVM wallet balance fetch failed");
  }
  if (rows.length === 0 && results.every((result) => result.status === "rejected")) {
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
    throw firstError instanceof Error ? firstError : new Error("wallet asset lookup failed");
  }
  return rows;
}
