import type { AccountAssetBalance, AccountAssetSymbol } from "./api";

/** SPL Token 프로그램 (Solana). */
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export type OnChainTokenRow = {
  mint: string;
  symbol: string;
  amount: number;
  decimals: number;
};

/** Mainnet 자주 쓰는 민트 → 티커 (조회 전용 표시). */
const KNOWN_MINT_SYMBOL_MAINNET: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  So11111111111111111111111111111111111111112: "SOL(Wrapped)",
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK"
};

function symbolForMint(mint: string, network: "mainnet" | "devnet"): string {
  if (network === "mainnet" && KNOWN_MINT_SYMBOL_MAINNET[mint]) {
    return KNOWN_MINT_SYMBOL_MAINNET[mint];
  }
  return `Mint ${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

type RpcJson = { result?: unknown; error?: { message?: string } };

function parseTokenAccounts(json: RpcJson, network: "mainnet" | "devnet"): OnChainTokenRow[] {
  const out: OnChainTokenRow[] = [];
  const result = json.result as
    | {
        value?: Array<{
          account?: { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number | null; decimals?: number; amount?: string } } } } };
        }>;
      }
    | undefined;
  const rows = result?.value ?? [];
  for (const row of rows) {
    const info = row.account?.data?.parsed?.info;
    const mint = info?.mint;
    const ta = info?.tokenAmount;
    if (!mint || ta?.uiAmount === undefined || ta.uiAmount === null) continue;
    const amount = typeof ta.uiAmount === "number" ? ta.uiAmount : Number(ta.uiAmount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const decimals = typeof ta.decimals === "number" ? ta.decimals : Number(ta.decimals ?? 0);
    out.push({
      mint,
      symbol: symbolForMint(mint, network),
      amount,
      decimals: Number.isFinite(decimals) ? decimals : 0
    });
  }
  out.sort((a, b) => b.amount - a.amount);
  return out;
}

export type OnChainPortfolio = {
  sol: number;
  tokens: OnChainTokenRow[];
};

function normalizeAccountAssetSymbol(symbol: string): AccountAssetSymbol | null {
  const upper = symbol.toUpperCase();
  if (upper.includes("USDC")) return "USDC";
  if (upper.includes("USDT")) return "USDT";
  if (upper.includes("SOL")) return "SOL";
  if (upper.includes("ETH")) return "ETH";
  return null;
}

/** Solana JSON-RPC로 네이티브 SOL + SPL 잔고 조회(단일 엔드포인트). */
export async function fetchOnChainPortfolio(rpcUrl: string, owner: string, network: "mainnet" | "devnet"): Promise<OnChainPortfolio> {
  const [balRes, tokRes] = await Promise.all([
    fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [owner]
      })
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
    const t = await bad.text().catch(() => "");
    throw new Error(
      t.includes("Access forbidden") || bad.status === 403 ? "RPC Access forbidden (403)" : `HTTP ${bad.status}`
    );
  }

  const balJson = (await balRes.json()) as RpcJson;
  if (balJson.error?.message) {
    throw new Error(balJson.error.message);
  }
  const lamports = (balJson.result as { value?: number } | undefined)?.value ?? 0;
  const tokJson = (await tokRes.json()) as RpcJson;
  if (tokJson.error?.message) {
    throw new Error(tokJson.error.message);
  }
  const tokens = parseTokenAccounts(tokJson, network);
  return { sol: lamports / 1_000_000_000, tokens };
}

/** Vite 환경변수 + 공개 RPC 후보(403·레이트리밋 시 순차 시도). */
export function getSolanaRpcCandidates(network: "mainnet" | "devnet"): string[] {
  const raw =
    typeof import.meta !== "undefined" && import.meta.env && typeof import.meta.env.VITE_SOLANA_RPC_URL === "string"
      ? import.meta.env.VITE_SOLANA_RPC_URL.trim()
      : "";
  const custom = raw.length > 0 ? [raw] : [];
  const defaults =
    network === "mainnet"
      ? [
          "https://api.mainnet-beta.solana.com",
          "https://solana-rpc.publicnode.com",
          "https://rpc.ankr.com/solana"
        ]
      : ["https://api.devnet.solana.com", "https://solana-devnet.publicnode.com"];
  return [...custom, ...defaults.filter((u) => !custom.includes(u))];
}

export async function fetchOnChainPortfolioWithFallback(
  rpcCandidates: string[],
  owner: string,
  network: "mainnet" | "devnet"
): Promise<{ portfolio: OnChainPortfolio; rpcUsed: string }> {
  let lastDetail = "";
  for (const rpc of rpcCandidates) {
    try {
      const portfolio = await fetchOnChainPortfolio(rpc, owner, network);
      return { portfolio, rpcUsed: rpc };
    } catch (e) {
      lastDetail = e instanceof Error ? e.message : String(e);
    }
  }
  if (typeof import.meta !== "undefined" && import.meta.env?.DEV && lastDetail) {
    console.warn("[solanaChainAssets] on-chain balance fetch failed after fallbacks:", lastDetail);
  }
  throw new Error("지금은 블록체인 잔고를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.");
}

export function portfolioToAccountAssetBalances(
  portfolio: OnChainPortfolio,
  prices: Partial<Record<AccountAssetSymbol, number>>,
  priceSource: string,
  priceUpdatedAt: string
): AccountAssetBalance[] {
  const rows: AccountAssetBalance[] = [];
  if (Number.isFinite(portfolio.sol) && portfolio.sol > 0) {
    const solPrice = prices.SOL ?? 0;
    rows.push({
      symbol: "SOL",
      chain: "Solana",
      amount: portfolio.sol,
      usdPrice: solPrice,
      usdValue: Number((portfolio.sol * solPrice).toFixed(2)),
      priceSource,
      priceUpdatedAt
    });
  }
  for (const token of portfolio.tokens) {
    const symbol = normalizeAccountAssetSymbol(token.symbol);
    if (!symbol || token.amount <= 0) {
      continue;
    }
    const usdPrice = prices[symbol] ?? 0;
    rows.push({
      symbol,
      chain: "Solana",
      amount: token.amount,
      usdPrice,
      usdValue: Number((token.amount * usdPrice).toFixed(2)),
      priceSource,
      priceUpdatedAt
    });
  }
  return rows;
}

export function solscanTokenUrl(mint: string, network: "mainnet" | "devnet"): string {
  const base = `https://solscan.io/token/${mint}`;
  return network === "devnet" ? `${base}?cluster=devnet` : base;
}
