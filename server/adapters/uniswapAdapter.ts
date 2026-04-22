import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";
import { isAdapterLiveEnabled, buildUnsupportedResult } from "./types";
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { getUsdcUsdtPrice } from "./priceFeed";
import { loadArbitrumExecutorPrivateKey } from "../secrets";

function buildTxId(prefix: string, context: AdapterExecutionContext): string {
  return `${prefix}_${context.jobId}_${Date.now()}`;
}

const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDT_ARB = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const POSITION_MANAGER_ARB = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const USDC_USDT_POOL_ARB = "0x8c9d230d45f40bbf3d7a7ecf3f77d16f80d3f427";
const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bool" }]
  }
] as const;
const positionManagerMintAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" }
        ]
      }
    ],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" }
    ]
  }
] as const;
const uniswapV3PoolAbi = [
  {
    type: "function",
    name: "liquidity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint128" }]
  },
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" }
    ]
  }
] as const;

function getSlippageBps(): number {
  const raw = Number(process.env.UNISWAP_SLIPPAGE_BPS ?? "50");
  if (!Number.isFinite(raw) || raw < 0 || raw > 500) {
    return 50;
  }
  return raw;
}

function getMintFeeTier(): number {
  const raw = Number(process.env.UNISWAP_USDC_USDT_FEE_TIER ?? "100");
  if (!Number.isFinite(raw) || raw <= 0) {
    return 100;
  }
  return Math.floor(raw);
}

function getMintTickRange(): { tickLower: number; tickUpper: number } {
  const lower = Number(process.env.UNISWAP_FULL_RANGE_TICK_LOWER ?? "-887220");
  const upper = Number(process.env.UNISWAP_FULL_RANGE_TICK_UPPER ?? "887220");
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) {
    return { tickLower: -887220, tickUpper: 887220 };
  }
  return { tickLower: Math.floor(lower), tickUpper: Math.floor(upper) };
}

function getDeadlineSec(): number {
  const raw = Number(process.env.UNISWAP_DEADLINE_SEC ?? "1200");
  if (!Number.isFinite(raw) || raw < 60 || raw > 7200) {
    return 1200;
  }
  return Math.floor(raw);
}

function getMaxLiveDepositUsd(): number {
  const raw = Number(process.env.UNISWAP_MAX_LIVE_DEPOSIT_USD ?? "10000");
  if (!Number.isFinite(raw) || raw <= 0) {
    return 10000;
  }
  return raw;
}

function getPoolAddress(): `0x${string}` {
  const addr = (process.env.UNISWAP_USDC_USDT_POOL_ADDRESS ?? USDC_USDT_POOL_ARB).trim();
  return addr as `0x${string}`;
}

function getPoolMinLiquidity(): bigint {
  const raw = process.env.UNISWAP_POOL_MIN_LIQUIDITY ?? "100000";
  const parsed = BigInt(raw);
  return parsed > 0n ? parsed : 100000n;
}

async function assertPoolHealthy(rpcUrl: string): Promise<void> {
  const publicClient = createPublicClient({
    chain: arbitrum,
    transport: http(rpcUrl)
  });
  const poolAddress = getPoolAddress();
  const [liquidity, slot0] = await Promise.all([
    publicClient.readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: "liquidity"
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: "slot0"
    })
  ]);

  if (liquidity < getPoolMinLiquidity()) {
    throw new Error(`pool liquidity below threshold: ${liquidity.toString()}`);
  }
  const currentTick = Number(slot0[1]);
  const { tickLower, tickUpper } = getMintTickRange();
  if (currentTick < tickLower || currentTick > tickUpper) {
    throw new Error(`pool tick out of configured range: tick=${currentTick}`);
  }
}

async function submitUniswapTxsIfLive(
  context: AdapterExecutionContext,
  usdcUsdtAmount: number
): Promise<{ approveUsdcTxId: string; approveUsdtTxId: string; mintTxId: string }> {
  const rpcUrl = process.env.ARBITRUM_RPC_URL;
  if (!rpcUrl) {
    throw new Error("live uniswap execution requires ARBITRUM_RPC_URL");
  }
  const maxLiveDepositUsd = getMaxLiveDepositUsd();
  if (context.depositUsd > maxLiveDepositUsd) {
    throw new Error(`live uniswap execution exceeds configured amount cap: ${context.depositUsd} > ${maxLiveDepositUsd}`);
  }
  await assertPoolHealthy(rpcUrl);

  const privateKey = await loadArbitrumExecutorPrivateKey();
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: arbitrum,
    transport: http(rpcUrl)
  });
  const slippageBps = getSlippageBps();
  const feeTier = getMintFeeTier();
  const { tickLower, tickUpper } = getMintTickRange();
  const deadlineSec = getDeadlineSec();
  const stablePrice = await getUsdcUsdtPrice();
  const ratio = stablePrice.usdcUsd / stablePrice.usdtUsd;
  const usdcAmount = usdcUsdtAmount / 2;
  const usdtAmount = usdcAmount * ratio;

  const amount0Desired = parseUnits(usdcAmount.toFixed(6), 6);
  const amount1Desired = parseUnits(usdtAmount.toFixed(6), 6);
  const minFactor = BigInt(10000 - slippageBps);
  const amount0Min = (amount0Desired * minFactor) / 10000n;
  const amount1Min = (amount1Desired * minFactor) / 10000n;

  const approveUsdcData = encodeFunctionData({
    abi: erc20ApproveAbi,
    functionName: "approve",
    args: [POSITION_MANAGER_ARB, amount0Desired]
  });
  const approveUsdcTxId = await walletClient.sendTransaction({
    to: USDC_ARB,
    data: approveUsdcData
  });

  const approveUsdtData = encodeFunctionData({
    abi: erc20ApproveAbi,
    functionName: "approve",
    args: [POSITION_MANAGER_ARB, amount1Desired]
  });
  const approveUsdtTxId = await walletClient.sendTransaction({
    to: USDT_ARB,
    data: approveUsdtData
  });

  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);
  const mintData = encodeFunctionData({
    abi: positionManagerMintAbi,
    functionName: "mint",
    args: [
      {
        token0: USDC_ARB,
        token1: USDT_ARB,
        fee: feeTier,
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        amount0Min,
        amount1Min,
        recipient: account.address,
        deadline
      }
    ]
  });
  const mintTxId = await walletClient.sendTransaction({
    to: POSITION_MANAGER_ARB,
    data: mintData,
    value: 0n
  });

  return { approveUsdcTxId, approveUsdtTxId, mintTxId };
}

/**
 * (network:subtype) → Uniswap 배분 테이블.
 * Arbitrum 풀은 live 실행 가능. Base/Ethereum 풀은 시뮬레이션 전용.
 *
 *   multi-stable    Arb USDC-USDT 35%
 *   multi-balanced  Arb ETH-USDC  30%  (±50% 범위)
 *   arb-stable      Arb USDC-USDT 35% + Arb ETH-USDC 20%
 *   base-stable     Base ETH-USDC 30% + Base USDC-USDT 20%  (시뮬레이션)
 *   sol-stable      0%
 */
type UniswapAlloc = {
  chain: "Arbitrum" | "Base" | "Ethereum";
  action: string;
  weight: number;
  isArbLive?: boolean; // true면 live 모드에서 실제 Arbitrum TX를 시도
};

const UNISWAP_ALLOC_TABLE: Record<string, UniswapAlloc[]> = {
  "Multi:multi-stable": [
    { chain: "Arbitrum", action: "USDC-USDT LP (0.01%)", weight: 0.35, isArbLive: true }
  ],
  "Multi:multi-balanced": [
    { chain: "Arbitrum", action: "ETH-USDC LP (0.05%, ±50%)", weight: 0.3 }
  ],
  "Arbitrum:arb-stable": [
    { chain: "Arbitrum", action: "USDC-USDT LP (0.01%)", weight: 0.35, isArbLive: true },
    { chain: "Arbitrum", action: "ETH-USDC LP (0.05%, ±50%)", weight: 0.2 }
  ],
  "Base:base-stable": [
    { chain: "Base", action: "ETH-USDC LP (0.05%)", weight: 0.3 },
    { chain: "Base", action: "USDC-USDT LP (0.01%)", weight: 0.2 }
  ],
  "Solana:sol-stable": [],
  // Ethereum — 시뮬레이션 전용. defi_anal.py 기준: USDC-USDT 0.01% ~5%
  "Ethereum:eth-stable": [
    { chain: "Ethereum", action: "USDC-USDT LP (0.01%)", weight: 0.25 }
  ],
  // Ethereum Blue-chip — ETH-USDC 0.05% ~12% (defi_anal.py 기준)
  "Ethereum:eth-bluechip": [
    { chain: "Ethereum", action: "ETH-USDC LP (0.05%)", weight: 0.3 }
  ]
};

const UNI_MULTI_FALLBACK: UniswapAlloc[] = [
  { chain: "Arbitrum", action: "USDC-USDT LP (0.01%)", weight: 0.25, isArbLive: true },
  { chain: "Arbitrum", action: "ETH-USDC LP (0.05%, ±50%)", weight: 0.15 }
];

export async function executeUniswapPlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const network = context.productNetwork ?? "Multi";
  const subtype = context.productSubtype ?? "";

  const tableKey = `${network}:${subtype}`;
  const allocs = UNISWAP_ALLOC_TABLE[tableKey] ?? UNI_MULTI_FALLBACK;

  if (allocs.length === 0) return [];

  const results: AdapterExecutionResult[] = [];

  for (const alloc of allocs) {
    const allocUsd = Number((context.depositUsd * alloc.weight).toFixed(2));

    // dry-run 모드: 항상 dry-run 결과 반환
    if (context.mode === "dry-run") {
      results.push({
        protocol: "Uniswap",
        chain: alloc.chain,
        action: alloc.action,
        allocationUsd: allocUsd,
        txId: buildTxId("uni_sim", context),
        status: "dry-run" as const
      });
      continue;
    }

    // live 모드: feature flag 확인
    if (!isAdapterLiveEnabled("Uniswap")) {
      results.push(buildUnsupportedResult(
        { protocol: "Uniswap", chain: alloc.chain, action: alloc.action, allocationUsd: allocUsd },
        "Uniswap live execution requires ENABLE_UNISWAP_LIVE=true and LIVE_EXECUTION_CONFIRM=YES"
      ));
      continue;
    }

    // live 모드 + flag 활성화: Arbitrum USDC-USDT만 실제 TX 시도
    if (alloc.isArbLive) {
      try {
        const liveTx = await submitUniswapTxsIfLive(context, allocUsd);
        results.push(
          {
            protocol: "Uniswap", chain: "Arbitrum",
            action: "USDC approve -> PositionManager",
            allocationUsd: 0, txId: liveTx.approveUsdcTxId, status: "submitted"
          },
          {
            protocol: "Uniswap", chain: "Arbitrum",
            action: "USDT approve -> PositionManager",
            allocationUsd: 0, txId: liveTx.approveUsdtTxId, status: "submitted"
          },
          {
            protocol: "Uniswap", chain: "Arbitrum",
            action: alloc.action,
            allocationUsd: allocUsd, txId: liveTx.mintTxId, status: "submitted"
          }
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          protocol: "Uniswap",
          chain: "Arbitrum",
          action: alloc.action,
          allocationUsd: allocUsd,
          txId: "",
          status: "failed",
          errorMessage: `Uniswap/${alloc.chain}/${alloc.action}: ${msg}`
        });
      }
    } else {
      // Arbitrum 외 풀은 live flag가 있어도 미지원
      results.push(buildUnsupportedResult(
        { protocol: "Uniswap", chain: alloc.chain, action: alloc.action, allocationUsd: allocUsd },
        `Uniswap live execution on ${alloc.chain} is not yet supported (Arbitrum USDC-USDT only)`
      ));
    }
  }

  return results;
}
