/**
 * positionVerifier.ts
 *
 * DB에 저장된 Position 레코드를 온체인 실데이터와 대조하는 검증 서비스.
 *
 * ── 검증 상태 ────────────────────────────────────────────────────────────────
 *   verified       : 온체인 잔고가 DB 값과 일치 (±5% 허용)
 *   drift          : 온체인 잔고가 DB 값과 5% 이상 차이 (부분 출금, 이자 등)
 *   closed_onchain : 온체인 잔고 = 0 이지만 DB는 active 상태 (외부 출금 감지)
 *   rpc_error      : RPC 호출 실패 — "잔고 없음"이 아닌 "조회 불가" 상태
 *   unsupported    : 해당 프로토콜의 온체인 조회 어댑터 미구현
 *
 * ── 원칙 ─────────────────────────────────────────────────────────────────────
 *   - RPC 실패 시 절대 포지션을 closed 처리하지 않는다.
 *   - 조회 성공 시 positions.onchain_data_json / last_synced_at 갱신.
 *   - 지갑 주소는 positions 테이블에 없으므로 aave_usdc_positions / 파라미터로 보완.
 */

import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Address,
  type Chain
} from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { PublicKey, Connection } from "@solana/web3.js";
import { PoolUtil, PriceMath, WhirlpoolContext, buildWhirlpoolClient, getAllPositionAccountsByOwner } from "@orca-so/whirlpools-sdk";
import Decimal from "decimal.js";
import type { PositionRow } from "./intentStore";
import { listPositionsByUser, updatePositionAccountingFromSync } from "./intentStore";
import { getDb } from "./db";
import { getMarketPriceSnapshot } from "./marketPricing";
import { listUserWallets } from "./userWallets";

// ──────────────────────────────────────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────────────────────────────────────

export type OnchainVerifyStatus =
  | "verified"        // DB ≈ 온체인 (±5%)
  | "drift"           // DB vs 온체인 5% 이상 차이
  | "closed_onchain"  // 온체인 잔고 0, DB는 active
  | "rpc_error"       // RPC 호출 실패 — 조회 불가
  | "unsupported";    // 프로토콜 조회 미구현

export type OrcaWalletPositionSnapshot = {
  positionMint: string;
  whirlpool: string;
  liquidity: string;
  tickLowerIndex: number;
  tickUpperIndex: number;
  tokenMintA: string;
  tokenMintB: string;
  tokenSymbolA: string;
  tokenSymbolB: string;
  tokenDecimalsA: number;
  tokenDecimalsB: number;
  amountUsd: number;
};

export type PositionVerifyResult = {
  positionId: string;
  protocol: string;
  chain: string;
  dbAmountUsd: number;
  /** 온체인에서 읽은 실제 잔고 (USD 환산, 조회 실패 시 null) */
  onchainAmountUsd: number | null;
  /** 온체인 원시 잔고 (예: aToken raw bigint string) */
  onchainRaw: string | null;
  status: OnchainVerifyStatus;
  /** 상태 상세 설명 */
  detail: string;
  /** DB 대비 온체인 차이율 (조회 성공 시만) */
  driftPct: number | null;
  /** 검증 수행 시각 */
  verifiedAt: string;
  /** 지갑 주소 (검증에 사용된 주소) */
  walletAddress: string | null;
};

// ──────────────────────────────────────────────────────────────────────────────
//  EVM 체인 설정
// ──────────────────────────────────────────────────────────────────────────────

type EvmChainConfig = {
  viemChain: Chain;
  envKeys: string[];
  fallbackRpcs: string[];
  /** Aave V3 Pool 주소 */
  aavePool: Address;
  /** USDC 주소 */
  usdc: Address;
};

const EVM_CHAIN_CONFIG: Record<string, EvmChainConfig> = {
  Arbitrum: {
    viemChain: arbitrum,
    envKeys: ["ARBITRUM_RPC_URL"],
    fallbackRpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://rpc.ankr.com/arbitrum"],
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
  },
  Base: {
    viemChain: base,
    envKeys: ["BASE_RPC_URL"],
    fallbackRpcs: ["https://base-rpc.publicnode.com", "https://rpc.ankr.com/base"],
    aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  },
  Ethereum: {
    viemChain: mainnet,
    envKeys: ["ETHEREUM_RPC_URL"],
    fallbackRpcs: ["https://ethereum-rpc.publicnode.com", "https://rpc.ankr.com/eth"],
    aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
  }
};

const erc20BalanceAbi = [
  {
    type: "function", name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  }
] as const;

const aavePoolAbi = [
  {
    type: "function", name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{
      name: "", type: "tuple",
      components: [
        { name: "configuration", type: "uint256" },
        { name: "liquidityIndex", type: "uint128" },
        { name: "currentLiquidityRate", type: "uint128" },
        { name: "variableBorrowIndex", type: "uint128" },
        { name: "currentVariableBorrowRate", type: "uint128" },
        { name: "currentStableBorrowRate", type: "uint128" },
        { name: "lastUpdateTimestamp", type: "uint40" },
        { name: "id", type: "uint16" },
        { name: "aTokenAddress", type: "address" },
        { name: "stableDebtTokenAddress", type: "address" },
        { name: "variableDebtTokenAddress", type: "address" },
        { name: "interestRateStrategyAddress", type: "address" },
        { name: "accruedToTreasury", type: "uint128" },
        { name: "unbacked", type: "uint128" },
        { name: "isolationModeTotalDebt", type: "uint128" }
      ]
    }]
  }
] as const;

// ──────────────────────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────────────────────

function getRpcUrl(chain: string): string | null {
  const config = EVM_CHAIN_CONFIG[chain];
  if (!config) return null;
  const envUrl = config.envKeys.map(k => process.env[k]?.trim()).find(Boolean);
  return envUrl ?? config.fallbackRpcs[0] ?? null;
}

function getEvmClient(chain: string): ReturnType<typeof createPublicClient> | null {
  const rpcUrl = getRpcUrl(chain);
  const config = EVM_CHAIN_CONFIG[chain];
  if (!rpcUrl || !config) return null;
  return createPublicClient({
    chain: config.viemChain,
    transport: http(rpcUrl, { timeout: 10_000 })
  });
}

/**
 * DB position 레코드에서 지갑 주소를 조회.
 * positions 테이블에는 wallet_address 컬럼이 없으므로:
 * 1. aave_usdc_positions (depositTxHash 매칭)
 * 2. 파라미터로 주어진 walletAddress
 * 순으로 찾는다.
 */
async function resolveWalletAddress(
  position: PositionRow,
  walletAddress?: string
): Promise<string | null> {
  if (walletAddress && isAddress(walletAddress)) {
    return getAddress(walletAddress);
  }
  if (position.protocol === "Aave" && position.depositTxHash) {
    const db = getDb();
    const rows = await db.$queryRawUnsafe<Array<{ wallet_address: string }>>(
      `SELECT wallet_address FROM aave_usdc_positions WHERE deposit_tx_hash = ? LIMIT 1`,
      position.depositTxHash
    );
    if (rows.length > 0) return rows[0].wallet_address;
  }
  return null;
}

function calcDriftPct(dbAmount: number, onchainAmount: number): number {
  if (dbAmount === 0) return onchainAmount === 0 ? 0 : 100;
  return Math.abs((onchainAmount - dbAmount) / dbAmount) * 100;
}

function normalizeKey(value?: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function getOrcaRpcCandidates(): string[] {
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

class ReadonlyWallet {
  public readonly publicKey: PublicKey;

  constructor(publicKey: PublicKey) {
    this.publicKey = publicKey;
  }

  async signTransaction<T>(tx: T): Promise<T> {
    return tx;
  }

  async signAllTransactions<T>(txs: T[]): Promise<T[]> {
    return txs;
  }
}

async function createOrcaReadClient(ownerWalletAddress: string): Promise<{
  client: ReturnType<typeof buildWhirlpoolClient>;
  owner: PublicKey;
}> {
  const owner = new PublicKey(ownerWalletAddress);
  const wallet = new ReadonlyWallet(owner);
  let lastError = "";
  for (const rpcUrl of getOrcaRpcCandidates()) {
    try {
      const connection = new Connection(rpcUrl, { commitment: "confirmed" });
      const ctx = WhirlpoolContext.from(connection, wallet as never);
      const client = buildWhirlpoolClient(ctx);
      return { client, owner };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError || "failed to initialize Orca read client");
}

function mintPriceUsd(mint: string, prices: Awaited<ReturnType<typeof getMarketPriceSnapshot>>["prices"]): number {
  const key = mint.toLowerCase();
  const solMint = "so11111111111111111111111111111111111111112";
  const usdcMint = "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwyt1v";
  const usdtMint = "es9vmfrzacermjfrf4h2fyd4kcornk11mccce8benwnyb";
  const msolMint = "msolzychxdygdzu16g5qsh3i5k3z3kzk7ytfqcjm7so";
  if (key === usdcMint || key === usdtMint) return 1;
  if (key === solMint || key === msolMint) return prices.SOL ?? 0;
  return 0;
}

function estimateOrcaPositionUsd(
  liquidity: unknown,
  whirlpoolData: { sqrtPrice: unknown; tickCurrentIndex: number },
  tickLowerIndex: number,
  tickUpperIndex: number,
  tokenMintA: string,
  tokenMintB: string,
  tokenDecimalsA: number,
  tokenDecimalsB: number,
  prices: Awaited<ReturnType<typeof getMarketPriceSnapshot>>["prices"]
): number {
  try {
    const tokenAmounts = PoolUtil.getTokenAmountsFromLiquidity(
      liquidity as never,
      whirlpoolData.sqrtPrice as never,
      PriceMath.tickIndexToSqrtPriceX64(tickLowerIndex),
      PriceMath.tickIndexToSqrtPriceX64(tickUpperIndex),
      false
    );
    const amountA = new Decimal(tokenAmounts.tokenA.toString()).div(new Decimal(10).pow(tokenDecimalsA));
    const amountB = new Decimal(tokenAmounts.tokenB.toString()).div(new Decimal(10).pow(tokenDecimalsB));
    const valueA = amountA.mul(mintPriceUsd(tokenMintA, prices));
    const valueB = amountB.mul(mintPriceUsd(tokenMintB, prices));
    return Number(valueA.plus(valueB).toFixed(2));
  } catch {
    return 0;
  }
}

export async function scanOrcaWalletPositions(walletAddress: string): Promise<OrcaWalletPositionSnapshot[]> {
  const { client, owner } = await createOrcaReadClient(walletAddress);
  const positionMap = await getAllPositionAccountsByOwner({
    ctx: client.getContext(),
    owner,
    includesPositions: true,
    includesPositionsWithTokenExtensions: true,
    includesBundledPositions: false
  });
  const priceSnapshot = await getMarketPriceSnapshot();
  const merged = new Map<string, { position: { whirlpool: PublicKey; positionMint: PublicKey; liquidity: unknown; tickLowerIndex: number; tickUpperIndex: number }; withExtension?: boolean }>();

  for (const [address, position] of positionMap.positions.entries()) {
    merged.set(address, { position });
  }
  for (const [address, position] of positionMap.positionsWithTokenExtensions.entries()) {
    merged.set(address, { position, withExtension: true });
  }

  const snapshots: OrcaWalletPositionSnapshot[] = [];
  for (const [address, entry] of merged.entries()) {
    try {
      const pool = await client.getPool(entry.position.whirlpool);
      const poolData = pool.getData();
      const tokenAInfo = pool.getTokenAInfo();
      const tokenBInfo = pool.getTokenBInfo();
      const amountUsd = estimateOrcaPositionUsd(
        entry.position.liquidity,
        poolData,
        entry.position.tickLowerIndex,
        entry.position.tickUpperIndex,
        tokenAInfo.mint.toBase58(),
        tokenBInfo.mint.toBase58(),
        tokenAInfo.decimals,
        tokenBInfo.decimals,
        priceSnapshot.prices
      );
      snapshots.push({
        positionMint: entry.position.positionMint.toBase58(),
        whirlpool: entry.position.whirlpool.toBase58(),
        liquidity: String(entry.position.liquidity),
        tickLowerIndex: entry.position.tickLowerIndex,
        tickUpperIndex: entry.position.tickUpperIndex,
        tokenMintA: tokenAInfo.mint.toBase58(),
        tokenMintB: tokenBInfo.mint.toBase58(),
        tokenSymbolA: tokenAInfo.symbol ?? "tokenA",
        tokenSymbolB: tokenBInfo.symbol ?? "tokenB",
        tokenDecimalsA: tokenAInfo.decimals,
        tokenDecimalsB: tokenBInfo.decimals,
        amountUsd
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "orca_position_scan_failed",
          walletAddress,
          positionAddress: address,
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }
  return snapshots;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Protocol-specific verifiers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Aave V3 USDC 포지션 온체인 검증.
 * aToken.balanceOf(walletAddress) 를 조회해 DB 금액과 비교.
 */
async function verifyAavePosition(
  position: PositionRow,
  walletAddress: string
): Promise<Omit<PositionVerifyResult, "positionId" | "protocol" | "chain" | "dbAmountUsd" | "verifiedAt" | "walletAddress">> {
  const config = EVM_CHAIN_CONFIG[position.chain];
  if (!config) {
    return {
      onchainAmountUsd: null, onchainRaw: null,
      status: "unsupported",
      detail: `Aave 온체인 검증 미지원 체인: ${position.chain}`,
      driftPct: null
    };
  }

  const client = getEvmClient(position.chain);
  if (!client) {
    return {
      onchainAmountUsd: null, onchainRaw: null,
      status: "rpc_error",
      detail: `RPC URL 미설정: ${config.envKeys[0]} 환경변수를 확인하세요`,
      driftPct: null
    };
  }

  try {
    const wallet = getAddress(walletAddress) as Address;

    // aToken 주소 결정: DB에 저장된 positionToken 우선, 없으면 getReserveData로 조회
    let aTokenAddress: Address;
    if (position.positionToken && isAddress(position.positionToken)) {
      aTokenAddress = getAddress(position.positionToken) as Address;
    } else {
      const reserve = await client.readContract({
        address: config.aavePool,
        abi: aavePoolAbi,
        functionName: "getReserveData",
        args: [config.usdc]
      });
      aTokenAddress = getAddress(reserve.aTokenAddress) as Address;
    }

    // aToken 잔고 조회 (USDC 1:1이므로 USD 환산 = amount / 1e6)
    const rawBalance = await client.readContract({
      address: aTokenAddress,
      abi: erc20BalanceAbi,
      functionName: "balanceOf",
      args: [wallet]
    });

    const onchainAmountUsd = Number(formatUnits(rawBalance, 6));
    const onchainRaw = rawBalance.toString();
    const driftPct = calcDriftPct(position.amountUsd, onchainAmountUsd);

    if (onchainAmountUsd === 0 && position.amountUsd > 0.01) {
      return {
        onchainAmountUsd, onchainRaw,
        status: "closed_onchain",
        detail: `온체인 aUSDC 잔고 0 — DB에는 $${position.amountUsd.toFixed(2)} 기록. 외부에서 출금됐을 수 있습니다.`,
        driftPct: 100
      };
    }

    if (driftPct > 5) {
      return {
        onchainAmountUsd, onchainRaw,
        status: "drift",
        detail: `DB $${position.amountUsd.toFixed(2)} vs 온체인 $${onchainAmountUsd.toFixed(2)} (${driftPct.toFixed(1)}% 차이). 이자 누적 또는 부분 출금일 수 있습니다.`,
        driftPct
      };
    }

    return {
      onchainAmountUsd, onchainRaw,
      status: "verified",
      detail: `온체인 확인 완료: aUSDC ${onchainAmountUsd.toFixed(6)} (DB 대비 ${driftPct.toFixed(2)}% 차이)`,
      driftPct
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      onchainAmountUsd: null, onchainRaw: null,
      status: "rpc_error",
      detail: `Aave/${position.chain} RPC 오류: ${msg}`,
      driftPct: null
    };
  }
}

/**
 * 현재 미구현 프로토콜에 대한 unsupported 결과 반환.
 */
function unsupportedResult(
  protocol: string,
  chain: string
): Omit<PositionVerifyResult, "positionId" | "protocol" | "chain" | "dbAmountUsd" | "verifiedAt" | "walletAddress"> {
  const roadmap: Record<string, string> = {
    Uniswap: "NonfungiblePositionManager.positions(tokenId) 조회 구현 예정",
    Orca: "Whirlpools SDK position PDA 조회 및 지갑 스캔 매칭 구현 완료",
    Aerodrome: "gauge/LP token balance 조회 구현 예정",
    Raydium: "LP/position account 조회 구현 예정",
    Curve: "LP token balanceOf 조회 구현 예정"
  };
  return {
    onchainAmountUsd: null, onchainRaw: null,
    status: "unsupported",
    detail: roadmap[protocol] ?? `${protocol}/${chain} 온체인 조회 어댑터 미구현`,
    driftPct: null
  };
}

function matchesOrcaSnapshot(position: PositionRow, snapshot: OrcaWalletPositionSnapshot): boolean {
  const positionKeys = [position.poolAddress, position.positionToken, position.protocolPositionId].map(normalizeKey).filter(Boolean);
  const snapshotKeys = [snapshot.whirlpool, snapshot.positionMint].map(normalizeKey);
  return positionKeys.some((key) => snapshotKeys.includes(key));
}

async function verifyOrcaPosition(
  position: PositionRow,
  walletAddress: string
): Promise<Omit<PositionVerifyResult, "positionId" | "protocol" | "chain" | "dbAmountUsd" | "verifiedAt" | "walletAddress">> {
  try {
    const snapshots = await scanOrcaWalletPositions(walletAddress);
    const matched = snapshots.find((snapshot) => matchesOrcaSnapshot(position, snapshot));

    if (!matched) {
      if (snapshots.length === 0) {
        return {
          onchainAmountUsd: null,
          onchainRaw: null,
          status: "closed_onchain",
          detail: "Orca Whirlpool 포지션이 현재 지갑에서 발견되지 않았습니다.",
          driftPct: null
        };
      }
      return {
        onchainAmountUsd: null,
        onchainRaw: null,
        status: "unsupported",
        detail: `Orca 포지션은 지갑에서 스캔했지만 DB 행과 정확히 매칭되지 않았습니다. 지갑에 ${snapshots.length}개 포지션이 있습니다.`,
        driftPct: null
      };
    }

    const onchainAmountUsd = matched.amountUsd;
    const driftPct = calcDriftPct(position.amountUsd, onchainAmountUsd);

    if (onchainAmountUsd === 0 && position.amountUsd > 0.01) {
      return {
        onchainAmountUsd,
        onchainRaw: matched.liquidity,
        status: "closed_onchain",
        detail: `온체인 Orca 포지션 잔고 0 — DB에는 $${position.amountUsd.toFixed(2)} 기록. 외부에서 출금됐을 수 있습니다.`,
        driftPct: 100
      };
    }

    if (driftPct > 5) {
      return {
        onchainAmountUsd,
        onchainRaw: matched.liquidity,
        status: "drift",
        detail: `DB $${position.amountUsd.toFixed(2)} vs 온체인 $${onchainAmountUsd.toFixed(2)} (${driftPct.toFixed(1)}% 차이). Orca 포지션이 일부 이동됐을 수 있습니다.`,
        driftPct
      };
    }

    return {
      onchainAmountUsd,
      onchainRaw: matched.liquidity,
      status: "verified",
      detail: `Orca 지갑 스캔 확인 완료: position ${matched.positionMint} / whirlpool ${matched.whirlpool}`,
      driftPct
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      onchainAmountUsd: null,
      onchainRaw: null,
      status: "rpc_error",
      detail: `Orca/${position.chain} RPC 오류: ${msg}`,
      driftPct: null
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 단일 포지션 온체인 검증.
 * walletAddress 미전달 시 aave_usdc_positions 에서 자동 조회.
 */
export async function verifyPosition(
  position: PositionRow,
  walletAddress?: string
): Promise<PositionVerifyResult> {
  const verifiedAt = new Date().toISOString();
  const resolvedWallet = await resolveWalletAddress(position, walletAddress);

  const base_: Pick<PositionVerifyResult, "positionId" | "protocol" | "chain" | "dbAmountUsd" | "verifiedAt" | "walletAddress"> = {
    positionId: position.id,
    protocol: position.protocol,
    chain: position.chain,
    dbAmountUsd: position.amountUsd,
    verifiedAt,
    walletAddress: resolvedWallet
  };

  // 지갑 주소 없으면 검증 불가
  if (!resolvedWallet) {
    const result: PositionVerifyResult = {
      ...base_,
      onchainAmountUsd: null, onchainRaw: null,
      status: "rpc_error",
      detail: "지갑 주소를 알 수 없습니다. walletAddress 파라미터를 전달하세요.",
      driftPct: null
    };
    return result;
  }

  let partial: Omit<PositionVerifyResult, "positionId" | "protocol" | "chain" | "dbAmountUsd" | "verifiedAt" | "walletAddress">;

  switch (position.protocol) {
    case "Aave":
      partial = await verifyAavePosition(position, resolvedWallet);
      break;
    case "Orca":
      partial = await verifyOrcaPosition(position, resolvedWallet);
      break;
    default:
      partial = unsupportedResult(position.protocol, position.chain);
  }

  const result: PositionVerifyResult = { ...base_, ...partial };

  // 조회 성공(verified/drift/closed_onchain) 시 DB 갱신
  if (result.status !== "rpc_error" && result.status !== "unsupported") {
    await persistVerifyResult(position.id, result);
  }

  return result;
}

/**
 * 사용자의 모든 active 포지션을 일괄 검증.
 * 각 포지션은 독립적으로 처리 (하나 실패해도 나머지 계속).
 */
export async function verifyAllPositions(
  positions: PositionRow[],
  walletAddressMap?: Record<string, string>
): Promise<PositionVerifyResult[]> {
  const results = await Promise.allSettled(
    positions.map((pos) =>
      verifyPosition(pos, walletAddressMap?.[pos.id] ?? walletAddressMap?.["*"])
    )
  );

  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const pos = positions[i];
    return {
      positionId: pos.id,
      protocol: pos.protocol,
      chain: pos.chain,
      dbAmountUsd: pos.amountUsd,
      onchainAmountUsd: null,
      onchainRaw: null,
      status: "rpc_error" as const,
      detail: r.reason instanceof Error ? r.reason.message : String(r.reason),
      driftPct: null,
      verifiedAt: new Date().toISOString(),
      walletAddress: null
    };
  });
}

/**
 * 검증 결과를 positions 테이블에 저장.
 * closed_onchain이면 status를 "closed"로 갱신.
 */
async function persistVerifyResult(
  positionId: string,
  result: PositionVerifyResult
): Promise<void> {
  const db = getDb();
  const now = result.verifiedAt;
  const onchainData = JSON.stringify({
    status: result.status,
    onchainAmountUsd: result.onchainAmountUsd,
    onchainRaw: result.onchainRaw,
    driftPct: result.driftPct,
    detail: result.detail,
    verifiedAt: now,
    walletAddress: result.walletAddress
  });

  if (result.status === "closed_onchain") {
    await db.$executeRawUnsafe(
      `UPDATE positions
       SET onchain_data_json = ?, last_synced_at = ?, status = 'closed', closed_at = ?
       WHERE id = ?`,
      onchainData, now, now, positionId
    );
  } else {
    await db.$executeRawUnsafe(
      `UPDATE positions SET onchain_data_json = ?, last_synced_at = ? WHERE id = ?`,
      onchainData, now, positionId
    );
    // 온체인 평가금액이 있으면 회계 필드 갱신
    if (result.onchainAmountUsd !== null && result.status !== "rpc_error") {
      await updatePositionAccountingFromSync(positionId, result.onchainAmountUsd);
    }
  }
}

/**
 * 스테일 여부 판단 — lastSyncedAt 기준 지정 분(기본 5분) 초과 시 재검증 필요.
 */
export function isPositionStale(
  position: PositionRow,
  thresholdMinutes = 5
): boolean {
  if (!position.lastSyncedAt) return true;
  const age = Date.now() - new Date(position.lastSyncedAt).getTime();
  return age > thresholdMinutes * 60 * 1000;
}

/**
 * 포지션 목록에 온체인 데이터를 합쳐서 반환.
 * 스테일하지 않으면 캐시된 onchainDataJson 사용.
 */
export async function enrichPositionsWithOnchain(
  positions: PositionRow[],
  walletAddress?: string,
  forceRefresh = false
): Promise<Array<PositionRow & { verify: PositionVerifyResult | null }>> {
  return Promise.all(
    positions.map(async (pos) => {
      // 캐시 유효하면 DB에 저장된 값 재사용
      if (!forceRefresh && !isPositionStale(pos) && pos.onchainDataJson) {
        try {
          const cached = JSON.parse(pos.onchainDataJson) as PositionVerifyResult;
          return { ...pos, verify: cached };
        } catch {
          // 파싱 실패 시 재조회
        }
      }
      const verify = await verifyPosition(pos, walletAddress);
      return { ...pos, verify };
    })
  );
}

function buildWalletAddressMap(
  wallets: Array<{ walletAddress: string; chain: string }>,
  positions: PositionRow[]
): Record<string, string> {
  const byChain = new Map<string, string>();
  for (const wallet of wallets) {
    const chainKey = wallet.chain.toLowerCase();
    if (!byChain.has(chainKey)) {
      byChain.set(chainKey, wallet.walletAddress);
    }
  }
  const fallback = wallets[0]?.walletAddress ?? "";
  const map: Record<string, string> = {};
  for (const pos of positions) {
    const chainKey = pos.chain.toLowerCase();
    map[pos.id] = byChain.get(chainKey) ?? (pos.protocol === "Orca" ? byChain.get("solana") ?? fallback : fallback);
  }
  if (fallback) {
    map["*"] = fallback;
  }
  return map;
}

function buildSyntheticOrcaPositionRow(username: string, snapshot: OrcaWalletPositionSnapshot): PositionRow {
  const now = new Date().toISOString();
  return {
    id: `orca_scan_${snapshot.positionMint}`,
    executionId: `orca_scan_${snapshot.positionMint}`,
    username,
    protocol: "Orca",
    chain: "Solana",
    asset: `${snapshot.tokenSymbolA}/${snapshot.tokenSymbolB}`,
    poolAddress: snapshot.whirlpool,
    positionToken: snapshot.positionMint,
    positionRaw: snapshot.liquidity,
    amountUsd: snapshot.amountUsd,
    depositTxHash: `orca_scan_${snapshot.positionMint}`,
    lastSyncedAt: now,
    status: "active",
    openedAt: now,
    closedAt: null,
    onchainDataJson: null,
    principalUsd: snapshot.amountUsd,
    currentValueUsd: snapshot.amountUsd,
    unrealizedPnlUsd: 0,
    realizedPnlUsd: null,
    feesPaidUsd: null,
    netApy: null,
    entryPrice: null,
    expectedApr: null,
    protocolPositionId: snapshot.positionMint
  };
}

function attachSource<T extends PositionRow>(position: T, source: "db" | "wallet_scan"): T & { source: "db" | "wallet_scan" } {
  return { ...position, source };
}

export async function listOnchainPositionsForUser(
  username: string
): Promise<Array<PositionRow & { verify: PositionVerifyResult | null; source: "db" | "wallet_scan" }>> {
  const positions = await listPositionsByUser(username);
  const wallets = await listUserWallets(username);
  const walletMap = buildWalletAddressMap(wallets, positions);
  const verified = await verifyAllPositions(positions, walletMap);

  const rows: Array<PositionRow & { verify: PositionVerifyResult | null; source: "db" | "wallet_scan" }> = verified.map((verify, index) => ({
    ...positions[index],
    verify,
    source: "db"
  }));

  const seen = new Set<string>();
  for (const row of rows) {
    if (row.protocol !== "Orca") continue;
    seen.add(normalizeKey(row.poolAddress));
    seen.add(normalizeKey(row.positionToken));
    seen.add(normalizeKey(row.protocolPositionId));
  }

  const solanaWallets = [...new Set(wallets.filter((wallet) => wallet.chain.toLowerCase() === "solana").map((wallet) => wallet.walletAddress))];
  for (const walletAddress of solanaWallets) {
    const snapshots = await scanOrcaWalletPositions(walletAddress);
    for (const snapshot of snapshots) {
      const keys = [snapshot.whirlpool, snapshot.positionMint].map(normalizeKey);
      if (keys.some((key) => key && seen.has(key))) {
        continue;
      }
      const synthetic = buildSyntheticOrcaPositionRow(username, snapshot);
      const verify = await verifyOrcaPosition(synthetic, walletAddress);
      rows.push({
        ...attachSource(synthetic, "wallet_scan"),
        verify
      });
      seen.add(normalizeKey(snapshot.whirlpool));
      seen.add(normalizeKey(snapshot.positionMint));
    }
  }

  return rows.sort((left, right) => new Date(right.openedAt).getTime() - new Date(left.openedAt).getTime());
}
