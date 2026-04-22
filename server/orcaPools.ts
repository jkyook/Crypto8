type OrcaPoolSearchResult = {
  address: string;
  tickSpacing: number;
  feeRate?: number;
  tokenMintA: string;
  tokenMintB: string;
  tokenA?: { symbol?: string; address?: string };
  tokenB?: { symbol?: string; address?: string };
  tvlUsdc?: string;
  price?: string;
  poolType?: string;
  hasWarning?: boolean;
};

const ORCA_POOL_SEARCH_URL = "https://api.orca.so/v2/solana/pools/search";
const ORCA_POOL_CACHE = new Map<string, OrcaPoolSearchResult>();

const ORCA_ACTION_TO_QUERY: Record<string, { query: string; preferredFeeRate?: number }> = {
  "USDC-USDT Whirlpool (0.01%)": { query: "USDC-USDT", preferredFeeRate: 100 },
  "USDC-USDT Whirlpool": { query: "USDC-USDT", preferredFeeRate: 100 },
  "SOL-USDC Whirlpool": { query: "SOL-USDC" },
  "mSOL-SOL Whirlpool": { query: "mSOL-SOL" }
};

const ORCA_ACTION_MINTS: Record<string, [string, string]> = {
  "USDC-USDT Whirlpool (0.01%)": [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
  ],
  "USDC-USDT Whirlpool": [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
  ],
  "SOL-USDC Whirlpool": [
    "So11111111111111111111111111111111111111112",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  ],
  "mSOL-SOL Whirlpool": [
    "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    "So11111111111111111111111111111111111111112"
  ]
};

function sameMintPair(left: OrcaPoolSearchResult, a: string, b: string): boolean {
  const pair = new Set([left.tokenMintA.toLowerCase(), left.tokenMintB.toLowerCase()]);
  return pair.has(a.toLowerCase()) && pair.has(b.toLowerCase());
}

function parsePoolSearchResults(data: unknown): OrcaPoolSearchResult[] {
  const rows = (data as { data?: unknown[] })?.data ?? [];
  return rows.flatMap((row) => {
    const item = row as Partial<OrcaPoolSearchResult>;
    if (
      typeof item.address !== "string" ||
      typeof item.tickSpacing !== "number" ||
      typeof item.tokenMintA !== "string" ||
      typeof item.tokenMintB !== "string"
    ) {
      return [];
    }
    return [
      {
        address: item.address,
        tickSpacing: item.tickSpacing,
        feeRate: typeof item.feeRate === "number" ? item.feeRate : undefined,
        tokenMintA: item.tokenMintA,
        tokenMintB: item.tokenMintB,
        tokenA: item.tokenA,
        tokenB: item.tokenB,
        tvlUsdc: typeof item.tvlUsdc === "string" ? item.tvlUsdc : undefined,
        price: typeof item.price === "string" ? item.price : undefined,
        poolType: typeof item.poolType === "string" ? item.poolType : undefined,
        hasWarning: typeof item.hasWarning === "boolean" ? item.hasWarning : undefined
      }
    ];
  });
}

export async function resolveOrcaPoolForAction(action: string): Promise<OrcaPoolSearchResult> {
  const cached = ORCA_POOL_CACHE.get(action);
  if (cached) {
    return cached;
  }

  const query = ORCA_ACTION_TO_QUERY[action];
  if (!query) {
    throw new Error(`unsupported Orca action: ${action}`);
  }

  const url = new URL(ORCA_POOL_SEARCH_URL);
  url.searchParams.set("q", query.query);
  url.searchParams.set("size", "20");
  url.searchParams.set("sortBy", "tvl");
  url.searchParams.set("sortDirection", "desc");
  url.searchParams.set("verifiedOnly", "true");

  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    throw new Error(`Orca pool search failed: HTTP ${response.status}`);
  }
  const json = await response.json();
  const rows = parsePoolSearchResults(json);
  if (rows.length === 0) {
    throw new Error(`No Orca pools found for query: ${query.query}`);
  }

  let selected = rows.find((row) => {
    const symbolA = row.tokenA?.symbol?.toUpperCase();
    const symbolB = row.tokenB?.symbol?.toUpperCase();
    if (!symbolA || !symbolB) return false;
    const symbols = new Set([symbolA, symbolB]);
    if (query.query === "USDC-USDT") {
      return symbols.has("USDC") && symbols.has("USDT");
    }
    if (query.query === "SOL-USDC") {
      return symbols.has("SOL") && symbols.has("USDC");
    }
    if (query.query === "mSOL-SOL") {
      return symbols.has("MSOL") || symbols.has("SOL");
    }
    return false;
  });

  if (!selected) {
    if (query.preferredFeeRate !== undefined) {
      selected = rows.find((row) => row.feeRate === query.preferredFeeRate);
    }
    if (!selected) {
      const [mintA, mintB] = ORCA_ACTION_MINTS[action];
      selected = rows.find((row) => sameMintPair(row, mintA, mintB)) ?? rows[0];
    }
  }

  if (!selected) {
    throw new Error(`No exact Orca pool match found for action: ${action}`);
  }

  ORCA_POOL_CACHE.set(action, selected);
  return selected;
}

export async function resolveOrcaPoolCandidatesForAction(
  action: string,
  network: SolanaNetwork = "mainnet"
): Promise<OrcaPoolSearchResult[]> {
  const cacheKey = `${network}:${action}`;
  const cached = ORCA_POOL_CACHE.get(cacheKey);
  if (cached) {
    return [cached];
  }

  const query = ORCA_ACTION_TO_QUERY[action];
  if (!query) {
    throw new Error(`unsupported Orca action: ${action}`);
  }

  const url = new URL(ORCA_POOL_SEARCH_URL);
  url.searchParams.set("q", query.query);
  url.searchParams.set("size", "20");
  url.searchParams.set("sortBy", "tvl");
  url.searchParams.set("sortDirection", "desc");
  url.searchParams.set("verifiedOnly", "true");

  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    throw new Error(`Orca pool search failed: HTTP ${response.status}`);
  }
  const json = await response.json();
  const rows = parsePoolSearchResults(json);
  if (rows.length === 0) {
    throw new Error(`No Orca pools found for query: ${query.query}`);
  }
  return rows;
}
