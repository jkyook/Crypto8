import Decimal from "decimal.js";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { fetchMarketPrices } from "./api";
import { resolveSolanaSymbolForMint, resolveSolanaTokenDecimals } from "./solanaTokenMints";

function decodeBase64ToUint8Array(base64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(base64);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  throw new Error("Base64 decoding is not available in this runtime");
}

function normalizePublicKey(value: unknown): string {
  if (!value) {
    throw new Error("Solana wallet is not connected");
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "object") {
    const candidate = value as { toBase58?: () => string; toString?: () => string };
    const base58 = candidate.toBase58?.();
    if (typeof base58 === "string" && base58.length > 0) {
      return base58;
    }
    const asString = candidate.toString?.();
    if (typeof asString === "string" && asString.length > 0 && asString !== "[object Object]") {
      return asString;
    }
  }
  throw new Error("Invalid Solana public key input");
}

type JupiterQuoteResponse = {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: "ExactIn" | "ExactOut";
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<Record<string, unknown>>;
  platformFee?: { amount: string; feeBps: number } | null;
  contextSlot?: number;
  timeTaken?: number;
  data?: JupiterQuoteRoute[];
};

type JupiterSwapResponse = {
  swapTransaction?: string;
};

type JupiterQuoteRoute = {
  outAmount?: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string;
};

type JupiterQuoteResult = {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  outAmountRaw: bigint;
  minOutAmountRaw: bigint;
  priceImpactPct: string;
  source: "jupiter" | "estimate";
  quoteResponse?: JupiterQuoteResponse;
  route?: JupiterQuoteRoute;
};

type SolanaTransactionSigner = {
  publicKey: unknown;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction | { serialize: () => Uint8Array }>;
};

export async function executeJupiterExactInSwap(input: {
  connection: Connection;
  wallet: SolanaTransactionSigner;
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  slippageBps?: number;
  label?: string;
}): Promise<{ signature: string; inputMint: string; outputMint: string; amountRaw: bigint; label?: string }> {
  if (input.amountRaw <= 0n) {
    throw new Error("swap amount must be greater than zero");
  }

  const quote = await quoteJupiterExactInSwap({
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amountRaw: input.amountRaw,
    slippageBps: input.slippageBps ?? 100
  });
  if (quote.source !== "jupiter") {
    throw new Error("Jupiter 견적을 불러오지 못해 현재는 예상 수량만 표시할 수 있습니다. 잠시 후 다시 시도해 주세요.");
  }
  const userPublicKey = normalizePublicKey(input.wallet.publicKey);
  const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote.quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true
    }),
    signal: AbortSignal.timeout(12000)
  });
  if (!swapRes.ok) {
    throw new Error(`Jupiter swap build failed: HTTP ${swapRes.status}`);
  }
  const swapJson = (await swapRes.json()) as JupiterSwapResponse;
  if (!swapJson.swapTransaction) {
    throw new Error("Jupiter swap build returned no transaction");
  }

  const txBytes = decodeBase64ToUint8Array(swapJson.swapTransaction);
  const tx = VersionedTransaction.deserialize(txBytes);
  const signedTx = (await input.wallet.signTransaction(tx)) as VersionedTransaction;
  const signature = await input.connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });
  await input.connection.confirmTransaction(signature, "confirmed");
  return {
    signature,
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amountRaw: input.amountRaw,
    label: input.label
  };
}

export async function quoteJupiterExactInSwap(input: {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  slippageBps?: number;
}): Promise<JupiterQuoteResult> {
  if (input.amountRaw <= 0n) {
    throw new Error("swap amount must be greater than zero");
  }

  const quoteUrl = new URL("https://quote-api.jup.ag/v6/quote");
  quoteUrl.searchParams.set("inputMint", input.inputMint);
  quoteUrl.searchParams.set("outputMint", input.outputMint);
  quoteUrl.searchParams.set("amount", input.amountRaw.toString());
  quoteUrl.searchParams.set("swapMode", "ExactIn");
  quoteUrl.searchParams.set("slippageBps", String(input.slippageBps ?? 100));

  try {
    const quoteRes = await fetch(quoteUrl.toString(), { signal: AbortSignal.timeout(12000) });
    if (!quoteRes.ok) {
      throw new Error(`Jupiter quote failed: HTTP ${quoteRes.status}`);
    }
    const quoteJson = (await quoteRes.json()) as JupiterQuoteResponse;
    const bestRoute = quoteJson.data?.[0] as JupiterQuoteRoute | undefined;
    if (!bestRoute?.outAmount) {
      throw new Error("Jupiter quote returned no route");
    }

    return {
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      amountRaw: input.amountRaw,
      outAmountRaw: BigInt(bestRoute.outAmount),
      minOutAmountRaw: BigInt(bestRoute.otherAmountThreshold ?? bestRoute.outAmount),
      priceImpactPct: bestRoute.priceImpactPct ?? "0",
      quoteResponse: quoteJson,
      route: bestRoute,
      source: "jupiter"
    };
  } catch (error) {
    const fallback = await buildEstimatedJupiterQuote(input);
    if (fallback) {
      return fallback;
    }
    throw error instanceof Error ? error : new Error("Jupiter quote failed");
  }
}

async function buildEstimatedJupiterQuote(input: {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  slippageBps?: number;
}): Promise<JupiterQuoteResult | null> {
  const inputSymbol = resolveSolanaSymbolForMint(input.inputMint);
  const outputSymbol = resolveSolanaSymbolForMint(input.outputMint);
  if (!inputSymbol || !outputSymbol) {
    return null;
  }

  const priceSnapshot = await fetchMarketPrices();
  const inputPrice = priceSnapshot.prices[inputSymbol];
  const outputPrice = priceSnapshot.prices[outputSymbol];
  if (!Number.isFinite(inputPrice) || inputPrice <= 0 || !Number.isFinite(outputPrice) || outputPrice <= 0) {
    return null;
  }

  const inputDecimals = resolveSolanaTokenDecimals(inputSymbol);
  const outputDecimals = resolveSolanaTokenDecimals(outputSymbol);
  const humanInput = new Decimal(input.amountRaw.toString()).div(new Decimal(10).pow(inputDecimals));
  const estimatedOutHuman = humanInput.mul(inputPrice).div(outputPrice);
  const estimatedOutRaw = estimatedOutHuman.mul(new Decimal(10).pow(outputDecimals)).floor();
  if (!estimatedOutRaw.isFinite() || estimatedOutRaw.lte(0)) {
    return null;
  }

  const estimatedOutRawBigInt = BigInt(estimatedOutRaw.toFixed(0));
  const slippageBps = input.slippageBps ?? 100;
  const minOutAmountRaw = BigInt(
    new Decimal(estimatedOutRawBigInt.toString())
      .mul(new Decimal(10_000 - slippageBps))
      .div(10_000)
      .floor()
      .toFixed(0)
  );

  return {
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amountRaw: input.amountRaw,
    outAmountRaw: estimatedOutRawBigInt,
    minOutAmountRaw,
    priceImpactPct: "0",
    quoteResponse: undefined,
    route: {
      outAmount: estimatedOutRawBigInt.toString(),
      otherAmountThreshold: minOutAmountRaw.toString(),
      priceImpactPct: "0"
    },
    source: "estimate"
  };
}
