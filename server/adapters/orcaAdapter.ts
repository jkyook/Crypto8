/**
 * Orca Whirlpool adapter — Solana chain.
 *
 * dry-run 은 시뮬레이션 결과만 반환하고,
 * live 는 Orca public API로 Whirlpool을 찾은 뒤 실제 on-chain open position + add liquidity 를 시도한다.
 */
import { AnchorProvider } from "@coral-xyz/anchor";
import { Percentage } from "@orca-so/common-sdk";
import {
  buildWhirlpoolClient,
  TickUtil,
  TokenExtensionUtil,
  WhirlpoolContext,
  increaseLiquidityQuoteByInputToken
} from "@orca-so/whirlpools-sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";
import { getMarketPriceSnapshot } from "../marketPricing";
import { getConfiguredSolanaRpcUrl } from "../runtimeMode";
import { loadSolanaExecutorKeypair } from "../secrets";
import { resolveOrcaPoolForAction } from "../orcaPools";

function buildTxId(prefix: string, context: AdapterExecutionContext): string {
  return `${prefix}_${context.jobId}_${Date.now()}`;
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractPoolSearchQuery(action: string): string {
  const base = action.replace(/\s*\(.*\)\s*$/, "");
  const cleaned = base.replace(/\s*Whirlpool.*$/i, "").trim();
  return cleaned.length > 0 ? cleaned : action;
}

function expectedPairFromAction(action: string): string[] {
  const lower = action.toLowerCase();
  if (lower.includes("usdc-usdt")) return ["usdc", "usdt"];
  if (lower.includes("sol-usdc")) return ["sol", "usdc"];
  if (lower.includes("msol-sol")) return ["msol", "sol"];
  return [];
}

function symbolPriceUsd(symbol: string, snapshot: Awaited<ReturnType<typeof getMarketPriceSnapshot>>["prices"]): number {
  const normalized = normalizeLabel(symbol);
  if (normalized.includes("usdc") || normalized.includes("usdt") || normalized.includes("usd")) {
    return 1;
  }
  if (normalized.includes("sol")) {
    return snapshot.SOL;
  }
  if (normalized.includes("eth")) {
    return snapshot.ETH;
  }
  throw new Error(`unsupported Orca token symbol for USD valuation: ${symbol}`);
}

function toRawAmount(symbol: string, decimals: number, usdValue: number, snapshot: Awaited<ReturnType<typeof getMarketPriceSnapshot>>["prices"]): BN {
  const priceUsd = symbolPriceUsd(symbol, snapshot);
  const raw = new Decimal(usdValue).div(priceUsd).mul(new Decimal(10).pow(decimals)).floor();
  const rawStr = raw.toFixed(0);
  const normalized = new BN(rawStr);
  return normalized.isZero() ? new BN(1) : normalized;
}

async function resolveOrcaPool(action: string): Promise<OrcaPoolSearchRow> {
  const query = extractPoolSearchQuery(action);
  const response = await fetch(`https://api.orca.so/v2/solana/pools/search?q=${encodeURIComponent(query)}&verifiedOnly=true&size=10`, {
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`orca pools search http ${response.status}`);
  }
  const data = (await response.json()) as OrcaPoolSearchResponse;
  const expectedPair = expectedPairFromAction(action);
  const rows = (data.data ?? []).filter((row) => row.poolType === "whirlpool");
  if (rows.length === 0) {
    throw new Error(`no Whirlpool pools found for ${action}`);
  }
  const matched = rows.filter((row) => {
    const a = normalizeLabel(row.tokenA?.symbol ?? "");
    const b = normalizeLabel(row.tokenB?.symbol ?? "");
    return (
      expectedPair.length === 0 ||
      (a === expectedPair[0] && b === expectedPair[1]) ||
      (a === expectedPair[1] && b === expectedPair[0])
    );
  });
  const candidates = matched.length > 0 ? matched : rows;
  candidates.sort((left, right) => Number((Number(right.tvlUsdc ?? "0") || 0) - (Number(left.tvlUsdc ?? "0") || 0)));
  const selected = candidates[0];
  if (!selected?.address) {
    throw new Error(`no valid Orca Whirlpool pool resolved for ${action}`);
  }
  return selected;
}

async function executeOrcaLiveAllocation(
  context: AdapterExecutionContext,
  allocationUsd: number,
  action: string
): Promise<{ txId: string }> {
  const rpcUrl = process.env.ORCA_SOLANA_RPC_URL?.trim() || getConfiguredSolanaRpcUrl() || "https://api.mainnet-beta.solana.com";
  const keypair = await loadSolanaExecutorKeypair();
  const wallet = new SolanaKeypairWallet(keypair);
  const connection = new Connection(rpcUrl, "confirmed");
  const ctx = WhirlpoolContext.from(connection, wallet as never);
  const client = buildWhirlpoolClient(ctx);

  const poolRow = await resolveOrcaPool(action);
  const pool = await client.getPool(new PublicKey(poolRow.address));
  const poolData = pool.getData();
  const [tickLower, tickUpper] = TickUtil.getFullRangeTickIndex(poolData.tickSpacing);
  const minSqrtPrice = PriceMath.tickIndexToSqrtPriceX64(tickLower);
  const maxSqrtPrice = PriceMath.tickIndexToSqrtPriceX64(tickUpper);
  const priceSnapshot = await getMarketPriceSnapshot();
  const halfUsd = allocationUsd / 2;
  const tokenA = poolRow.tokenA ?? {};
  const tokenB = poolRow.tokenB ?? {};
  const tokenMaxA = toRawAmount(tokenA.symbol ?? "tokenA", tokenA.decimals ?? 6, halfUsd, priceSnapshot.prices);
  const tokenMaxB = toRawAmount(tokenB.symbol ?? "tokenB", tokenB.decimals ?? 6, halfUsd, priceSnapshot.prices);

  const { tx } = await pool.openPosition(
    tickLower,
    tickUpper,
    {
      tokenMaxA,
      tokenMaxB,
      minSqrtPrice,
      maxSqrtPrice
    },
    wallet.publicKey,
    wallet.publicKey,
    undefined,
    undefined,
    true
  );

  const txId = await tx.buildAndExecute(undefined, undefined, "confirmed");
  return { txId };
}

const ORCA_ALLOC_TABLE: Record<string, { action: string; weight: number }[]> = {
  "Multi:multi-stable": [{ action: "USDC-USDT Whirlpool (0.01%)", weight: 0.2 }],
  "Multi:multi-balanced": [{ action: "mSOL-SOL Whirlpool", weight: 0.2 }],
  "Arbitrum:arb-stable": [],
  "Base:base-stable": [],
  "Solana:sol-stable": [
    { action: "USDC-USDT Whirlpool (0.01%)", weight: 0.4 },
    { action: "SOL-USDC Whirlpool", weight: 0.35 },
    { action: "mSOL-SOL Whirlpool", weight: 0.25 }
  ]
};

const ORCA_MULTI_FALLBACK: OrcaAlloc[] = [{ action: "USDC-USDT Whirlpool", weight: 0.2 }];

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const MSOL_MINT = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";

class KeypairWallet {
  public readonly publicKey: PublicKey;

  constructor(private readonly keypair: Keypair) {
    this.publicKey = keypair.publicKey;
  }

  async signTransaction<T extends { partialSign?: (...signers: Keypair[]) => void; sign?: (...signers: Keypair[]) => void }>(tx: T): Promise<T> {
    if (typeof tx.partialSign === "function") {
      tx.partialSign(this.keypair);
    } else if (typeof tx.sign === "function") {
      tx.sign(this.keypair);
    }
    return tx;
  }

  async signAllTransactions<T extends { partialSign?: (...signers: Keypair[]) => void; sign?: (...signers: Keypair[]) => void }>(txs: T[]): Promise<T[]> {
    txs.forEach((tx) => {
      if (typeof tx.partialSign === "function") {
        tx.partialSign(this.keypair);
      } else if (typeof tx.sign === "function") {
        tx.sign(this.keypair);
      }
    });
    return txs;
  }
}

type SolanaWalletBalances = {
  nativeSolLamports: bigint;
  tokenRawByMint: Map<string, bigint>;
};

function getLiveSolanaRpcCandidates(): string[] {
  const custom = [process.env.SOLANA_LIVE_RPC_URL, process.env.SOLANA_MAINNET_RPC_URL, process.env.VITE_SOLANA_MAINNET_RPC_URL]
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  const defaults = [
    "https://api.mainnet-beta.solana.com",
    "https://solana-mainnet.g.alchemy.com/v2/docs-demo",
    "https://docs-demo.solana-mainnet.quiknode.pro/",
    "https://solana-rpc.publicnode.com",
    "https://rpc.ankr.com/solana"
  ];
  return [...custom, ...defaults.filter((url) => !custom.includes(url))];
}

function mintPriceUsd(mint: string, prices: Awaited<ReturnType<typeof getMarketPriceSnapshot>>["prices"]): number {
  const lower = mint.toLowerCase();
  if (lower === USDC_MINT.toLowerCase() || lower === USDT_MINT.toLowerCase()) {
    return 1;
  }
  if (lower === SOL_MINT.toLowerCase() || lower === MSOL_MINT.toLowerCase()) {
    return prices.SOL ?? 0;
  }
  return prices.USDC ?? 1;
}

async function fetchSolanaWalletBalances(connection: Connection, owner: PublicKey): Promise<SolanaWalletBalances> {
  const [nativeSol, tokenAccounts] = await Promise.all([
    connection.getBalance(owner, "confirmed"),
    connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey("TokenkegQfeZyiNwAJNbNbGKPFXCWuBvf9Ss623VQ5DA") })
  ]);
  const tokenRawByMint = new Map<string, bigint>();
  for (const row of tokenAccounts.value) {
    const parsed = row.account.data.parsed as {
      info?: { mint?: string; tokenAmount?: { amount?: string } };
    };
    const mint = parsed.info?.mint;
    const amount = parsed.info?.tokenAmount?.amount;
    if (!mint || !amount) continue;
    const raw = BigInt(amount);
    tokenRawByMint.set(mint, (tokenRawByMint.get(mint) ?? 0n) + raw);
  }
  return {
    nativeSolLamports: BigInt(nativeSol),
    tokenRawByMint
  };
}

function availableRawForMint(balances: SolanaWalletBalances, mint: string): bigint {
  const lower = mint.toLowerCase();
  if (lower === SOL_MINT.toLowerCase()) {
    const wsolRaw = balances.tokenRawByMint.get(SOL_MINT) ?? 0n;
    return balances.nativeSolLamports + wsolRaw;
  }
  return balances.tokenRawByMint.get(mint) ?? 0n;
}

function assertQuoteAffordable(
  balances: SolanaWalletBalances,
  tokenAMint: string,
  tokenBMint: string,
  quote: { tokenMaxA: BN; tokenMaxB: BN }
): void {
  const needA = BigInt(quote.tokenMaxA.toString());
  const needB = BigInt(quote.tokenMaxB.toString());
  const haveA = availableRawForMint(balances, tokenAMint);
  const haveB = availableRawForMint(balances, tokenBMint);
  if (haveA < needA) {
    throw new Error(`Solana executor wallet lacks enough token A for Orca deposit: need=${needA.toString()} have=${haveA.toString()}`);
  }
  if (haveB < needB) {
    throw new Error(`Solana executor wallet lacks enough token B for Orca deposit: need=${needB.toString()} have=${haveB.toString()}`);
  }
}

async function createOrcaLiveClient(): Promise<{
  connection: Connection;
  wallet: KeypairWallet;
  client: ReturnType<typeof buildWhirlpoolClient>;
}> {
  const keypair = await loadSolanaExecutorKeypair();
  const rpcCandidates = getLiveSolanaRpcCandidates();
  let lastError = "";
  for (const rpcUrl of rpcCandidates) {
    try {
      const connection = new Connection(rpcUrl, { commitment: "confirmed" });
      const wallet = new KeypairWallet(keypair);
      const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
      const ctx = WhirlpoolContext.withProvider(provider, undefined, undefined, {
        accountResolverOptions: {
          createWrappedSolAccountMethod: "ata",
          allowPDAOwnerAddress: true
        }
      });
      const client = buildWhirlpoolClient(ctx);
      return { connection, wallet, client };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError || "failed to initialize Solana Orca client");
}

async function executeOrcaLiveAlloc(
  context: AdapterExecutionContext,
  allocationUsd: number,
  action: string,
  live: Awaited<ReturnType<typeof createOrcaLiveClient>>,
  priceSnapshot: Awaited<ReturnType<typeof getMarketPriceSnapshot>>
): Promise<AdapterExecutionResult | null> {
  const poolInfo = await resolveOrcaPoolForAction(action);
  const poolAddress = new PublicKey(poolInfo.address);
  const pool = await live.client.getPool(poolAddress);
  const tokenAInfo = pool.getTokenAInfo();
  const tokenBInfo = pool.getTokenBInfo();
  const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(
    live.client.getContext().fetcher,
    tokenAInfo.mint,
    tokenBInfo.mint
  );
  const [tickLower, tickUpper] = TickUtil.getFullRangeTickIndex(pool.getData().tickSpacing);
  const humanTokenAAmount = allocationUsd / Math.max(1, mintPriceUsd(tokenAInfo.mint.toBase58(), priceSnapshot.prices));
  const quote = increaseLiquidityQuoteByInputToken(
    tokenAInfo.mint,
    new Decimal(humanTokenAAmount),
    tickLower,
    tickUpper,
    Percentage.fromFraction(1, 100),
    pool,
    tokenExtensionCtx
  );

  const balances = await fetchSolanaWalletBalances(live.connection, live.wallet.publicKey);
  assertQuoteAffordable(balances, tokenAInfo.mint.toBase58(), tokenBInfo.mint.toBase58(), quote);

  const { tx } = await pool.openPositionWithMetadata(
    tickLower,
    tickUpper,
    quote,
    live.wallet.publicKey,
    live.wallet.publicKey,
    undefined,
    undefined,
    true
  );
  const txId = await tx.buildAndExecute();
  return {
    protocol: "Orca",
    chain: "Solana",
    action,
    allocationUsd: Number(allocationUsd.toFixed(2)),
    txId,
    status: "submitted"
  };
}

export async function executeOrcaPlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const network = context.productNetwork ?? "Multi";
  const subtype = context.productSubtype ?? "";
  const tableKey = `${network}:${subtype}`;
  const allocs = ORCA_ALLOC_TABLE[tableKey] ?? ORCA_MULTI_FALLBACK;
  if (allocs.length === 0) return [];

  if (context.mode !== "live") {
    return allocs.map((a) => ({
      protocol: "Orca" as const,
      chain: "Solana" as const,
      action: a.action,
      allocationUsd: Number((context.depositUsd * a.weight).toFixed(2)),
      txId: buildTxId("orca_sim", context),
      status: "simulated"
    }));
  }

  const live = await createOrcaLiveClient();
  const priceSnapshot = await getMarketPriceSnapshot();
  const results: AdapterExecutionResult[] = [];
  for (const alloc of allocs) {
    const allocationUsd = Number((context.depositUsd * alloc.weight).toFixed(2));
    try {
      const result = await executeOrcaLiveAlloc(context, allocationUsd, alloc.action, live, priceSnapshot);
      if (result) {
        results.push(result);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "orca_live_execution_skipped",
          action: alloc.action,
          jobId: context.jobId,
          error: message
        })
      );
    }
  }
  return results;
}
