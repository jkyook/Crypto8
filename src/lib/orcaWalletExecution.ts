import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { Percentage } from "@orca-so/common-sdk";
import {
  buildWhirlpoolClient,
  TickUtil,
  TokenExtensionUtil,
  WhirlpoolContext,
  increaseLiquidityQuoteByInputToken
} from "@orca-so/whirlpools-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";
import type { ISolanaChain } from "@phantom/chain-interfaces";
import { fetchMarketPrices, type AccountAssetSymbol, type ProductNetwork, type ProductSubtype } from "./api";
import { getSolanaRpcCandidates } from "./solanaChainAssets";
import { resolveOrcaPoolCandidatesForAction } from "./orcaPools";
import { executeJupiterExactInSwap } from "./solanaJupiterSwap";
import { waitForSolanaTxConfirmation } from "./solanaTxMonitor";
import {
  resolveSolanaSymbolForMint,
  resolveSolanaTokenDecimals,
  resolveSolanaTokenMint
} from "./solanaTokenMints";

export type OrcaClientExecutionResult = {
  protocol: "Orca";
  chain: "Solana";
  action: string;
  allocationUsd: number;
  txId: string;
  status: "submitted";
};

type OrcaAlloc = { action: string; weight: number };

const ORCA_ALLOC_TABLE: Record<string, OrcaAlloc[]> = {
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

function normalizeSolanaPublicKey(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const candidate = value as {
      toBase58?: () => string;
      toString?: () => string;
    };
    const base58 = candidate.toBase58?.();
    if (typeof base58 === "string" && base58.length > 0) return base58;
    const asString = candidate.toString?.();
    if (typeof asString === "string" && asString.length > 0 && asString !== "[object Object]") return asString;
  }
  return undefined;
}

function resolveWalletPublicKey(value: unknown): PublicKey {
  const normalized = normalizeSolanaPublicKey(value);
  if (!normalized) {
    throw new Error("Solana wallet is not connected");
  }
  return new PublicKey(normalized);
}

class PhantomWalletAdapter {
  constructor(private readonly solana: ISolanaChain) {}

  get publicKey(): PublicKey {
    const value = normalizeSolanaPublicKey(this.solana.publicKey);
    if (!value) {
      throw new Error("Solana wallet is not connected");
    }
    return new PublicKey(value);
  }

  async signTransaction(
    transaction: Parameters<ISolanaChain["signTransaction"]>[0]
  ): ReturnType<ISolanaChain["signTransaction"]> {
    return this.solana.signTransaction(transaction);
  }

  async signAllTransactions(
    transactions: Parameters<ISolanaChain["signAllTransactions"]>[0]
  ): ReturnType<ISolanaChain["signAllTransactions"]> {
    return this.solana.signAllTransactions(transactions);
  }
}

type SolanaLiquidityWallet = {
  publicKey: unknown;
  signTransaction(transaction: Parameters<ISolanaChain["signTransaction"]>[0]): ReturnType<ISolanaChain["signTransaction"]>;
};

type SolanaWalletBalances = {
  nativeSolLamports: bigint;
  tokenRawByMint: Map<string, bigint>;
};

function mintDecimals(mint: string): number {
  const symbol = resolveSolanaSymbolForMint(mint);
  if (!symbol) return 6;
  return resolveSolanaTokenDecimals(symbol);
}

function mintPriceUsd(mint: string, prices: Awaited<ReturnType<typeof fetchMarketPrices>>["prices"]): number {
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
    connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") })
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

function normalizeOrcaAction(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function orcaActionMatches(filter: string, allocAction: string): boolean {
  const f = normalizeOrcaAction(filter);
  const a = normalizeOrcaAction(allocAction);
  return (
    f === a ||
    a.includes(f) ||
    f.includes(a) ||
    a.includes("usdc-usdt") && f.includes("usdc-usdt") ||
    a.includes("sol-usdc") && f.includes("sol-usdc") ||
    a.includes("msol-sol") && f.includes("msol-sol")
  );
}

function rawToHuman(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** Math.max(0, decimals);
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
    throw new Error(`지갑에 토큰 A가 부족합니다. 필요=${needA.toString()} 보유=${haveA.toString()}`);
  }
  if (haveB < needB) {
    throw new Error(`지갑에 토큰 B가 부족합니다. 필요=${needB.toString()} 보유=${haveB.toString()}`);
  }
}

function sourceMintForAsset(sourceAsset: AccountAssetSymbol | undefined): string {
  return resolveSolanaTokenMint((sourceAsset ?? "USDC") as Extract<AccountAssetSymbol, "USDC" | "USDT" | "SOL" | "MSOL">);
}

function sourceDecimalsForAsset(sourceAsset: AccountAssetSymbol | undefined): number {
  return resolveSolanaTokenDecimals((sourceAsset ?? "USDC") as Extract<AccountAssetSymbol, "USDC" | "USDT" | "SOL" | "MSOL">);
}

async function topUpMissingMintViaJupiter(args: {
  sourceAsset: AccountAssetSymbol | undefined;
  balances: SolanaWalletBalances;
  connection: Connection;
  wallet: SolanaLiquidityWallet;
  targetMint: string;
  targetNeedRaw: bigint;
  priceSnapshot: Awaited<ReturnType<typeof fetchMarketPrices>>;
}): Promise<{ signature: string; amountRaw: bigint } | null> {
  const sourceMint = sourceMintForAsset(args.sourceAsset);
  const targetSymbol = resolveSolanaSymbolForMint(args.targetMint);
  if (!targetSymbol) {
    throw new Error(`unsupported Solana mint for Jupiter top-up: ${args.targetMint}`);
  }
  const targetDecimals = mintDecimals(args.targetMint);
  const sourceDecimals = sourceDecimalsForAsset(args.sourceAsset);
  const haveTarget = availableRawForMint(args.balances, args.targetMint);
  if (haveTarget >= args.targetNeedRaw) {
    return null;
  }
  if (sourceMint.toLowerCase() === args.targetMint.toLowerCase()) {
    throw new Error(`지갑에 ${targetSymbol}가 부족합니다.`);
  }

  const targetMissingRaw = args.targetNeedRaw - haveTarget;
  const targetMissingHuman = rawToHuman(targetMissingRaw, targetDecimals);
  const targetPrice = mintPriceUsd(args.targetMint, args.priceSnapshot.prices);
  const sourcePrice = mintPriceUsd(sourceMint, args.priceSnapshot.prices);
  if (sourcePrice <= 0) {
    throw new Error("source asset price unavailable");
  }
  const sourceNeededUsd = targetMissingHuman * Math.max(1, targetPrice) * 1.12;
  const sourceNeededRaw = BigInt(Math.max(1, Math.ceil((sourceNeededUsd / sourcePrice) * 10 ** sourceDecimals)));
  const availableSource = availableRawForMint(args.balances, sourceMint);
  if (availableSource < sourceNeededRaw) {
    throw new Error(
      `지갑에 ${sourceMint}가 부족합니다. 필요=${sourceNeededRaw.toString()} 보유=${availableSource.toString()}`
    );
  }

  const result = await executeJupiterExactInSwap({
    connection: args.connection,
    wallet: args.wallet,
    inputMint: sourceMint,
    outputMint: args.targetMint,
    amountRaw: sourceNeededRaw,
    slippageBps: 100,
    label: `${sourceMint}→${args.targetMint} top-up`
  });

  return { signature: result.signature, amountRaw: sourceNeededRaw };
}

async function ensureOrcaLiquidityInputs(args: {
  sourceAsset: AccountAssetSymbol | undefined;
  balances: SolanaWalletBalances;
  connection: Connection;
  wallet: SolanaLiquidityWallet;
  tokenA: { mint: PublicKey };
  tokenB: { mint: PublicKey };
  quote: { tokenMaxA: BN; tokenMaxB: BN };
  priceSnapshot: Awaited<ReturnType<typeof fetchMarketPrices>>;
}): Promise<{ balances: SolanaWalletBalances; prepTxIds: string[] }> {
  let balances = args.balances;
  const prepTxIds: string[] = [];
  const targetRows: Array<{ mint: string; needRaw: bigint }> = [
    { mint: args.tokenA.mint.toBase58(), needRaw: BigInt(args.quote.tokenMaxA.toString()) },
    { mint: args.tokenB.mint.toBase58(), needRaw: BigInt(args.quote.tokenMaxB.toString()) }
  ];

  for (const row of targetRows) {
    const have = availableRawForMint(balances, row.mint);
    if (have >= row.needRaw) {
      continue;
    }
    const topUp = await topUpMissingMintViaJupiter({
      sourceAsset: args.sourceAsset,
      balances,
      connection: args.connection,
      wallet: args.wallet,
      targetMint: row.mint,
      targetNeedRaw: row.needRaw,
      priceSnapshot: args.priceSnapshot
    });
    if (topUp) {
      prepTxIds.push(topUp.signature);
      balances = await fetchSolanaWalletBalances(args.connection, resolveWalletPublicKey(args.wallet.publicKey));
    }
  }

  return { balances, prepTxIds };
}

async function createOrcaWalletClient(
  solana: ISolanaChain,
  rpcCandidates: string[]
): Promise<{
  connection: Connection;
  client: ReturnType<typeof buildWhirlpoolClient>;
  wallet: PhantomWalletAdapter;
}> {
  const wallet = new PhantomWalletAdapter(solana);
  let lastError = "";
  for (const rpcUrl of rpcCandidates) {
    try {
      const connection = new Connection(rpcUrl, { commitment: "confirmed" });
      const provider = new AnchorProvider(connection, wallet as never, AnchorProvider.defaultOptions());
      const ctx = WhirlpoolContext.withProvider(provider, undefined, undefined, {
        accountResolverOptions: {
          createWrappedSolAccountMethod: "ata",
          allowPDAOwnerAddress: true
        }
      });
      const client = buildWhirlpoolClient(ctx);
      return { connection, client, wallet };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError || "failed to initialize Solana Orca client");
}

async function resolveOrcaPoolWithRpcFallback(args: {
  solana: ISolanaChain;
  rpcCandidates: string[];
  candidates: Awaited<ReturnType<typeof resolveOrcaPoolCandidatesForAction>>;
}): Promise<{
  live: Awaited<ReturnType<typeof createOrcaWalletClient>>;
  pool: Awaited<ReturnType<ReturnType<typeof buildWhirlpoolClient>["getPool"]>>;
  poolAddress: PublicKey;
}> {
  const errors: string[] = [];
  for (const rpcUrl of args.rpcCandidates) {
    try {
      const live = await createOrcaWalletClient(args.solana, [rpcUrl]);
      for (const candidate of args.candidates) {
        try {
          const poolAddress = new PublicKey(candidate.address);
          const pool = await live.client.getPool(poolAddress);
          return { live, pool, poolAddress };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`[${rpcUrl}] ${candidate.address}: ${message}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`[${rpcUrl}] client init failed: ${message}`);
    }
  }
  throw new Error(errors[0] ?? "no usable Orca pool candidate across RPC fallbacks");
}

export async function executeOrcaPlanWithWallet(input: {
  solana: ISolanaChain;
  depositUsd: number;
  productNetwork?: ProductNetwork;
  productSubtype?: ProductSubtype;
  network: "mainnet" | "devnet";
  sourceAsset?: AccountAssetSymbol;
  sourceChain?: string;
  actionFilter?: string[];
  /** true(기본)이면 각 tx 가 네트워크에서 confirmed 될 때까지 폴링 후 반환. */
  waitForConfirmation?: boolean;
  /** 컨펌 폴링 타임아웃(ms). 기본 90초. */
  confirmTimeoutMs?: number;
}): Promise<OrcaClientExecutionResult[]> {
  if (!normalizeSolanaPublicKey(input.solana.publicKey)) {
    throw new Error("Solana 지갑이 연결되어 있지 않습니다.");
  }
  if (input.sourceChain && input.sourceChain !== "Solana") {
    throw new Error("REAL-RUN Orca 실행은 Solana 지갑의 실자산만 사용할 수 있습니다.");
  }

  const tableKey = `${input.productNetwork ?? "Multi"}:${input.productSubtype ?? ""}`;
  const allocs = (ORCA_ALLOC_TABLE[tableKey] ?? ORCA_MULTI_FALLBACK).filter((alloc) =>
    !input.actionFilter || input.actionFilter.length === 0
      ? true
      : input.actionFilter.some((filter) => orcaActionMatches(filter, alloc.action))
  );
  if (allocs.length === 0) {
    const available = (ORCA_ALLOC_TABLE[tableKey] ?? ORCA_MULTI_FALLBACK).map((alloc) => alloc.action).join(", ");
    throw new Error(
      input.actionFilter && input.actionFilter.length > 0
        ? `No Orca allocation matched actionFilter=${input.actionFilter.join(", ")} (available: ${available})`
        : `No Orca allocation configured for ${tableKey}`
    );
  }

  const rpcCandidates = getSolanaRpcCandidates(input.network, input.network !== "devnet");
  const priceSnapshot = await fetchMarketPrices();

  const results: OrcaClientExecutionResult[] = [];
  for (const alloc of allocs) {
    const allocationUsd = Number((input.depositUsd * alloc.weight).toFixed(2));
    try {
      const candidates = await resolveOrcaPoolCandidatesForAction(alloc.action, input.network);
      const { live, pool } = await resolveOrcaPoolWithRpcFallback({
        solana: input.solana,
        rpcCandidates,
        candidates
      });
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
      const walletPublicKey = resolveWalletPublicKey(live.wallet.publicKey);
      let balances = await fetchSolanaWalletBalances(live.connection, walletPublicKey);
      const liquidityPrep = await ensureOrcaLiquidityInputs({
        sourceAsset: input.sourceAsset,
        balances,
        connection: live.connection,
        wallet: live.wallet,
        tokenA: tokenAInfo,
        tokenB: tokenBInfo,
        quote,
        priceSnapshot
      });
      balances = liquidityPrep.balances;
      assertQuoteAffordable(balances, tokenAInfo.mint.toBase58(), tokenBInfo.mint.toBase58(), quote);
      const { tx } = await pool.openPositionWithMetadata(
        tickLower,
        tickUpper,
        quote as any,
        walletPublicKey,
        walletPublicKey,
        undefined,
        undefined,
        true
      );
      const signature = await tx.buildAndExecute();
      const shouldWait = input.waitForConfirmation !== false;
      if (shouldWait) {
        const confirm = await waitForSolanaTxConfirmation({
          signature,
          rpcCandidates,
          target: "confirmed",
          timeoutMs: input.confirmTimeoutMs ?? 90_000
        });
        if (confirm.error && !confirm.timedOut) {
          throw new Error(`Orca tx 실패(${alloc.action}): ${confirm.error}`);
        }
      }
      results.push({
        protocol: "Orca",
        chain: "Solana",
        action: alloc.action,
        allocationUsd,
        txId: signature,
        status: "submitted"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Orca 직접 실행 실패 (${alloc.action}): ${message}`);
    }
  }
  return results;
}
