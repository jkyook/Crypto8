import { Connection, VersionedTransaction } from "@solana/web3.js";

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
  data?: Array<Record<string, unknown>>;
};

type JupiterSwapResponse = {
  swapTransaction?: string;
};

type JupiterQuoteRoute = {
  outAmount?: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string;
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
  const userPublicKey = normalizePublicKey(input.wallet.publicKey);
  const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote.route,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true
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
}): Promise<{
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  outAmountRaw: bigint;
  minOutAmountRaw: bigint;
  priceImpactPct: string;
  route: JupiterQuoteRoute;
}> {
  if (input.amountRaw <= 0n) {
    throw new Error("swap amount must be greater than zero");
  }

  const quoteUrl = new URL("https://quote-api.jup.ag/v6/quote");
  quoteUrl.searchParams.set("inputMint", input.inputMint);
  quoteUrl.searchParams.set("outputMint", input.outputMint);
  quoteUrl.searchParams.set("amount", input.amountRaw.toString());
  quoteUrl.searchParams.set("swapMode", "ExactIn");
  quoteUrl.searchParams.set("slippageBps", String(input.slippageBps ?? 100));

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
    route: bestRoute
  };
}
