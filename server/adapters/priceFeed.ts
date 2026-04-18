type PriceSource = "defillama" | "coingecko" | "fallback";

export type StablePairPrice = {
  usdcUsd: number;
  usdtUsd: number;
  source: PriceSource;
};

async function fetchFromDefiLlama(): Promise<StablePairPrice> {
  const response = await fetch("https://coins.llama.fi/prices/current/coingecko:usd-coin,coingecko:tether");
  if (!response.ok) {
    throw new Error(`defillama price api failed: ${response.status}`);
  }
  const json = (await response.json()) as {
    coins?: {
      "coingecko:usd-coin"?: { price?: number };
      "coingecko:tether"?: { price?: number };
    };
  };
  const usdcUsd = json.coins?.["coingecko:usd-coin"]?.price;
  const usdtUsd = json.coins?.["coingecko:tether"]?.price;
  if (!usdcUsd || !usdtUsd || usdcUsd <= 0 || usdtUsd <= 0) {
    throw new Error("invalid defillama response");
  }
  return { usdcUsd, usdtUsd, source: "defillama" };
}

async function fetchFromCoinGecko(): Promise<StablePairPrice> {
  const response = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin,tether&vs_currencies=usd"
  );
  if (!response.ok) {
    throw new Error(`coingecko price api failed: ${response.status}`);
  }
  const json = (await response.json()) as {
    "usd-coin"?: { usd?: number };
    tether?: { usd?: number };
  };
  const usdcUsd = json["usd-coin"]?.usd;
  const usdtUsd = json.tether?.usd;
  if (!usdcUsd || !usdtUsd || usdcUsd <= 0 || usdtUsd <= 0) {
    throw new Error("invalid coingecko response");
  }
  return { usdcUsd, usdtUsd, source: "coingecko" };
}

export async function getUsdcUsdtPrice(): Promise<StablePairPrice> {
  try {
    return await fetchFromDefiLlama();
  } catch (firstError) {
    console.warn("defillama price failed, trying coingecko", firstError);
    try {
      return await fetchFromCoinGecko();
    } catch (secondError) {
      console.warn("coingecko price failed, fallback 1:1", secondError);
      return {
        usdcUsd: 1,
        usdtUsd: 1,
        source: "fallback"
      };
    }
  }
}
