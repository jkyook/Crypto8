/**
 * Orca Whirlpool adapter — Solana chain.
 *
 * live 실행은 Orca Whirlpools SDK(@orca-so/whirlpools-sdk)를 사용한다.
 * - Whirlpool 검색은 Orca Public API를 사용
 * - 실제 트랜잭션 제출은 서버의 Solana executor keypair를 사용
 * - 기본적으로 mainnet pool을 대상으로 하며, devnet은 별도 구성 시 확장 가능
 */
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { PriceMath, TickUtil, WhirlpoolContext, buildWhirlpoolClient } from "@orca-so/whirlpools-sdk";
import Decimal from "decimal.js";
import BN from "bn.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";
import { buildUnsupportedResult, isAdapterLiveEnabled } from "./types";
import { getMarketPriceSnapshot } from "../marketPricing";
import { loadSolanaExecutorKeypair } from "../secrets";

type OrcaPoolSearchToken = {
  symbol?: string;
  decimals?: number;
};

type OrcaPoolSearchRow = {
  address: string;
  poolType?: string;
  feeRate?: number;
  tvlUsdc?: string;
  tokenA?: OrcaPoolSearchToken;
  tokenB?: OrcaPoolSearchToken;
};

type OrcaPoolSearchResponse = {
  data?: OrcaPoolSearchRow[];
  meta?: {
    next?: string | null;
  };
};

class SolanaKeypairWallet {
  constructor(private readonly keypair: Keypair) {}

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof VersionedTransaction) {
      tx.sign([this.keypair]);
      return tx;
    }
    tx.partialSign(this.keypair);
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    return Promise.all(txs.map((tx) => this.signTransaction(tx)));
  }
}

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
  const rpcUrl = process.env.ORCA_SOLANA_RPC_URL?.trim() || process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
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

const ORCA_MULTI_FALLBACK = [{ action: "USDC-USDT Whirlpool", weight: 0.2 }];

export async function executeOrcaPlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const network = context.productNetwork ?? "Multi";
  const subtype = context.productSubtype ?? "";
  const tableKey = `${network}:${subtype}`;
  const allocs = ORCA_ALLOC_TABLE[tableKey] ?? ORCA_MULTI_FALLBACK;

  if (allocs.length === 0) return [];

  if (context.mode === "dry-run") {
    return allocs.map((alloc) => ({
      protocol: "Orca" as const,
      chain: "Solana" as const,
      action: alloc.action,
      allocationUsd: Number((context.depositUsd * alloc.weight).toFixed(2)),
      txId: buildTxId("orca_sim", context),
      status: "dry-run" as const
    }));
  }

  if (!isAdapterLiveEnabled("Orca")) {
    return allocs.map((alloc) =>
      buildUnsupportedResult(
        {
          protocol: "Orca",
          chain: "Solana",
          action: alloc.action,
          allocationUsd: Number((context.depositUsd * alloc.weight).toFixed(2))
        },
        "Orca live execution requires ENABLE_ORCA_LIVE=true + LIVE_EXECUTION_CONFIRM=YES + SOLANA_EXECUTOR_PRIVATE_KEY_FILE"
      )
    );
  }

  const results: AdapterExecutionResult[] = [];
  for (const alloc of allocs) {
    const allocationUsd = Number((context.depositUsd * alloc.weight).toFixed(2));
    try {
      const { txId } = await executeOrcaLiveAllocation(context, allocationUsd, alloc.action);
      results.push({
        protocol: "Orca",
        chain: "Solana",
        action: alloc.action,
        allocationUsd,
        txId,
        status: "confirmed"
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({
        protocol: "Orca",
        chain: "Solana",
        action: alloc.action,
        allocationUsd,
        txId: "",
        status: "failed",
        errorMessage: `Orca/${alloc.action}: ${msg}`
      });
    }
  }

  return results;
}
