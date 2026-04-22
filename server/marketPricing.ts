export type PriceSymbol = "USDC" | "USDT" | "ETH" | "SOL" | "MSOL";

export type MarketPriceSnapshot = {
  prices: Record<PriceSymbol, number>;
  updatedAt: string;
  source: string;
};

const FALLBACK_PRICES: Record<PriceSymbol, number> = {
  USDC: 1,
  USDT: 1,
  ETH: 3000,
  SOL: 150,
  MSOL: 150
};

const DEFILLAMA_COINS: Record<PriceSymbol, string> = {
  USDC: "coingecko:usd-coin",
  USDT: "coingecko:tether",
  ETH: "coingecko:ethereum",
  SOL: "coingecko:solana",
  MSOL: "coingecko:marinade-staked-sol"
};

let cached: { snapshot: MarketPriceSnapshot; expiresAt: number } | null = null;

function parseDefillamaPrice(data: unknown, coin: string): number | null {
  const row = (data as { coins?: Record<string, { price?: unknown }> }).coins?.[coin];
  const price = row?.price;
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
}

export async function getMarketPriceSnapshot(): Promise<MarketPriceSnapshot> {
  if (cached && cached.expiresAt > Date.now()) {
    return cached.snapshot;
  }
  try {
    const coins = Object.values(DEFILLAMA_COINS).join(",");
    const response = await fetch(`https://coins.llama.fi/prices/current/${coins}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      throw new Error(`price api http ${response.status}`);
    }
    const data = await response.json();
    const prices = Object.entries(DEFILLAMA_COINS).reduce<Record<PriceSymbol, number>>((acc, [symbol, coin]) => {
      const parsed = parseDefillamaPrice(data, coin);
      acc[symbol as PriceSymbol] = parsed ?? FALLBACK_PRICES[symbol as PriceSymbol];
      return acc;
    }, { ...FALLBACK_PRICES });
    const snapshot = { prices, updatedAt: new Date().toISOString(), source: "defillama-coins" };
    cached = { snapshot, expiresAt: Date.now() + 60_000 };
    return snapshot;
  } catch {
    const snapshot = { prices: FALLBACK_PRICES, updatedAt: new Date().toISOString(), source: "fallback" };
    cached = { snapshot, expiresAt: Date.now() + 15_000 };
    return snapshot;
  }
}
