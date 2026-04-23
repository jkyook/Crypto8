import { Connection, VersionedTransaction } from "@solana/web3.js";
import { fetchMarketPrices, publicApiFetch } from "./api";

function decodeBase64ToUint8Array(base64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(base64);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  throw new Error("Base64 decoding is not available in this runtime");
}

function mintPriceUsd(mint: string, prices: Awaited<ReturnType<typeof fetchMarketPrices>>["prices"]): number {
  const lower = mint.toLowerCase();
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".toLowerCase();
  const usdt = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB".toLowerCase();
  const sol = "So11111111111111111111111111111111111111112".toLowerCase();
  const msol = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So".toLowerCase();
  if (lower === usdc || lower === usdt) return 1;
  if (lower === sol || lower === msol) return prices.SOL ?? 0;
  return prices.USDC ?? 1;
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
};

type JupiterQuoteResult = {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  outAmountRaw: bigint;
  minOutAmountRaw: bigint;
  priceImpactPct: string;
  quoteResponse: JupiterQuoteResponse;
  source: "jupiter" | "estimate";
};

type JupiterOrderResponse = {
  transaction?: string;
  errorCode?: number;
  errorMessage?: string;
  error?: string;
};

type SolanaTransactionSigner = {
  publicKey: unknown;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction | { serialize: () => Uint8Array }>;
};

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function fetchJupiterProxy(localPath: string, context: string): Promise<Response> {
  const attempts = [
    { timeoutMs: 30000, retryDelayMs: 1500 },
    { timeoutMs: 30000, retryDelayMs: 0 }
  ];
  let lastError: unknown;

  for (const [index, attempt] of attempts.entries()) {
    try {
      const response = await publicApiFetch(localPath, {
        signal: AbortSignal.timeout(attempt.timeoutMs)
      });
      return response;
    } catch (error) {
      lastError = error;
      if (attempt.retryDelayMs > 0 && index < attempts.length - 1) {
        await sleep(attempt.retryDelayMs);
      }
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${context}: ${msg || "요청 실패"}`);
}

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
  const userPublicKey = normalizePublicKey(input.wallet.publicKey);
  const orderUrl = new URL("/api/jupiter/order", window.location.origin);
  orderUrl.searchParams.set("inputMint", input.inputMint);
  orderUrl.searchParams.set("outputMint", input.outputMint);
  orderUrl.searchParams.set("amount", input.amountRaw.toString());
  orderUrl.searchParams.set("slippageBps", String(input.slippageBps ?? 100));
  orderUrl.searchParams.set("taker", userPublicKey);

  const orderRes = await fetchJupiterProxy(`/api/jupiter/order?${orderUrl.searchParams.toString()}`, "Jupiter swap order");
  if (!orderRes.ok) {
    const orderRaw = (await orderRes.json().catch(() => ({}))) as JupiterOrderResponse;
    const reason = orderRaw.errorMessage || orderRaw.error || `HTTP ${orderRes.status}`;
    throw new Error(
      quote.source === "estimate"
        ? `Jupiter swap order failed after fallback quote: ${reason}`
        : `Jupiter swap order failed: ${reason}`
    );
  }
  const orderJson = (await orderRes.json()) as JupiterOrderResponse;
  const swapTx = orderJson.transaction;
  if (!swapTx) {
    const reason = orderJson.errorMessage || orderJson.error || "transaction missing";
    throw new Error(`Jupiter swap order returned no transaction: ${reason}`);
  }

  const txBytes = decodeBase64ToUint8Array(swapTx);
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

  const quoteUrl = new URL("/api/jupiter/quote", window.location.origin);
  quoteUrl.searchParams.set("inputMint", input.inputMint);
  quoteUrl.searchParams.set("outputMint", input.outputMint);
  quoteUrl.searchParams.set("amount", input.amountRaw.toString());
  quoteUrl.searchParams.set("swapMode", "ExactIn");
  quoteUrl.searchParams.set("slippageBps", String(input.slippageBps ?? 100));

  try {
    const quoteRes = await fetchJupiterProxy(`/api/jupiter/quote?${quoteUrl.searchParams.toString()}`, "Jupiter quote");
    if (!quoteRes.ok) {
      throw new Error(`Jupiter quote failed: HTTP ${quoteRes.status}`);
    }
    const quoteJson = (await quoteRes.json()) as JupiterQuoteResponse;
    if (!quoteJson?.outAmount) {
      throw new Error("Jupiter quote returned no route");
    }

    return {
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      amountRaw: input.amountRaw,
      outAmountRaw: BigInt(quoteJson.outAmount),
      minOutAmountRaw: BigInt(quoteJson.otherAmountThreshold ?? quoteJson.outAmount),
      priceImpactPct: quoteJson.priceImpactPct ?? "0",
      quoteResponse: quoteJson,
      source: "jupiter"
    };
  } catch {
    const market = await fetchMarketPrices();
    const inputSymbolPrice = mintPriceUsd(input.inputMint, market.prices);
    const outputSymbolPrice = mintPriceUsd(input.outputMint, market.prices);
    const inputDecimals = input.inputMint === "So11111111111111111111111111111111111111112" ? 9 : 6;
    const outputDecimals = input.outputMint === "So11111111111111111111111111111111111111112" ? 9 : 6;
    const inputHuman = Number(input.amountRaw) / 10 ** inputDecimals;
    const estimatedOutHuman = inputHuman * (inputSymbolPrice / Math.max(outputSymbolPrice, 1e-9)) * 0.995;
    const outAmountRaw = BigInt(Math.max(1, Math.floor(estimatedOutHuman * 10 ** outputDecimals)));
    const minOutAmountRaw = BigInt(Math.max(1, Math.floor(Number(outAmountRaw) * 0.99)));
    return {
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      amountRaw: input.amountRaw,
      outAmountRaw,
      minOutAmountRaw,
      priceImpactPct: "0.5",
      quoteResponse: {
        inputMint: input.inputMint,
        inAmount: input.amountRaw.toString(),
        outputMint: input.outputMint,
        outAmount: outAmountRaw.toString(),
        otherAmountThreshold: minOutAmountRaw.toString(),
        swapMode: "ExactIn",
        slippageBps: input.slippageBps ?? 100,
        priceImpactPct: "0.5",
        routePlan: [],
        platformFee: null,
        contextSlot: undefined,
        timeTaken: undefined
      },
      source: "estimate"
    };
  }
}
