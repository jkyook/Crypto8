/**
 * morphoClient.ts
 * Morpho Offchain GraphQL API 클라이언트
 *
 * 엔드포인트: https://api.morpho.org/graphql
 * Rate limit : 5,000 req / 5min → 캐시로 실제 호출 최소화
 *
 * 제공 데이터:
 *   - getTopUsdcMarkets()   : USDC 렌딩 마켓 APY 상위 목록 (리밸런싱 판단용)
 *   - getUsdcVaults()       : USDC Vault 목록 (큐레이터·APY·TVL — 경쟁사 벤치마크용)
 *   - getUserPosition()     : 특정 지갑의 Morpho 전체 포지션 (온보딩 개인화용)
 *   - getBestMarketApy()    : 단일 숫자 — 현재 Morpho USDC 최고 공급 APY
 */

const MORPHO_GRAPHQL = process.env.MORPHO_GRAPHQL_URL?.trim() || "https://blue-api.morpho.org/graphql";

// 체인 ID
const CHAIN_IDS = {
  ethereum: 1,
  arbitrum: 42161,
  base: 8453,
} as const;

// ── 캐시 ──────────────────────────────────────────────────────────
type CacheEntry<T> = { data: T; expiresAt: number };
const cache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분

function getCache<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.data;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── GraphQL 공통 호출 ─────────────────────────────────────────────
async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(MORPHO_GRAPHQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Morpho API HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`Morpho API GraphQL error: ${json.errors[0].message}`);
  }
  if (!json.data) throw new Error("Morpho API: empty response");
  return json.data;
}

// ══════════════════════════════════════════════════════════════════
//  타입 정의
// ══════════════════════════════════════════════════════════════════

export type MorphoMarket = {
  uniqueKey: string;
  lltv: string;               // "860000000000000000" → 86%
  loanAsset: { symbol: string; address: string };
  collateralAsset: { symbol: string; address: string } | null;
  chain: { id: number };
  state: {
    supplyApy: number;        // 0~1 float (예: 0.052 = 5.2%)
    borrowApy: number;
    supplyAssetsUsd: number;
    liquidityAssetsUsd: number;
    utilization: number;
  };
};

export type MorphoVault = {
  address: string;
  name: string;
  symbol: string;
  asset: { symbol?: string; address: string };
  creatorAddress?: string | null;
  state: {
    apy: number;              // 수수료 차감 전
    netApy: number;           // 수수료 차감 후 사용자 실수령 APY
    fee: number;              // 성과보수율 (0~1)
    totalAssetsUsd: number;
  };
  chain: { id: number };
};

export type MorphoUserPosition = {
  marketPositions: {
    market: { uniqueKey: string; loanAsset: { symbol: string } };
    state: { supplyAssetsUsd: number; borrowAssetsUsd: number };
  }[];
  vaultPositions: {
    vault: { address: string; name: string; symbol: string };
    assets: string;
    assetsUsd: number;
  }[];
};

// ══════════════════════════════════════════════════════════════════
//  1. USDC 렌딩 마켓 — APY 상위 목록
//     오케스트레이터 리밸런싱 판단에 사용
// ══════════════════════════════════════════════════════════════════

const MARKETS_QUERY = `
  query TopUsdcMarkets($chainId: Int!) {
    markets(
      where: { chainId_in: [$chainId] }
      orderBy: SupplyAssetsUsd
      orderDirection: Desc
      first: 10
    ) {
      items {
        uniqueKey
        lltv
        loanAsset  { symbol address }
        collateralAsset { symbol address }
        chain { id }
        state {
          supplyApy
          borrowApy
          supplyAssetsUsd
          liquidityAssetsUsd
          utilization
        }
      }
    }
  }
`;

function isCompetitiveMarket(market: MorphoMarket): boolean {
  const liquidity = market.state.liquidityAssetsUsd ?? 0;
  const utilization = market.state.utilization ?? 0;
  return liquidity > 0 && utilization < 0.999;
}

function isCompetitiveVault(vault: MorphoVault): boolean {
  const tvlUsd = vault.state.totalAssetsUsd ?? 0;
  const netApyPct = vault.state.netApy * 100;
  return tvlUsd >= 1_000_000 && netApyPct > 0 && netApyPct <= 50;
}

export async function getTopUsdcMarkets(
  chainId: number = CHAIN_IDS.arbitrum
): Promise<MorphoMarket[]> {
  const cacheKey = `markets:usdc:${chainId}`;
  const cached = getCache<MorphoMarket[]>(cacheKey);
  if (cached) return cached;

  try {
    const data = await gql<{ markets: { items: MorphoMarket[] } }>(
      MARKETS_QUERY,
      { chainId }
    );
    const items = data.markets.items.filter(
      (market) => market.chain?.id === chainId && market.loanAsset?.symbol === "USDC"
    );
    const competitive = items.filter(isCompetitiveMarket).sort(
      (left, right) => right.state.supplyApy - left.state.supplyApy
    );
    if (competitive.length > 0) {
      setCache(cacheKey, competitive);
      return competitive;
    }
    const fallback = items
      .slice()
      .sort((left, right) => right.state.supplyAssetsUsd - left.state.supplyAssetsUsd)
      .slice(0, 5);
    setCache(cacheKey, fallback);
    return fallback;
  } catch (err) {
    console.error("[morphoClient] getTopUsdcMarkets error:", err);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════
//  2. USDC Vault 목록
//     Crypto8 대시보드 경쟁사 벤치마크 + 큐레이터 비교에 사용
// ══════════════════════════════════════════════════════════════════

const VAULTS_QUERY = `
  query UsdcVaults($chainId: Int!) {
    vaults(
      where: { chainId_in: [$chainId] }
      orderBy: TotalAssetsUsd
      orderDirection: Desc
      first: 20
    ) {
      items {
        address
        name
        symbol
        asset { address }
        creatorAddress
        state { apy netApy fee totalAssetsUsd }
        chain { id }
      }
    }
  }
`;

export async function getUsdcVaults(
  chainId: number = CHAIN_IDS.arbitrum
): Promise<MorphoVault[]> {
  const cacheKey = `vaults:usdc:${chainId}`;
  const cached = getCache<MorphoVault[]>(cacheKey);
  if (cached) return cached;

  try {
    const data = await gql<{ vaults: { items: MorphoVault[] } }>(
      VAULTS_QUERY,
      { chainId }
    );
    const result = data.vaults.items.filter((vault) => vault.chain?.id === chainId);
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error("[morphoClient] getUsdcVaults error:", err);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════
//  3. 특정 지갑의 Morpho 포지션
//     온보딩 개인화: "당신의 현재 수익률 vs Crypto8 Vault"
// ══════════════════════════════════════════════════════════════════

const USER_POSITION_QUERY = `
  query UserPosition($address: String!, $chainId: Int!) {
    userByAddress(address: $address, chainId: $chainId) {
      marketPositions {
        market {
          uniqueKey
          loanAsset { symbol }
        }
        state {
          supplyAssetsUsd
          borrowAssetsUsd
        }
      }
      vaultPositions {
        vault { address name symbol }
        assets
        assetsUsd
      }
    }
  }
`;

export async function getUserPosition(
  address: string,
  chainId: number = CHAIN_IDS.arbitrum
): Promise<MorphoUserPosition | null> {
  const cacheKey = `user:${address.toLowerCase()}:${chainId}`;
  const cached = getCache<MorphoUserPosition>(cacheKey);
  if (cached) return cached;

  try {
    const data = await gql<{ userByAddress: MorphoUserPosition | null }>(
      USER_POSITION_QUERY,
      { address, chainId }
    );
    const result = data.userByAddress;
    if (result) setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error("[morphoClient] getUserPosition error:", err);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════
//  4. 단일 숫자 — 현재 Morpho USDC 최고 공급 APY
//     marketAprHistory 기록, 오케스트레이터 리밸런싱 임계값에 사용
// ══════════════════════════════════════════════════════════════════

export async function getBestMarketApy(
  chainId: number = CHAIN_IDS.arbitrum
): Promise<number> {
  const markets = await getTopUsdcMarkets(chainId);
  if (markets.length === 0) return 0;
  // supplyApy가 0~1 float이므로 % 변환
  return markets[0].state.supplyApy * 100;
}

// ══════════════════════════════════════════════════════════════════
//  5. 경쟁 벤치마크 요약
//     대시보드용: Morpho 전체 USDC Vault 중 상위 3개 APY
// ══════════════════════════════════════════════════════════════════

export type MorphoBenchmark = {
  fetchedAt: string;
  bestMarketApy: number;        // % 단위
  topVaults: {
    name: string;
    curator: string;
    grossApy: number;           // % 단위
    netApy: number;             // % 단위
    feePct: number;             // % 단위
    totalAssetsUsdM: number;    // $M 단위
  }[];
};

export async function getMorphoBenchmark(
  chainId: number = CHAIN_IDS.arbitrum
): Promise<MorphoBenchmark> {
  const cacheKey = `benchmark:${chainId}`;
  const cached = getCache<MorphoBenchmark>(cacheKey);
  if (cached) return cached;

  const [markets, vaults] = await Promise.all([
    getTopUsdcMarkets(chainId),
    getUsdcVaults(chainId),
  ]);
  const competitiveVaults = vaults.filter(isCompetitiveVault);
  const rankedVaults = (competitiveVaults.length > 0 ? competitiveVaults : vaults)
    .slice()
    .sort((left, right) => right.state.netApy - left.state.netApy);

  const result: MorphoBenchmark = {
    fetchedAt: new Date().toISOString(),
    bestMarketApy: markets[0]?.state.supplyApy ? markets[0].state.supplyApy * 100 : 0,
    topVaults: rankedVaults
      .slice(0, 5)
      .map((v) => ({
        name: v.name,
        curator: v.creatorAddress ? `${v.creatorAddress.slice(0, 6)}…${v.creatorAddress.slice(-4)}` : "Unknown",
        grossApy: v.state.apy * 100,
        netApy: v.state.netApy * 100,
        feePct: v.state.fee * 100,
        totalAssetsUsdM: v.state.totalAssetsUsd / 1_000_000,
      })),
  };

  setCache(cacheKey, result);
  return result;
}

// ── 캐시 초기화 (테스트용) ────────────────────────────────────────
export function clearMorphoCache(): void {
  cache.clear();
}

// ── 체인 ID 상수 re-export ────────────────────────────────────────
export { CHAIN_IDS };
