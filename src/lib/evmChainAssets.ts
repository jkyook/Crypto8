import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import type { Address } from "viem";
import type { Chain } from "viem/chains";
import type { AccountAssetBalance, AccountAssetSymbol } from "./api";

export type EvmChainName = "Ethereum" | "Arbitrum" | "Base";

type EvmChainConfig = {
  name: EvmChainName;
  chain: Chain;
  rpcEnvKey: string;
  usdcAddress: Address;
  rpcDefaults: string[];
};

const EVM_CHAIN_CONFIGS: Record<EvmChainName, EvmChainConfig> = {
  Ethereum: {
    name: "Ethereum",
    chain: mainnet,
    rpcEnvKey: "VITE_ETHEREUM_RPC_URL",
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    rpcDefaults: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"]
  },
  Arbitrum: {
    name: "Arbitrum",
    chain: arbitrum,
    rpcEnvKey: "VITE_ARBITRUM_RPC_URL",
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    rpcDefaults: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"]
  },
  Base: {
    name: "Base",
    chain: base,
    rpcEnvKey: "VITE_BASE_RPC_URL",
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpcDefaults: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"]
  }
};

function getEnvRpcUrl(envKey: string): string {
  if (typeof import.meta === "undefined" || !import.meta.env) return "";
  const value = (import.meta.env as Record<string, string | undefined>)[envKey];
  return typeof value === "string" ? value.trim() : "";
}

export function getEvmRpcCandidates(chainName: EvmChainName): string[] {
  const config = EVM_CHAIN_CONFIGS[chainName];
  const custom = getEnvRpcUrl(config.rpcEnvKey);
  const seeded = custom ? [custom] : [];
  return [...seeded, ...config.rpcDefaults.filter((url) => !seeded.includes(url))];
}

function toAssetRow(
  symbol: AccountAssetSymbol,
  chain: EvmChainName,
  amount: number,
  usdPrice: number,
  priceSource: string,
  priceUpdatedAt: string
): AccountAssetBalance {
  return {
    symbol,
    chain,
    amount,
    usdPrice,
    usdValue: Number((amount * usdPrice).toFixed(2)),
    priceSource,
    priceUpdatedAt
  };
}

async function fetchEvmPortfolioOnce(
  rpcUrl: string,
  owner: Address,
  chainName: EvmChainName,
  prices: Partial<Record<AccountAssetSymbol, number>>,
  priceSource: string,
  priceUpdatedAt: string
): Promise<AccountAssetBalance[]> {
  const config = EVM_CHAIN_CONFIGS[chainName];
  const client = createPublicClient({
    chain: config.chain,
    transport: http(rpcUrl, { batch: true })
  });
  const [nativeBalance, usdcBalance] = await Promise.all([
    client.getBalance({ address: owner }),
    client.readContract({
      address: config.usdcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner]
    })
  ]);
  const rows: AccountAssetBalance[] = [
    toAssetRow(
      "ETH",
      chainName,
      Number(formatUnits(nativeBalance, 18)),
      prices.ETH ?? 0,
      priceSource,
      priceUpdatedAt
    )
  ];
  const usdcAmount = Number(formatUnits(usdcBalance, 6));
  if (usdcAmount > 0) {
    rows.push(
      toAssetRow(
        "USDC",
        chainName,
        usdcAmount,
        prices.USDC ?? 0,
        priceSource,
        priceUpdatedAt
      )
    );
  }
  return rows;
}

export async function fetchEvmPortfolioWithFallback(
  rpcCandidates: string[],
  owner: Address,
  chainName: EvmChainName,
  prices: Partial<Record<AccountAssetSymbol, number>>,
  priceSource: string,
  priceUpdatedAt: string
): Promise<{ portfolio: AccountAssetBalance[]; rpcUsed: string }> {
  let lastDetail = "";
  for (const rpc of rpcCandidates) {
    try {
      const portfolio = await fetchEvmPortfolioOnce(rpc, owner, chainName, prices, priceSource, priceUpdatedAt);
      return { portfolio, rpcUsed: rpc };
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
  }
  if (typeof import.meta !== "undefined" && import.meta.env?.DEV && lastDetail) {
    console.warn(`[evmChainAssets] ${chainName} balance fetch failed after fallbacks:`, lastDetail);
  }
  throw new Error(`${chainName} 블록체인 잔고를 불러올 수 없습니다.`);
}
