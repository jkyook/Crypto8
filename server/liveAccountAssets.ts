import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import type { Address } from "viem";
import type { AccountAssetBalance, AccountAssetSymbol } from "./accountAssets";
import { getMarketPriceSnapshot } from "./marketPricing";

type SolanaNetwork = "mainnet" | "devnet";
type EvmChainName = "Ethereum" | "Arbitrum" | "Base";

const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJNbNbGKPFXCWuBvf9Ss623VQ5DA";

const SOLANA_MINT_SYMBOLS: Record<SolanaNetwork, Record<string, string>> = {
  mainnet: {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
    So11111111111111111111111111111111111111112: "SOL(Wrapped)",
    mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL"
  },
  devnet: {}
};

const EVM_CONFIG: Record<
  EvmChainName,
  {
    chain: typeof mainnet;
    envKeys: string[];
    usdcAddress: Address;
    defaults: string[];
  }
> = {
  Ethereum: {
    chain: mainnet,
    envKeys: ["ETHEREUM_RPC_URL", "VITE_ETHEREUM_RPC_URL"],
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    defaults: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"]
  },
  Arbitrum: {
    chain: arbitrum,
    envKeys: ["ARBITRUM_RPC_URL", "VITE_ARBITRUM_RPC_URL"],
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    defaults: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"]
  },
  Base: {
    chain: base,
    envKeys: ["BASE_RPC_URL", "VITE_BASE_RPC_URL"],
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    defaults: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"]
  }
};

function getEnv(key: string): string {
  const value = process.env[key];
  return typeof value === "string" ? value.trim() : "";
}

function getRpcCandidatesForSolana(network: SolanaNetwork): string[] {
  const defaults =
    network === "mainnet"
      ? [
          "https://solana-mainnet.g.alchemy.com/v2/docs-demo",
          "https://docs-demo.solana-mainnet.quiknode.pro/",
          "https://api.mainnet.solana.com",
          "https://solana-rpc.publicnode.com",
          "https://rpc.ankr.com/solana"
        ]
      : ["https://api.devnet.solana.com", "https://solana-devnet.publicnode.com"];
  if (network === "mainnet") {
    const mainnetCustom = [getEnv("SOLANA_MAINNET_RPC_URL"), getEnv("VITE_SOLANA_MAINNET_RPC_URL")].filter((item) => item.length > 0);
    return [...mainnetCustom, ...defaults.filter((url) => !mainnetCustom.includes(url))];
  }
  const devnetCustom = [getEnv("SOLANA_RPC_URL"), getEnv("VITE_SOLANA_RPC_URL")].filter((item) => item.length > 0);
  return [...devnetCustom, ...defaults.filter((url) => !devnetCustom.includes(url))];
}

function getRpcCandidatesForEvm(chainName: EvmChainName): string[] {
  const config = EVM_CONFIG[chainName];
  const custom = config.envKeys.map((key) => getEnv(key)).filter((item) => item.length > 0);
  return [...custom, ...config.defaults.filter((url) => !custom.includes(url))];
}

function symbolForMint(mint: string, network: SolanaNetwork): string {
  return SOLANA_MINT_SYMBOLS[network][mint] ?? `Mint ${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function parseSolanaTokenAccounts(json: unknown, network: SolanaNetwork): Array<{ mint: string; symbol: string; amount: number; decimals: number }> {
  const result = json as
    | {
        value?: Array<{
          account?: {
            data?: {
              parsed?: {
                info?: {
                  mint?: string;
                  tokenAmount?: { amount?: string; uiAmount?: number | null; decimals?: number };
                };
              };
            };
          };
        }>;
      }
    | undefined;
  const rows = result?.value ?? [];
  return rows
    .flatMap((row) => {
      const info = row.account?.data?.parsed?.info;
      const mint = info?.mint;
      const tokenAmount = info?.tokenAmount;
      if (!mint || !tokenAmount) return [];
      const decimals = typeof tokenAmount.decimals === "number" ? tokenAmount.decimals : Number(tokenAmount.decimals ?? 0);
      const amount =
        typeof tokenAmount.amount === "string" && tokenAmount.amount.length > 0
          ? Number(tokenAmount.amount) / Math.pow(10, Number.isFinite(decimals) ? decimals : 0)
          : typeof tokenAmount.uiAmount === "number"
            ? tokenAmount.uiAmount
            : Number(tokenAmount.uiAmount ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) return [];
      return [{ mint, symbol: symbolForMint(mint, network), amount, decimals: Number.isFinite(decimals) ? decimals : 0 }];
    })
    .sort((a, b) => b.amount - a.amount);
}

async function fetchSolanaPortfolio(
  network: SolanaNetwork,
  owner: string,
  snapshot: Awaited<ReturnType<typeof getMarketPriceSnapshot>>
): Promise<AccountAssetBalance[]> {
  const candidates = getRpcCandidatesForSolana(network);
  let lastError = "";
  for (const rpcUrl of candidates) {
    try {
      const [balRes, tokRes] = await Promise.all([
        fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [owner] })
        }),
        fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "getTokenAccountsByOwner",
            params: [owner, { programId: SPL_TOKEN_PROGRAM_ID }, { encoding: "jsonParsed" }]
          })
        })
      ]);
      if (!balRes.ok || !tokRes.ok) {
        const bad = !balRes.ok ? balRes : tokRes;
        const text = await bad.text().catch(() => "");
        throw new Error(text.includes("Access forbidden") || bad.status === 403 ? "RPC Access forbidden (403)" : `HTTP ${bad.status}`);
      }
      const balJson = await balRes.json();
      const tokJson = await tokRes.json();
      const lamports = ((balJson as { result?: { value?: number } }).result?.value ?? 0) as number;
      const tokens = parseSolanaTokenAccounts(tokJson, network);
      const priceSource = snapshot.source;
      const priceUpdatedAt = snapshot.updatedAt;
      const rows: AccountAssetBalance[] = [
        {
          symbol: "SOL",
          chain: "Solana",
          amount: lamports / 1_000_000_000,
          usdPrice: snapshot.prices.SOL ?? 0,
          usdValue: Number(((lamports / 1_000_000_000) * (snapshot.prices.SOL ?? 0)).toFixed(2)),
          priceSource,
          priceUpdatedAt
        }
      ];
      for (const token of tokens) {
        if (token.symbol.includes("USDC")) {
          rows.push({
            symbol: "USDC",
            chain: "Solana",
            amount: token.amount,
            usdPrice: snapshot.prices.USDC ?? 0,
            usdValue: Number((token.amount * (snapshot.prices.USDC ?? 0)).toFixed(2)),
            priceSource,
            priceUpdatedAt
          });
        } else if (token.symbol.includes("USDT")) {
          rows.push({
            symbol: "USDT",
            chain: "Solana",
            amount: token.amount,
            usdPrice: snapshot.prices.USDT ?? 0,
            usdValue: Number((token.amount * (snapshot.prices.USDT ?? 0)).toFixed(2)),
            priceSource,
            priceUpdatedAt
          });
        } else if (token.symbol.includes("SOL")) {
          rows.push({
            symbol: "SOL",
            chain: "Solana",
            amount: token.amount,
            usdPrice: snapshot.prices.SOL ?? 0,
            usdValue: Number((token.amount * (snapshot.prices.SOL ?? 0)).toFixed(2)),
            priceSource,
            priceUpdatedAt
          });
        }
      }
      return rows.filter((row) => row.amount > 0);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError || "Solana 잔고 조회 실패");
}

async function fetchEvmPortfolio(
  chainName: EvmChainName,
  owner: Address,
  snapshot: Awaited<ReturnType<typeof getMarketPriceSnapshot>>
): Promise<AccountAssetBalance[]> {
  const config = EVM_CONFIG[chainName];
  const candidates = getRpcCandidatesForEvm(chainName);
  let lastError = "";
  for (const rpcUrl of candidates) {
    try {
      const client = createPublicClient({ chain: config.chain, transport: http(rpcUrl, { batch: true }) });
      const [nativeBalance, usdcBalance] = await Promise.all([
        client.getBalance({ address: owner }),
        client.readContract({
          address: config.usdcAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner]
        })
      ]);
      const rows: AccountAssetBalance[] = [];
      const eth = Number(formatUnits(nativeBalance, 18));
      if (eth > 0) {
        rows.push({
          symbol: "ETH",
          chain: chainName,
          amount: eth,
          usdPrice: snapshot.prices.ETH ?? 0,
          usdValue: Number((eth * (snapshot.prices.ETH ?? 0)).toFixed(2)),
          priceSource: snapshot.source,
          priceUpdatedAt: snapshot.updatedAt
        });
      }
      const usdc = Number(formatUnits(usdcBalance, 6));
      if (usdc > 0) {
        rows.push({
          symbol: "USDC",
          chain: chainName,
          amount: usdc,
          usdPrice: snapshot.prices.USDC ?? 0,
          usdValue: Number((usdc * (snapshot.prices.USDC ?? 0)).toFixed(2)),
          priceSource: snapshot.source,
          priceUpdatedAt: snapshot.updatedAt
        });
      }
      return rows;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError || `${chainName} 잔고 조회 실패`);
}

export async function listLiveAccountAssets(params: {
  network: SolanaNetwork;
  solanaAddress?: string | null;
  evmAddress?: string | null;
}): Promise<AccountAssetBalance[]> {
  const snapshot = await getMarketPriceSnapshot();
  const assets: AccountAssetBalance[] = [];
  const solanaResult = params.solanaAddress ? await fetchSolanaPortfolio(params.network, params.solanaAddress, snapshot).catch((error) => error) : null;
  if (Array.isArray(solanaResult)) {
    assets.push(...solanaResult);
  }
  if (params.evmAddress) {
    const settled = await Promise.allSettled(
      (["Ethereum", "Arbitrum", "Base"] as const).map((chainName) => fetchEvmPortfolio(chainName, params.evmAddress!, snapshot))
    );
    settled.forEach((result) => {
      if (result.status === "fulfilled") {
        assets.push(...result.value);
      }
    });
  }
  return assets;
}
