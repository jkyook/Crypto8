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
import { getPoolApySeriesFromCsv } from "./marketAprHistory";
import { listUserWallets } from "./userWallets";

// ──────────────────────────────────────────────────────────────────────────────
//  Solana 토큰 민트 주소 → 심볼 폴백 테이블
//  Orca SDK가 symbol을 반환하지 못할 때 사용.
// ──────────────────────────────────────────────────────────────────────────────
const SOLANA_MINT_SYMBOL: Record<string, string> = {
  // Stablecoins
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  // Native / Wrapped SOL
  So11111111111111111111111111111111111111112: "wSOL",
  // LSTs
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": "stSOL",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "jitoSOL",
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: "bSOL",
  // Major tokens
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK",
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: "ORCA",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: "RNDR",
  WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk: "WEN",
};

function resolveTokenSymbol(mint: string, sdkSymbol?: string | null): string {
  if (sdkSymbol && sdkSymbol !== "tokenA" && sdkSymbol !== "tokenB") return sdkSymbol;
  return SOLANA_MINT_SYMBOL[mint] ?? mint.slice(0, 4) + "…";
}

function isStableMint(mint: string): boolean {
  const lower = mint.toLowerCase();
  return lower === "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwyt1v" || lower === "es9vmfrzacermjfrf4h2fyd4kcornk11mccce8benwnyb";
}

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
  poolLabel: string;
  liquidity: string;
  tickLowerIndex: number;
  tickUpperIndex: number;
  currentPrice: number;
  rangeLowerPrice: number;
  rangeUpperPrice: number;
  tokenMintA: string;
  tokenMintB: string;
  tokenSymbolA: string;
  tokenSymbolB: string;
  tokenDecimalsA: number;
  tokenDecimalsB: number;
  amountUsd: number;
  pendingYieldUsd: number;
  estimatedApr: number | null;
  estimatedDailyYieldUsd: number | null;
};

const ORCA_SNAPSHOT_CACHE = new Map<string, { at: number; snapshots: OrcaWalletPositionSnapshot[] }>();
const ORCA_SNAPSHOT_CACHE_TTL_MS = 60_000;

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

type CurvePoolConfig = {
  key: string;
  poolLabel: string;
  poolAddress: Address;
  lpTokenAddress: Address;
  gaugeAddress: Address;
  valueUnit: "USD" | "ETH";
};

const CURVE_ETHEREUM_POOLS: CurvePoolConfig[] = [
  {
    key: "curve-3pool",
    poolLabel: "Curve 3pool (DAI-USDC-USDT)",
    poolAddress: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
    lpTokenAddress: "0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490",
    gaugeAddress: "0xbFcF63294aD7105dEa65aA58F8AE5BE2D9d0952A",
    valueUnit: "USD"
  },
  {
    key: "curve-steth-eth",
    poolLabel: "Curve stETH-ETH",
    poolAddress: "0xDC24316b9AE028F1497c275EB9192a3Ea0f67022",
    lpTokenAddress: "0x06325440D014e39736583c165C2963BA99fAf14E",
    gaugeAddress: "0x182B723a58739a9c974cFDB385ceaDb237453c28",
    valueUnit: "ETH"
  }
];

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

const curvePoolAbi = [
  {
    type: "function",
    name: "get_virtual_price",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  }
] as const;

// ──────────────────────────────────────────────────────────────────────────────
//  Uniswap v3 설정 및 ABI
// ──────────────────────────────────────────────────────────────────────────────

/** 체인별 NonfungiblePositionManager 주소 */
const UNISWAP_NPM_ADDRESS: Record<string, Address> = {
  Arbitrum:  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  Ethereum:  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  Base:      "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
};

export function getUniswapNpmAddress(chain: string): Address | null {
  return UNISWAP_NPM_ADDRESS[chain] ?? null;
}

/** 체인별 Uniswap v3 Factory 주소 */
const UNISWAP_FACTORY_ADDRESS: Record<string, Address> = {
  Arbitrum:  "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  Ethereum:  "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  Base:      "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
};

/** ERC20 민트 주소 → 가격 심볼 매핑 (소문자) */
const TOKEN_PRICE_SYMBOL: Record<string, "USDC" | "USDT" | "ETH"> = {
  // USDC
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": "USDC", // Arbitrum
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC", // Base
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC", // Ethereum
  // USDT
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": "USDT", // Arbitrum
  "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT", // Ethereum
  // WETH
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": "ETH",  // Arbitrum WETH
  "0x4200000000000000000000000000000000000006": "ETH",  // Base WETH
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "ETH",  // Ethereum WETH
};

/** ERC20 민트 주소 → decimals 매핑 (소문자) */
const TOKEN_DECIMALS: Record<string, number> = {
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": 6,  // USDC Arb
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6,  // USDC Base
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 6,  // USDC Eth
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": 6,  // USDT Arb
  "0xdac17f958d2ee523a2206206994597c13d831ec7": 6,  // USDT Eth
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": 18, // WETH Arb
  "0x4200000000000000000000000000000000000006": 18, // WETH Base
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": 18, // WETH Eth
};

const npmAbi = [
  { type: "function", name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "tokenOfOwnerByIndex",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "index", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "positions",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "nonce",                    type: "uint96"  },
      { name: "operator",                 type: "address" },
      { name: "token0",                   type: "address" },
      { name: "token1",                   type: "address" },
      { name: "fee",                      type: "uint24"  },
      { name: "tickLower",                type: "int24"   },
      { name: "tickUpper",                type: "int24"   },
      { name: "liquidity",                type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0",              type: "uint128" },
      { name: "tokensOwed1",              type: "uint128" }
    ] }
] as const;

const factoryAbi = [
  { type: "function", name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee",    type: "uint24"  }
    ],
    outputs: [{ name: "pool", type: "address" }] }
] as const;

const poolSlot0Abi = [
  { type: "function", name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96",               type: "uint160" },
      { name: "tick",                        type: "int24"   },
      { name: "observationIndex",            type: "uint16"  },
      { name: "observationCardinality",      type: "uint16"  },
      { name: "observationCardinalityNext",  type: "uint16"  },
      { name: "feeProtocol",                 type: "uint8"   },
      { name: "unlocked",                    type: "bool"    }
    ] }
] as const;

export type UniswapWalletPositionSnapshot = {
  tokenId:   string;
  poolAddress: string;
  token0:    string;
  token1:    string;
  fee:       number;
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;
  sqrtPriceX96: string;
  liquidity: string;
  amount0Raw: string;
  amount1Raw: string;
  amount0Usd: number;
  amount1Usd: number;
  feesOwed0Raw: string;
  feesOwed1Raw: string;
  feesOwed0Usd: number;
  feesOwed1Usd: number;
  amountUsd: number;
  symbol:    string;   // e.g. "USDC/WETH"
  chain:     string;
};

/**
 * Uniswap v3 tick → sqrtPrice 변환 (JS float 근사).
 * sqrt(1.0001^tick) = 1.0001^(tick/2)
 */
function tickToSqrtPrice(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

/**
 * Uniswap v3 LP 포지션의 토큰 수량 추정 (raw, decimals 미적용).
 * 반환: [amount0Raw, amount1Raw]
 */
function calcUniswapTokenAmounts(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  tickCurrent: number,
  tickLower: number,
  tickUpper: number
): [number, number] {
  if (liquidity === 0n) return [0, 0];
  const L = Number(liquidity);
  const sqrtPrice  = Number(sqrtPriceX96) / 2 ** 96;
  const sqrtLower  = tickToSqrtPrice(tickLower);
  const sqrtUpper  = tickToSqrtPrice(tickUpper);

  if (tickCurrent < tickLower) {
    const a0 = L * (1 / sqrtLower - 1 / sqrtUpper);
    return [a0, 0];
  }
  if (tickCurrent >= tickUpper) {
    const a1 = L * (sqrtUpper - sqrtLower);
    return [0, a1];
  }
  const a0 = L * (1 / sqrtPrice - 1 / sqrtUpper);
  const a1 = L * (sqrtPrice - sqrtLower);
  return [a0, a1];
}

/**
 * EVM 지갑의 Uniswap v3 NFT LP 포지션을 스캔해 스냅샷 배열로 반환.
 */
export async function scanUniswapWalletPositions(
  chain: string,
  walletAddress: string
): Promise<UniswapWalletPositionSnapshot[]> {
  const npmAddr     = UNISWAP_NPM_ADDRESS[chain];
  const factoryAddr = UNISWAP_FACTORY_ADDRESS[chain];
  const client      = getEvmClient(chain);
  if (!npmAddr || !factoryAddr || !client) return [];

  const owner = getAddress(walletAddress) as Address;
  const balance = await client.readContract({
    address: npmAddr, abi: npmAbi,
    functionName: "balanceOf", args: [owner]
  });
  if (balance === 0n) return [];

  const priceSnapshot = await getMarketPriceSnapshot();
  const snapshots: UniswapWalletPositionSnapshot[] = [];

  for (let i = 0n; i < balance; i++) {
    try {
      const tokenId = await client.readContract({
        address: npmAddr, abi: npmAbi,
        functionName: "tokenOfOwnerByIndex", args: [owner, i]
      });
      const pos = await client.readContract({
        address: npmAddr, abi: npmAbi,
        functionName: "positions", args: [tokenId]
      });
      const { token0, token1, fee, tickLower, tickUpper, liquidity } = pos as {
        token0: string; token1: string; fee: number;
        tickLower: number; tickUpper: number; liquidity: bigint;
      };
      const [, , , , , , , , , , tokensOwed0, tokensOwed1] = pos as [
        unknown, unknown, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint
      ];
      if (liquidity === 0n) continue;

      // 풀 주소 조회 → slot0 (현재 가격)
      const poolAddr = await client.readContract({
        address: factoryAddr, abi: factoryAbi,
        functionName: "getPool",
        args: [token0 as Address, token1 as Address, fee]
      }) as string;

      let sqrtPriceX96 = 0n;
      let tickCurrent  = 0;
      if (poolAddr && poolAddr !== "0x0000000000000000000000000000000000000000") {
        const slot0 = await client.readContract({
          address: poolAddr as Address, abi: poolSlot0Abi,
          functionName: "slot0"
        }) as [bigint, number, ...unknown[]];
        sqrtPriceX96 = slot0[0];
        tickCurrent  = slot0[1];
      }

      const [a0Raw, a1Raw] = calcUniswapTokenAmounts(
        liquidity, sqrtPriceX96, tickCurrent, tickLower, tickUpper
      );

      const t0key = token0.toLowerCase();
      const t1key = token1.toLowerCase();
      const dec0  = TOKEN_DECIMALS[t0key] ?? 18;
      const dec1  = TOKEN_DECIMALS[t1key] ?? 18;
      const sym0  = TOKEN_PRICE_SYMBOL[t0key];
      const sym1  = TOKEN_PRICE_SYMBOL[t1key];
      const price0 = sym0 ? priceSnapshot.prices[sym0] : 0;
      const price1 = sym1 ? priceSnapshot.prices[sym1] : 0;

      const usd0 = (a0Raw / 10 ** dec0) * price0;
      const usd1 = (a1Raw / 10 ** dec1) * price1;
      const feesOwed0 = Number(tokensOwed0) / 10 ** dec0;
      const feesOwed1 = Number(tokensOwed1) / 10 ** dec1;
      const feesOwed0Usd = feesOwed0 * price0;
      const feesOwed1Usd = feesOwed1 * price1;
      const amountUsd = usd0 + usd1;

      const symbolLabel = `${sym0 ?? token0.slice(0, 6)}/${sym1 ?? token1.slice(0, 6)}`;

      snapshots.push({
        tokenId:   tokenId.toString(),
        poolAddress: poolAddr,
        token0,    token1,
        fee,       tickLower, tickUpper,
        tickCurrent,
        sqrtPriceX96: sqrtPriceX96.toString(),
        liquidity: liquidity.toString(),
        amount0Raw: a0Raw.toFixed(18),
        amount1Raw: a1Raw.toFixed(18),
        amount0Usd: usd0,
        amount1Usd: usd1,
        feesOwed0Raw: feesOwed0.toFixed(18),
        feesOwed1Raw: feesOwed1.toFixed(18),
        feesOwed0Usd,
        feesOwed1Usd,
        amountUsd,
        symbol:    symbolLabel,
        chain
      });
    } catch (err) {
      console.warn(JSON.stringify({
        level: "warn", msg: "uniswap_position_scan_failed",
        chain, walletAddress,
        error: err instanceof Error ? err.message : String(err)
      }));
    }
  }
  ORCA_SNAPSHOT_CACHE.set(cacheKey, { at: Date.now(), snapshots });
  return snapshots;
}

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

export async function scanOrcaWalletPositions(walletAddress: string, forceRefresh = false): Promise<OrcaWalletPositionSnapshot[]> {
  const cacheKey = walletAddress.toLowerCase();
  const cached = ORCA_SNAPSHOT_CACHE.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.at < ORCA_SNAPSHOT_CACHE_TTL_MS) {
    return cached.snapshots;
  }

  const { client, owner } = await createOrcaReadClient(walletAddress);
  const positionMap = await getAllPositionAccountsByOwner({
    ctx: client.getContext(),
    owner,
    includesPositions: true,
    includesPositionsWithTokenExtensions: true,
    includesBundledPositions: false
  });
  const merged = new Map<
    string,
    {
      position: {
        whirlpool: PublicKey;
        positionMint: PublicKey;
        liquidity: unknown;
        tickLowerIndex: number;
        tickUpperIndex: number;
        feeOwedA: { toString(): string };
        feeOwedB: { toString(): string };
      };
      withExtension?: boolean;
    }
  >();

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
      const poolLabel = `Orca Whirlpools ${resolveTokenSymbol(tokenAInfo.mint.toBase58(), tokenAInfo.symbol)}-${resolveTokenSymbol(tokenBInfo.mint.toBase58(), tokenBInfo.symbol)}`;
      const tokenAmounts = PoolUtil.getTokenAmountsFromLiquidity(
        entry.position.liquidity as never,
        poolData.sqrtPrice as never,
        PriceMath.tickIndexToSqrtPriceX64(entry.position.tickLowerIndex),
        PriceMath.tickIndexToSqrtPriceX64(entry.position.tickUpperIndex),
        false
      );
      const amountA = new Decimal(tokenAmounts.tokenA.toString()).div(new Decimal(10).pow(tokenAInfo.decimals));
      const amountB = new Decimal(tokenAmounts.tokenB.toString()).div(new Decimal(10).pow(tokenBInfo.decimals));
      const currentPriceDecimal = PriceMath.sqrtPriceX64ToPrice(poolData.sqrtPrice as never, tokenAInfo.decimals, tokenBInfo.decimals);
      const currentPrice = Number(currentPriceDecimal.toFixed(6));
      const rangeLowerPrice = Number(PriceMath.tickIndexToPrice(entry.position.tickLowerIndex, tokenAInfo.decimals, tokenBInfo.decimals).toFixed(6));
      const rangeUpperPrice = Number(PriceMath.tickIndexToPrice(entry.position.tickUpperIndex, tokenAInfo.decimals, tokenBInfo.decimals).toFixed(6));
      const tokenAStable = isStableMint(tokenAInfo.mint.toBase58());
      const tokenBStable = isStableMint(tokenBInfo.mint.toBase58());
      const amountUsdDecimal = tokenAStable
        ? amountA.plus(amountB.div(currentPriceDecimal))
        : tokenBStable
          ? amountA.mul(currentPriceDecimal).plus(amountB)
          : amountA.mul(currentPriceDecimal).plus(amountB);
      const amountUsd = Number(amountUsdDecimal.toFixed(2));
      const feeOwedA = new Decimal(entry.position.feeOwedA.toString()).div(new Decimal(10).pow(tokenAInfo.decimals));
      const feeOwedB = new Decimal(entry.position.feeOwedB.toString()).div(new Decimal(10).pow(tokenBInfo.decimals));
      const pendingYieldUsdDecimal = tokenAStable
        ? feeOwedA.plus(feeOwedB.div(currentPriceDecimal))
        : tokenBStable
          ? feeOwedA.mul(currentPriceDecimal).plus(feeOwedB)
          : feeOwedA.mul(currentPriceDecimal).plus(feeOwedB);
      const pendingYieldUsd = Number(pendingYieldUsdDecimal.toFixed(2));
      const poolApy = getPoolApySeriesFromCsv(14, [poolLabel]);
      const poolApyKey = poolApy.series[0]?.key ?? "";
      const latestApy = poolApy.points.at(-1)?.pools?.[poolApyKey] ?? null;
      const estimatedApr = typeof latestApy === "number" && Number.isFinite(latestApy) ? latestApy : null;
      const estimatedDailyYieldUsd = estimatedApr == null ? null : Number(((amountUsd * estimatedApr) / 365).toFixed(2));
      snapshots.push({
        positionMint: entry.position.positionMint.toBase58(),
        whirlpool: entry.position.whirlpool.toBase58(),
        poolLabel,
        liquidity: String(entry.position.liquidity),
        tickLowerIndex: entry.position.tickLowerIndex,
        tickUpperIndex: entry.position.tickUpperIndex,
        currentPrice,
        rangeLowerPrice,
        rangeUpperPrice,
        tokenMintA: tokenAInfo.mint.toBase58(),
        tokenMintB: tokenBInfo.mint.toBase58(),
        tokenSymbolA: resolveTokenSymbol(tokenAInfo.mint.toBase58(), tokenAInfo.symbol),
        tokenSymbolB: resolveTokenSymbol(tokenBInfo.mint.toBase58(), tokenBInfo.symbol),
        tokenDecimalsA: tokenAInfo.decimals,
        tokenDecimalsB: tokenBInfo.decimals,
        amountUsd,
        pendingYieldUsd,
        estimatedApr,
        estimatedDailyYieldUsd
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
    Uniswap: "NonfungiblePositionManager NFT 스캔 구현 완료",
    Orca: "Whirlpools SDK position PDA 조회 및 지갑 스캔 매칭 구현 완료",
    Aerodrome: "gauge/LP token balance 조회 구현 예정",
    Raydium: "LP/position account 조회 구현 예정",
    Curve: "Curve LP token 및 gauge balanceOf 조회 구현 완료"
  };
  return {
    onchainAmountUsd: null, onchainRaw: null,
    status: "unsupported",
    detail: roadmap[protocol] ?? `${protocol}/${chain} 온체인 조회 어댑터 미구현`,
    driftPct: null
  };
}

/**
 * Uniswap v3 포지션 온체인 검증.
 * NonfungiblePositionManager를 스캔해 DB 행과 매칭한다.
 * DB의 protocolPositionId 또는 positionToken = NFT tokenId (숫자 문자열).
 */
async function verifyUniswapPosition(
  position: PositionRow,
  walletAddress: string
): Promise<Omit<PositionVerifyResult, "positionId" | "protocol" | "chain" | "dbAmountUsd" | "verifiedAt" | "walletAddress">> {
  try {
    const snapshots = await scanUniswapWalletPositions(position.chain, walletAddress);

    if (snapshots.length === 0) {
      return {
        onchainAmountUsd: null, onchainRaw: null,
        status: "closed_onchain",
        detail: "Uniswap v3 NFT LP 포지션이 지갑에서 발견되지 않았습니다.",
        driftPct: null
      };
    }

    // DB에 저장된 tokenId로 매칭 시도
    const dbTokenId = (position.protocolPositionId ?? position.positionToken ?? "").trim();
    const matched = dbTokenId
      ? snapshots.find((s) => s.tokenId === dbTokenId)
      : null;

    // tokenId 매칭 실패 시 같은 토큰쌍 포지션 합산
    const candidates = matched ? [matched] : snapshots;

    const onchainAmountUsd = candidates.reduce((sum, s) => sum + s.amountUsd, 0);
    const onchainRaw = candidates.map((s) => s.tokenId).join(",");
    const driftPct = calcDriftPct(position.amountUsd, onchainAmountUsd);
    const matchLabel = matched
      ? `tokenId ${matched.tokenId}`
      : `${candidates.length}개 포지션 합산`;

    if (onchainAmountUsd === 0 && position.amountUsd > 0.01) {
      return {
        onchainAmountUsd, onchainRaw,
        status: "closed_onchain",
        detail: `온체인 Uniswap LP 잔고 0 — DB에는 $${position.amountUsd.toFixed(2)} 기록.`,
        driftPct: 100
      };
    }

    if (driftPct > 10) {
      return {
        onchainAmountUsd, onchainRaw,
        status: "drift",
        detail: `DB $${position.amountUsd.toFixed(2)} vs 온체인 $${onchainAmountUsd.toFixed(2)} (${driftPct.toFixed(1)}% 차이) · ${matchLabel}`,
        driftPct
      };
    }

    return {
      onchainAmountUsd, onchainRaw,
      status: "verified",
      detail: `Uniswap v3 온체인 확인 완료 · ${matchLabel} / ${candidates[0]?.symbol ?? ""}`,
      driftPct
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      onchainAmountUsd: null, onchainRaw: null,
      status: "rpc_error",
      detail: `Uniswap/${position.chain} RPC 오류: ${msg}`,
      driftPct: null
    };
  }
}

async function verifyCurvePosition(
  position: PositionRow,
  walletAddress: string
): Promise<Omit<PositionVerifyResult, "positionId" | "protocol" | "chain" | "dbAmountUsd" | "verifiedAt" | "walletAddress">> {
  try {
    const snapshots = await scanCurveWalletPositions(walletAddress);
    const matched = snapshots.find((snapshot) => matchesCurveSnapshot(position, snapshot));

    if (!matched) {
      if (snapshots.length === 0) {
        return {
          onchainAmountUsd: null,
          onchainRaw: null,
          status: "closed_onchain",
          detail: "Curve 포지션이 현재 지갑에서 발견되지 않았습니다.",
          driftPct: null
        };
      }
      return {
        onchainAmountUsd: null,
        onchainRaw: null,
        status: "unsupported",
        detail: `Curve 포지션은 지갑에서 스캔했지만 DB 행과 정확히 매칭되지 않았습니다. 지갑에 ${snapshots.length}개 포지션이 있습니다.`,
        driftPct: null
      };
    }

    return verifyCurvePositionFromSnapshot(position, matched);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      onchainAmountUsd: null,
      onchainRaw: null,
      status: "rpc_error",
      detail: `Curve/${position.chain} RPC 오류: ${msg}`,
      driftPct: null
    };
  }
}

export type CurveWalletPositionSnapshot = {
  poolKey: string;
  poolLabel: string;
  poolAddress: string;
  lpTokenAddress: string;
  gaugeAddress: string;
  lpBalanceRaw: string;
  gaugeBalanceRaw: string;
  totalLpBalanceRaw: string;
  virtualPrice: string;
  amountUsd: number;
  chain: "Ethereum";
};

function buildCurveValueUsd(
  totalLpBalanceRaw: bigint,
  virtualPriceRaw: bigint,
  valueUnitPrice: number
): number {
  if (totalLpBalanceRaw <= 0n || virtualPriceRaw <= 0n || !Number.isFinite(valueUnitPrice) || valueUnitPrice <= 0) {
    return 0;
  }
  const lpUnits = new Decimal(totalLpBalanceRaw.toString()).div(new Decimal(10).pow(18));
  const priceUnits = new Decimal(virtualPriceRaw.toString()).div(new Decimal(10).pow(18));
  return Number(lpUnits.mul(priceUnits).mul(valueUnitPrice).toFixed(2));
}

/**
 * Curve Ethereum LP / gauge 포지션 스캔.
 * wallet가 보유한 LP 토큰과 gauge 스테이킹 잔고를 함께 합산한다.
 */
export async function scanCurveWalletPositions(walletAddress: string): Promise<CurveWalletPositionSnapshot[]> {
  const client = getEvmClient("Ethereum");
  if (!client) return [];

  const owner = getAddress(walletAddress) as Address;
  const priceSnapshot = await getMarketPriceSnapshot();
  const snapshots: CurveWalletPositionSnapshot[] = [];
  let sawAnySuccess = false;
  let sawAnyFailure = false;
  let firstError: unknown = null;

  for (const pool of CURVE_ETHEREUM_POOLS) {
    try {
      const [lpBalance, gaugeBalance, virtualPrice] = await Promise.all([
        client.readContract({
          address: pool.lpTokenAddress,
          abi: erc20BalanceAbi,
          functionName: "balanceOf",
          args: [owner]
        }),
        client.readContract({
          address: pool.gaugeAddress,
          abi: erc20BalanceAbi,
          functionName: "balanceOf",
          args: [owner]
        }),
        client.readContract({
          address: pool.poolAddress,
          abi: curvePoolAbi,
          functionName: "get_virtual_price"
        })
      ]);

      const totalLpBalance = lpBalance + gaugeBalance;
      if (totalLpBalance === 0n) {
        continue;
      }

      const valueUnitPrice = pool.valueUnit === "ETH" ? priceSnapshot.prices.ETH : 1;
      const amountUsd = buildCurveValueUsd(totalLpBalance, virtualPrice, valueUnitPrice);
      snapshots.push({
        poolKey: pool.key,
        poolLabel: pool.poolLabel,
        poolAddress: pool.poolAddress,
        lpTokenAddress: pool.lpTokenAddress,
        gaugeAddress: pool.gaugeAddress,
        lpBalanceRaw: lpBalance.toString(),
        gaugeBalanceRaw: gaugeBalance.toString(),
        totalLpBalanceRaw: totalLpBalance.toString(),
        virtualPrice: virtualPrice.toString(),
        amountUsd,
        chain: "Ethereum"
      });
      sawAnySuccess = true;
    } catch (error) {
      sawAnyFailure = true;
      if (firstError === null) {
        firstError = error;
      }
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "curve_position_scan_failed",
          walletAddress,
          poolAddress: pool.poolAddress,
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

  if (!sawAnySuccess && sawAnyFailure) {
    throw firstError instanceof Error
      ? firstError
      : new Error(firstError ? String(firstError) : "curve_position_scan_failed");
  }

  return snapshots;
}

function matchesCurveSnapshot(position: PositionRow, snapshot: CurveWalletPositionSnapshot): boolean {
  const positionKeys = [position.poolAddress, position.positionToken, position.protocolPositionId].map(normalizeKey).filter(Boolean);
  const snapshotKeys = [snapshot.poolAddress, snapshot.lpTokenAddress, snapshot.gaugeAddress].map(normalizeKey);
  return positionKeys.some((key) => snapshotKeys.includes(key));
}

function verifyCurvePositionFromSnapshot(
  position: PositionRow,
  snapshot: CurveWalletPositionSnapshot
): Omit<PositionVerifyResult, "positionId" | "protocol" | "chain" | "dbAmountUsd" | "verifiedAt" | "walletAddress"> {
  const onchainAmountUsd = snapshot.amountUsd;
  const driftPct = calcDriftPct(position.amountUsd, onchainAmountUsd);
  const matchLabel = `${snapshot.poolLabel}`;

  if (onchainAmountUsd === 0 && position.amountUsd > 0.01) {
    return {
      onchainAmountUsd,
      onchainRaw: snapshot.totalLpBalanceRaw,
      status: "closed_onchain",
      detail: `온체인 Curve 포지션 잔고 0 — DB에는 $${position.amountUsd.toFixed(2)} 기록.`,
      driftPct: 100
    };
  }

  if (driftPct > 10) {
    return {
      onchainAmountUsd,
      onchainRaw: snapshot.totalLpBalanceRaw,
      status: "drift",
      detail: `DB $${position.amountUsd.toFixed(2)} vs 온체인 $${onchainAmountUsd.toFixed(2)} (${driftPct.toFixed(1)}% 차이) · ${matchLabel}`,
      driftPct
    };
  }

  return {
    onchainAmountUsd,
    onchainRaw: snapshot.totalLpBalanceRaw,
    status: "verified",
    detail: `Curve 온체인 확인 완료 · ${matchLabel}`,
    driftPct
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

function buildSyntheticUniswapPositionRow(
  username: string,
  chain: string,
  snapshot: UniswapWalletPositionSnapshot
): PositionRow {
  const now = new Date().toISOString();
  return {
    id: `uniswap_scan_${chain}_${snapshot.tokenId}`,
    executionId: `uniswap_scan_${chain}_${snapshot.tokenId}`,
    username,
    protocol: "Uniswap",
    chain,
    asset: snapshot.symbol,
    poolAddress: snapshot.poolAddress,
    positionToken: snapshot.tokenId,
    positionRaw: snapshot.liquidity,
    amountUsd: snapshot.amountUsd,
    depositTxHash: `uniswap_scan_${chain}_${snapshot.tokenId}`,
    lastSyncedAt: now,
    status: "active",
    openedAt: now,
    closedAt: null,
    onchainDataJson: JSON.stringify({
      source: "wallet_scan",
      protocol: "Uniswap",
      chain,
      tokenId: snapshot.tokenId,
      poolAddress: snapshot.poolAddress,
      token0: snapshot.token0,
      token1: snapshot.token1,
      fee: snapshot.fee
    }),
    principalUsd: snapshot.amountUsd,
    currentValueUsd: snapshot.amountUsd,
    unrealizedPnlUsd: 0,
    realizedPnlUsd: null,
    feesPaidUsd: null,
    netApy: null,
    entryPrice: null,
    expectedApr: null,
    protocolPositionId: snapshot.tokenId
  };
}

function verifyUniswapPositionFromSnapshot(
  position: PositionRow,
  snapshot: UniswapWalletPositionSnapshot
): Omit<PositionVerifyResult, "positionId" | "protocol" | "chain" | "dbAmountUsd" | "verifiedAt" | "walletAddress"> {
  const onchainAmountUsd = snapshot.amountUsd;
  const driftPct = calcDriftPct(position.amountUsd, onchainAmountUsd);
  const matchLabel = `tokenId ${snapshot.tokenId}`;

  if (onchainAmountUsd === 0 && position.amountUsd > 0.01) {
    return {
      onchainAmountUsd,
      onchainRaw: snapshot.liquidity,
      status: "closed_onchain",
      detail: `온체인 Uniswap LP 잔고 0 — DB에는 $${position.amountUsd.toFixed(2)} 기록.`,
      driftPct: 100
    };
  }

  if (driftPct > 10) {
    return {
      onchainAmountUsd,
      onchainRaw: snapshot.liquidity,
      status: "drift",
      detail: `DB $${position.amountUsd.toFixed(2)} vs 온체인 $${onchainAmountUsd.toFixed(2)} (${driftPct.toFixed(1)}% 차이) · ${matchLabel}`,
      driftPct
    };
  }

  return {
    onchainAmountUsd,
    onchainRaw: snapshot.liquidity,
    status: "verified",
    detail: `Uniswap v3 온체인 확인 완료 · ${matchLabel} / ${snapshot.symbol}`,
    driftPct
  };
}

/**
 * 이미 스캔된 스냅샷으로부터 verify 결과를 직접 빌드.
 * scanOrcaWalletPositions를 재호출하지 않으므로 RPC 이중 호출 없음.
 */
function verifyOrcaPositionFromSnapshot(
  position: PositionRow,
  snapshot: OrcaWalletPositionSnapshot
): Omit<PositionVerifyResult, "positionId" | "protocol" | "chain" | "dbAmountUsd" | "verifiedAt" | "walletAddress"> {
  const onchainAmountUsd = snapshot.amountUsd;
  const driftPct = calcDriftPct(position.amountUsd, onchainAmountUsd);

  if (onchainAmountUsd === 0 && position.amountUsd > 0.01) {
    return {
      onchainAmountUsd,
      onchainRaw: snapshot.liquidity,
      status: "closed_onchain",
      detail: `온체인 Orca 포지션 잔고 0 — DB에는 $${position.amountUsd.toFixed(2)} 기록. 외부에서 출금됐을 수 있습니다.`,
      driftPct: 100
    };
  }

  if (driftPct > 5) {
    return {
      onchainAmountUsd,
      onchainRaw: snapshot.liquidity,
      status: "drift",
      detail: `DB $${position.amountUsd.toFixed(2)} vs 온체인 $${onchainAmountUsd.toFixed(2)} (${driftPct.toFixed(1)}% 차이). Orca 포지션이 일부 이동됐을 수 있습니다.`,
      driftPct
    };
  }

  return {
    onchainAmountUsd,
    onchainRaw: snapshot.liquidity,
    status: "verified",
    detail: `Orca 지갑 스캔 확인 완료: position ${snapshot.positionMint} / whirlpool ${snapshot.whirlpool}`,
    driftPct
  };
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
    case "Uniswap":
      partial = await verifyUniswapPosition(position, resolvedWallet);
      break;
    case "Orca":
      partial = await verifyOrcaPosition(position, resolvedWallet);
      break;
    case "Curve":
      partial = await verifyCurvePosition(position, resolvedWallet);
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
  walletAddressMap?: Record<string, string>,
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
      const resolvedWallet = walletAddressMap?.[pos.id] ?? walletAddressMap?.[pos.chain] ?? walletAddressMap?.["*"] ?? walletAddress;
      const verify = await verifyPosition(pos, resolvedWallet);
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
    onchainDataJson: JSON.stringify({
      source: "wallet_scan",
      protocol: "Orca",
      chain: "Solana",
      positionMint: snapshot.positionMint,
      whirlpool: snapshot.whirlpool,
      poolLabel: snapshot.poolLabel,
      currentPrice: snapshot.currentPrice,
      rangeLowerPrice: snapshot.rangeLowerPrice,
      rangeUpperPrice: snapshot.rangeUpperPrice,
      amountUsd: snapshot.amountUsd,
      pendingYieldUsd: snapshot.pendingYieldUsd,
      estimatedApr: snapshot.estimatedApr,
      estimatedDailyYieldUsd: snapshot.estimatedDailyYieldUsd,
      token0: snapshot.tokenMintA,
      token1: snapshot.tokenMintB,
      tokenSymbolA: snapshot.tokenSymbolA,
      tokenSymbolB: snapshot.tokenSymbolB
    }),
    principalUsd: null,
    currentValueUsd: snapshot.amountUsd,
    unrealizedPnlUsd: null,
    realizedPnlUsd: null,
    feesPaidUsd: snapshot.pendingYieldUsd,
    netApy: snapshot.estimatedApr,
    entryPrice: null,
    expectedApr: snapshot.estimatedApr,
    protocolPositionId: snapshot.positionMint
  };
}

function buildSyntheticUniswapPositionRows(
  username: string,
  chain: string,
  snapshots: UniswapWalletPositionSnapshot[]
): Array<PositionRow & { verify: PositionVerifyResult | null; source: "wallet_scan" }> {
  const rows: Array<PositionRow & { verify: PositionVerifyResult | null; source: "wallet_scan" }> = [];
  for (const snapshot of snapshots) {
    const synthetic = buildSyntheticUniswapPositionRow(username, chain, snapshot);
    const verifyPartial = verifyUniswapPositionFromSnapshot(synthetic, snapshot);
    const verify: PositionVerifyResult = {
      positionId: synthetic.id,
      protocol: synthetic.protocol,
      chain: synthetic.chain,
      dbAmountUsd: synthetic.amountUsd,
      verifiedAt: new Date().toISOString(),
      walletAddress: null,
      ...verifyPartial
    };
    rows.push({
      ...attachSource(synthetic, "wallet_scan"),
      verify
    });
  }
  return rows;
}

function buildSyntheticCurvePositionRow(
  username: string,
  snapshot: CurveWalletPositionSnapshot,
  walletAddress: string
): PositionRow & { walletAddress: string } {
  const now = new Date().toISOString();
  return {
    id: `curve_scan_${snapshot.poolKey}_${snapshot.lpTokenAddress}`,
    executionId: `curve_scan_${snapshot.poolKey}_${snapshot.lpTokenAddress}`,
    username,
    protocol: "Curve",
    chain: "Ethereum",
    asset: snapshot.poolLabel,
    poolAddress: snapshot.poolAddress,
    positionToken: snapshot.lpTokenAddress,
    positionRaw: snapshot.totalLpBalanceRaw,
    amountUsd: snapshot.amountUsd,
    depositTxHash: `curve_scan_${snapshot.poolKey}_${snapshot.lpTokenAddress}`,
    lastSyncedAt: now,
    status: "active",
    openedAt: now,
    closedAt: null,
    onchainDataJson: JSON.stringify({
      source: "wallet_scan",
      protocol: "Curve",
      chain: "Ethereum",
      poolKey: snapshot.poolKey,
      poolLabel: snapshot.poolLabel,
      poolAddress: snapshot.poolAddress,
      lpTokenAddress: snapshot.lpTokenAddress,
      gaugeAddress: snapshot.gaugeAddress,
      lpBalanceRaw: snapshot.lpBalanceRaw,
      gaugeBalanceRaw: snapshot.gaugeBalanceRaw,
      totalLpBalanceRaw: snapshot.totalLpBalanceRaw,
      virtualPrice: snapshot.virtualPrice,
      amountUsd: snapshot.amountUsd
    }),
    principalUsd: snapshot.amountUsd,
    currentValueUsd: snapshot.amountUsd,
    unrealizedPnlUsd: 0,
    realizedPnlUsd: null,
    feesPaidUsd: null,
    netApy: null,
    entryPrice: null,
    expectedApr: null,
    protocolPositionId: snapshot.lpTokenAddress,
    walletAddress
  };
}

function buildSyntheticCurvePositionRows(
  username: string,
  snapshots: CurveWalletPositionSnapshot[],
  walletAddress: string
): Array<PositionRow & { verify: PositionVerifyResult | null; source: "wallet_scan"; walletAddress: string }> {
  const rows: Array<PositionRow & { verify: PositionVerifyResult | null; source: "wallet_scan"; walletAddress: string }> = [];
  for (const snapshot of snapshots) {
    const synthetic = buildSyntheticCurvePositionRow(username, snapshot, walletAddress);
    const verifyPartial = verifyCurvePositionFromSnapshot(synthetic, snapshot);
    const verify: PositionVerifyResult = {
      positionId: synthetic.id,
      protocol: synthetic.protocol,
      chain: synthetic.chain,
      dbAmountUsd: synthetic.amountUsd,
      verifiedAt: new Date().toISOString(),
      walletAddress,
      ...verifyPartial
    };
    rows.push({
      ...attachSource(synthetic, "wallet_scan"),
      verify
    });
  }
  return rows;
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
    if (row.protocol !== "Orca" && row.protocol !== "Uniswap") continue;
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
      // 이미 스캔한 스냅샷을 그대로 활용 — 재스캔(RPC 이중 호출) 없음
      const verifyPartial = verifyOrcaPositionFromSnapshot(synthetic, snapshot);
      const verify: PositionVerifyResult = {
        positionId: synthetic.id,
        protocol: synthetic.protocol,
        chain: synthetic.chain,
        dbAmountUsd: synthetic.amountUsd,
        verifiedAt: new Date().toISOString(),
        walletAddress,
        ...verifyPartial
      };
      rows.push({
        ...attachSource(synthetic, "wallet_scan"),
        verify
      });
      seen.add(normalizeKey(snapshot.whirlpool));
      seen.add(normalizeKey(snapshot.positionMint));
    }
  }

  const evmWalletsByChain = new Map<string, string[]>();
  for (const wallet of wallets) {
    if (wallet.chain.toLowerCase() === "solana") continue;
    const existing = evmWalletsByChain.get(wallet.chain) ?? [];
    if (!existing.includes(wallet.walletAddress)) {
      existing.push(wallet.walletAddress);
    }
    evmWalletsByChain.set(wallet.chain, existing);
  }
  for (const chain of ["Arbitrum", "Base", "Ethereum"] as const) {
    for (const walletAddress of evmWalletsByChain.get(chain) ?? []) {
      const snapshots = await scanUniswapWalletPositions(chain, walletAddress);
      for (const row of buildSyntheticUniswapPositionRows(username, chain, snapshots)) {
        const keys = [row.positionToken, row.protocolPositionId].map(normalizeKey);
        if (keys.some((key) => key && seen.has(key))) {
          continue;
        }
        rows.push(row);
        for (const key of keys) {
          if (key) {
            seen.add(key);
          }
        }
      }
    }
  }

  for (const walletAddress of evmWalletsByChain.get("Ethereum") ?? []) {
    try {
      const snapshots = await scanCurveWalletPositions(walletAddress);
      for (const row of buildSyntheticCurvePositionRows(username, snapshots, walletAddress)) {
        const keys = [row.poolAddress, row.positionToken, row.protocolPositionId].map(normalizeKey);
        if (keys.some((key) => key && seen.has(key))) {
          continue;
        }
        rows.push(row);
        for (const key of keys) {
          if (key) {
            seen.add(key);
          }
        }
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "curve_wallet_scan_failed",
          username,
          walletAddress,
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

  return rows.sort((left, right) => new Date(right.openedAt).getTime() - new Date(left.openedAt).getTime());
}

export async function listOrcaWalletPositions(
  username: string,
  walletAddress: string
): Promise<Array<PositionRow & { verify: PositionVerifyResult | null; source: "db" | "wallet_scan" }>> {
  if (!walletAddress) {
    return [];
  }

  if (username === "guest") {
    const snapshots = await scanOrcaWalletPositions(walletAddress);
    const rows: Array<PositionRow & { verify: PositionVerifyResult | null; source: "wallet_scan" }> = [];
    for (const snapshot of snapshots) {
      const synthetic = buildSyntheticOrcaPositionRow(username, snapshot);
      // 이미 스캔한 스냅샷을 그대로 활용 — 재스캔(RPC 이중 호출) 없음
      const verifyPartial = verifyOrcaPositionFromSnapshot(synthetic, snapshot);
      const verify: PositionVerifyResult = {
        positionId: synthetic.id,
        protocol: synthetic.protocol,
        chain: synthetic.chain,
        dbAmountUsd: synthetic.amountUsd,
        verifiedAt: new Date().toISOString(),
        walletAddress,
        ...verifyPartial
      };
      rows.push({
        ...attachSource(synthetic, "wallet_scan"),
        verify
      });
    }
    return rows.sort((left, right) => new Date(right.openedAt).getTime() - new Date(left.openedAt).getTime());
  }

  const rows = await listOnchainPositionsForUser(username);
  return rows.filter((row) => row.protocol === "Orca");
}
