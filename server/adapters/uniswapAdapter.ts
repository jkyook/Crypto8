import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { getUsdcUsdtPrice } from "./priceFeed";

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
  const privateKey = process.env.ARBITRUM_EXECUTOR_PRIVATE_KEY;
  const rpcUrl = process.env.ARBITRUM_RPC_URL;
  if (!privateKey || !rpcUrl) {
    throw new Error("live uniswap execution requires ARBITRUM_EXECUTOR_PRIVATE_KEY and ARBITRUM_RPC_URL");
  }
  await assertPoolHealthy(rpcUrl);

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

export async function executeUniswapPlan(context: AdapterExecutionContext): Promise<AdapterExecutionResult[]> {
  const usdcUsdtAmount = Number((context.depositUsd * 0.25).toFixed(2));
  const ethUsdcAmount = Number((context.depositUsd * 0.15).toFixed(2));
  const status = context.mode === "live" ? "submitted" : "simulated";
  const txPrefix = context.mode === "live" ? "uni_live" : "uni_sim";
  let approveUsdcTxId = buildTxId(txPrefix, context);
  let approveUsdtTxId = buildTxId(txPrefix, context);
  let mintTxId = buildTxId(txPrefix, context);

  if (context.mode === "live") {
    const liveTx = await submitUniswapTxsIfLive(context, usdcUsdtAmount);
    approveUsdcTxId = liveTx.approveUsdcTxId;
    approveUsdtTxId = liveTx.approveUsdtTxId;
    mintTxId = liveTx.mintTxId;
  }

  return [
    {
      protocol: "Uniswap",
      chain: "Arbitrum",
      action: "USDC approve -> PositionManager (USDC-USDT)",
      allocationUsd: 0,
      txId: approveUsdcTxId,
      status
    },
    {
      protocol: "Uniswap",
      chain: "Arbitrum",
      action: "USDT approve -> PositionManager (USDC-USDT)",
      allocationUsd: 0,
      txId: approveUsdtTxId,
      status
    },
    {
      protocol: "Uniswap",
      chain: "Arbitrum",
      action: "USDC-USDT mint (0.01%, full range)",
      allocationUsd: usdcUsdtAmount,
      txId: mintTxId,
      status
    },
    {
      protocol: "Uniswap",
      chain: "Arbitrum",
      action: "ETH-USDC LP route prepared (next: mint position tx)",
      allocationUsd: ethUsdcAmount,
      txId: buildTxId(txPrefix, context),
      status
    }
  ];
}
