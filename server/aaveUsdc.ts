/**
 * aaveUsdc.ts
 *
 * Aave V3 USDC 입금/조회/출금 어댑터.
 * - unsigned transaction 생성 (서버가 서명하지 않음)
 * - receipt 확인 후 Position 확정
 * - getUserReserveData: aToken balance, APY, collateral 상태
 *
 * 지원 체인: Arbitrum, Base
 */
import {
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Chain
} from "viem";
import { arbitrum, base } from "viem/chains";
import { getDb } from "./db";
import { createDepositPosition } from "./positions";
import {
  createDepositIntentsFromAdapterResults,
  createExecution,
  createPositionFromExecution,
  updateDepositIntentStatus,
  updateExecutionConfirmed
} from "./intentStore";
import { createJob } from "./store";

export type AaveUsdcChain = "Arbitrum" | "Base";

type AaveUsdcConfig = {
  chain: Chain;
  chainId: number;
  pool: Address;
  usdc: Address;
  /** Aave V3 USDC eMode category (stablecoin 풀에서 LTV 최적화) */
  eModeCategory: number;
  envKeys: string[];
  fallbackRpcUrls: string[];
};

const AAVE_USDC: Record<AaveUsdcChain, AaveUsdcConfig> = {
  Arbitrum: {
    chain: arbitrum,
    chainId: 42161,
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    eModeCategory: 1, // stablecoin eMode
    envKeys: ["ARBITRUM_RPC_URL"],
    fallbackRpcUrls: ["https://arbitrum-one-rpc.publicnode.com", "https://rpc.ankr.com/arbitrum"]
  },
  Base: {
    chain: base,
    chainId: 8453,
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    eModeCategory: 1,
    envKeys: ["BASE_RPC_URL"],
    fallbackRpcUrls: ["https://base-rpc.publicnode.com", "https://rpc.ankr.com/base"]
  }
};

// ──────────────────────────────────────────────────────────────────────────────
//  ABIs
// ──────────────────────────────────────────────────────────────────────────────

const erc20Abi = [
  {
    type: "function", name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function", name: "allowance",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function", name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }]
  }
] as const;

const aavePoolAbi = [
  {
    type: "function", name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" }
    ],
    outputs: []
  },
  {
    type: "function", name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" }
    ],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function", name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      {
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
      }
    ]
  },
  {
    type: "function", name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" }
    ]
  }
] as const;

// ──────────────────────────────────────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────────────────────────────────────

export type AaveTxRequest = {
  kind: "approve" | "supply" | "withdraw";
  chain: AaveUsdcChain;
  chainId: number;
  from: string;
  to: string;
  data: string;
  value: "0x0";
  description: string;
};

export type AaveUserReserveData = {
  chain: AaveUsdcChain;
  chainId: number;
  walletAddress: string;
  poolAddress: string;
  underlyingAddress: string;
  aTokenAddress: string;
  /** USDC 지갑 잔고 (USD 환산) */
  walletUsdc: number;
  walletUsdcRaw: string;
  /** Aave Pool 허용액 */
  allowanceRaw: string;
  /** 예치된 aUSDC 잔고 (USD 환산) */
  suppliedUsdc: number;
  suppliedUsdcRaw: string;
  /** Aave V3 공급 APY (연율, 0.05 = 5%) */
  supplyApy: number;
  /** Aave V3 현재 유동성 이율 (ray 단위 원문) */
  liquidityRateRay: string;
  /** 헬스 팩터 (대출 없으면 큰 값) */
  healthFactor: string;
  /** USD 기준 담보 총계 */
  totalCollateralBase: string;
  /** USD 기준 대출 총계 */
  totalDebtBase: string;
  /** 조회 상태: ok | rpc_error | partial */
  queryStatus: "ok" | "rpc_error" | "partial";
  queryError?: string;
};

// ──────────────────────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────────────────────

function assertChain(chain: unknown): AaveUsdcChain {
  if (chain === "Arbitrum" || chain === "Base") return chain;
  throw new Error(`unsupported Aave USDC chain: ${String(chain)}`);
}

function assertAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new Error(`wallet address invalid: ${value}`);
  }
  return getAddress(value);
}

function getRpcCandidates(chain: AaveUsdcChain): string[] {
  const config = AAVE_USDC[chain];
  const envUrls = config.envKeys
    .map((key) => process.env[key]?.trim())
    .filter((url): url is string => Boolean(url));
  return [...envUrls, ...config.fallbackRpcUrls.filter((url) => !envUrls.includes(url))];
}

function getClient(chain: AaveUsdcChain) {
  const rpcUrl = getRpcCandidates(chain)[0];
  if (!rpcUrl) {
    throw new Error(`${chain} RPC URL missing (set ${AAVE_USDC[chain].envKeys[0]})`);
  }
  return createPublicClient({
    chain: AAVE_USDC[chain].chain,
    transport: http(rpcUrl, { timeout: 12_000 })
  });
}

async function getTransactionReceipt(chain: AaveUsdcChain, txHash: string) {
  return getClient(chain).getTransactionReceipt({ hash: txHash as `0x${string}` }).catch(() => null);
}

/**
 * liquidityRate (ray, 1e27 기준) → 연율 APY
 * APY = (1 + liquidityRate / SECONDS_PER_YEAR / 1e27) ^ SECONDS_PER_YEAR - 1
 */
function rayToApy(liquidityRateRay: string): number {
  const SECONDS_PER_YEAR = 31_536_000;
  const RAY = BigInt("1000000000000000000000000000"); // 1e27
  const rateRay = BigInt(liquidityRateRay);
  // 부동소수점으로 변환
  const ratePerSecond = Number(rateRay) / Number(RAY) / SECONDS_PER_YEAR;
  const apy = Math.pow(1 + ratePerSecond, SECONDS_PER_YEAR) - 1;
  return Math.round(apy * 10000) / 10000; // 소수점 4자리
}

async function getAaveReserve(chain: AaveUsdcChain): Promise<{
  aTokenAddress: Address;
  liquidityRateRay: string;
  supplyApy: number;
}> {
  const config = AAVE_USDC[chain];
  const reserve = await getClient(chain).readContract({
    address: config.pool,
    abi: aavePoolAbi,
    functionName: "getReserveData",
    args: [config.usdc]
  });
  const liquidityRateRay = reserve.currentLiquidityRate.toString();
  return {
    aTokenAddress: getAddress(reserve.aTokenAddress),
    liquidityRateRay,
    supplyApy: rayToApy(liquidityRateRay)
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 사용자 지갑의 USDC + aUSDC 잔고, APY, 헬스 팩터를 한 번에 조회한다.
 * RPC 실패 시 queryStatus="rpc_error" 를 반환하며 예외를 던지지 않는다.
 */
export async function getAaveUsdcPosition(
  chainRaw: unknown,
  walletRaw: string
): Promise<AaveUserReserveData> {
  const chain = assertChain(chainRaw);
  const walletAddress = assertAddress(walletRaw);
  const config = AAVE_USDC[chain];

  try {
    const client = getClient(chain);
    const reserve = await getAaveReserve(chain);

    const [walletUsdcRaw, allowanceRaw, suppliedUsdcRaw, accountData] = await Promise.all([
      client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [walletAddress] }),
      client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "allowance", args: [walletAddress, config.pool] }),
      client.readContract({ address: reserve.aTokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [walletAddress] }),
      client.readContract({ address: config.pool, abi: aavePoolAbi, functionName: "getUserAccountData", args: [walletAddress] })
    ]);

    return {
      chain,
      chainId: config.chainId,
      walletAddress,
      poolAddress: config.pool,
      underlyingAddress: config.usdc,
      aTokenAddress: reserve.aTokenAddress,
      walletUsdc: Number(formatUnits(walletUsdcRaw, 6)),
      walletUsdcRaw: walletUsdcRaw.toString(),
      allowanceRaw: allowanceRaw.toString(),
      suppliedUsdc: Number(formatUnits(suppliedUsdcRaw, 6)),
      suppliedUsdcRaw: suppliedUsdcRaw.toString(),
      supplyApy: reserve.supplyApy,
      liquidityRateRay: reserve.liquidityRateRay,
      healthFactor: formatUnits(accountData[5], 18),
      totalCollateralBase: accountData[0].toString(),
      totalDebtBase: accountData[1].toString(),
      queryStatus: "ok"
    };
  } catch (err) {
    const queryError = err instanceof Error ? err.message : String(err);
    return {
      chain,
      chainId: config.chainId,
      walletAddress,
      poolAddress: config.pool,
      underlyingAddress: config.usdc,
      aTokenAddress: "0x",
      walletUsdc: 0,
      walletUsdcRaw: "0",
      allowanceRaw: "0",
      suppliedUsdc: 0,
      suppliedUsdcRaw: "0",
      supplyApy: 0,
      liquidityRateRay: "0",
      healthFactor: "0",
      totalCollateralBase: "0",
      totalDebtBase: "0",
      queryStatus: "rpc_error",
      queryError
    };
  }
}

/**
 * Aave V3 USDC 입금에 필요한 unsigned transactions 생성.
 * 1. 잔고 부족 시 즉시 에러
 * 2. allowance 부족 시 approve tx 포함
 * 3. supply tx 포함
 * 서버는 tx를 서명하지 않으며, 프론트엔드가 지갑으로 서명한다.
 */
export async function buildAaveUsdcSupplyTransactions(input: {
  chain: unknown;
  walletAddress: string;
  amountUsdc: number;
}): Promise<{
  amountRaw: string;
  transactions: AaveTxRequest[];
  position: AaveUserReserveData;
  quoteSnapshot: {
    supplyApy: number;
    walletUsdc: number;
    suppliedUsdc: number;
    priceUsd: number;
    expiresAt: string;
  };
}> {
  const chain = assertChain(input.chain);
  const walletAddress = assertAddress(input.walletAddress);
  if (!Number.isFinite(input.amountUsdc) || input.amountUsdc <= 0) {
    throw new Error("amountUsdc required and must be > 0");
  }
  const config = AAVE_USDC[chain];
  const amountRaw = parseUnits(input.amountUsdc.toFixed(6), 6);
  const position = await getAaveUsdcPosition(chain, walletAddress);

  if (position.queryStatus === "rpc_error") {
    throw new Error(`RPC error on ${chain}: ${position.queryError ?? "unknown"}`);
  }
  if (BigInt(position.walletUsdcRaw) < amountRaw) {
    throw new Error(
      `Insufficient ${chain} USDC balance: have ${position.walletUsdc.toFixed(6)}, need ${input.amountUsdc.toFixed(6)}`
    );
  }

  const transactions: AaveTxRequest[] = [];

  // allowance 부족 시 approve tx 추가
  if (BigInt(position.allowanceRaw) < amountRaw) {
    transactions.push({
      kind: "approve",
      chain,
      chainId: config.chainId,
      from: walletAddress,
      to: config.usdc,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [config.pool, amountRaw]
      }),
      value: "0x0",
      description: `Approve Aave V3 Pool to spend ${input.amountUsdc.toFixed(6)} USDC on ${chain}`
    });
  }

  transactions.push({
    kind: "supply",
    chain,
    chainId: config.chainId,
    from: walletAddress,
    to: config.pool,
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "supply",
      args: [config.usdc, amountRaw, walletAddress, 0]
    }),
    value: "0x0",
    description: `Supply ${input.amountUsdc.toFixed(6)} USDC to Aave V3 on ${chain} (APY: ${(position.supplyApy * 100).toFixed(2)}%)`
  });

  // quote는 5분 유효
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  return {
    amountRaw: amountRaw.toString(),
    transactions,
    position,
    quoteSnapshot: {
      supplyApy: position.supplyApy,
      walletUsdc: position.walletUsdc,
      suppliedUsdc: position.suppliedUsdc,
      priceUsd: 1.0, // USDC는 1:1
      expiresAt
    }
  };
}

/**
 * Aave V3 USDC 출금에 필요한 unsigned transaction 생성.
 * amountUsdc = 0 이면 전체 출금 (uint256 max).
 */
export async function buildAaveUsdcWithdrawTransaction(input: {
  chain: unknown;
  walletAddress: string;
  amountUsdc: number;
}): Promise<{
  amountRaw: string;
  transaction: AaveTxRequest;
  position: AaveUserReserveData;
  isMaxWithdraw: boolean;
}> {
  const chain = assertChain(input.chain);
  const walletAddress = assertAddress(input.walletAddress);
  if (!Number.isFinite(input.amountUsdc) || input.amountUsdc < 0) {
    throw new Error("amountUsdc must be >= 0 (0 = full withdrawal)");
  }
  const config = AAVE_USDC[chain];
  const position = await getAaveUsdcPosition(chain, walletAddress);

  if (position.queryStatus === "rpc_error") {
    throw new Error(`RPC error on ${chain}: ${position.queryError ?? "unknown"}`);
  }

  const isMaxWithdraw = input.amountUsdc === 0 || input.amountUsdc >= position.suppliedUsdc;

  // 전체 출금 시 uint256.max 사용 (aToken 전량 소각)
  const amountRaw = isMaxWithdraw
    ? BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
    : parseUnits(input.amountUsdc.toFixed(6), 6);

  if (!isMaxWithdraw && BigInt(position.suppliedUsdcRaw) < amountRaw) {
    throw new Error(
      `Insufficient Aave ${chain} aUSDC balance: have ${position.suppliedUsdc.toFixed(6)}, need ${input.amountUsdc.toFixed(6)}`
    );
  }

  return {
    amountRaw: amountRaw.toString(),
    isMaxWithdraw,
    position,
    transaction: {
      kind: "withdraw",
      chain,
      chainId: config.chainId,
      from: walletAddress,
      to: config.pool,
      data: encodeFunctionData({
        abi: aavePoolAbi,
        functionName: "withdraw",
        args: [config.usdc, amountRaw, walletAddress]
      }),
      value: "0x0",
      description: isMaxWithdraw
        ? `Withdraw all USDC from Aave V3 on ${chain}`
        : `Withdraw ${input.amountUsdc.toFixed(6)} USDC from Aave V3 on ${chain}`
    }
  };
}

/**
 * receipt 확인 후 AaveUsdcPosition 및 새 Position 모델에 기록.
 * receipt 없이 포지션 생성 불가.
 */
export async function confirmAaveUsdcTransaction(
  username: string,
  input: {
    chain: unknown;
    walletAddress: string;
    txHash: string;
    kind: "supply" | "withdraw";
    amountUsdc: number;
  }
): Promise<{ status: "pending" | "confirmed"; position?: unknown }> {
  const chain = assertChain(input.chain);
  const walletAddress = assertAddress(input.walletAddress);
  const txHash = input.txHash.trim() as `0x${string}`;

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error(`txHash invalid format: ${txHash}`);
  }
  if (!Number.isFinite(input.amountUsdc) || input.amountUsdc <= 0) {
    throw new Error("amountUsdc required and must be > 0");
  }

  const client = getClient(chain);
  const receipt = await getTransactionReceipt(chain, txHash);

  if (!receipt) {
    return { status: "pending" };
  }
  if (receipt.status !== "success") {
    throw new Error(`Aave transaction reverted on ${chain} (txHash: ${txHash})`);
  }

  const config = AAVE_USDC[chain];
  // 발신자/수신자 검증
  if (getAddress(receipt.from) !== walletAddress) {
    throw new Error(`Transaction sender mismatch: expected ${walletAddress}, got ${receipt.from}`);
  }
  if (!receipt.to || getAddress(receipt.to) !== config.pool) {
    throw new Error(`Transaction target mismatch: expected Aave Pool ${config.pool}`);
  }

  const now = new Date().toISOString();
  const reserve = await getAaveReserve(chain);
  const amountRaw = parseUnits(input.amountUsdc.toFixed(6), 6).toString();
  const db = getDb();

  if (input.kind === "supply") {
    // idempotency: 이미 처리된 tx
    const existing = await db.aaveUsdcPosition.findUnique({ where: { depositTxHash: txHash } });
    if (existing) {
      return { status: "confirmed", position: existing };
    }

    const directJob = await createJob(
      {
        depositUsd: input.amountUsdc,
        isRangeOut: false,
        isDepegAlert: false,
        hasPendingRelease: false,
        sourceAsset: "USDC",
        productNetwork: chain,
        productSubtype: chain === "Base" ? "base-stable" : "arb-stable"
      },
      username
    );
    const [intent] = await createDepositIntentsFromAdapterResults(
      directJob.id,
      username,
      [
        {
          protocol: "Aave",
          chain,
          action: "USDC Supply (eMode)",
          allocationUsd: input.amountUsdc,
          txId: txHash,
          status: "confirmed"
        }
      ],
      "USDC"
    );
    if (!intent) {
      throw new Error("Aave direct intent creation failed");
    }

    // 레거시 DepositPosition 기록
    const depositPosition = await createDepositPosition(username, {
      productName: `Aave V3 ${chain} USDC`,
      amountUsd: input.amountUsdc,
      expectedApr: reserve.supplyApy,
      protocolMix: [{ name: "Aave", weight: 1, pool: `${chain} · USDC Supply` }]
    });

    // 레거시 AaveUsdcPosition 기록
    const created = await db.aaveUsdcPosition.create({
      data: {
        id: `aave_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        username,
        walletAddress,
        chain,
        asset: "USDC",
        poolAddress: config.pool,
        underlyingAddress: config.usdc,
        aTokenAddress: reserve.aTokenAddress,
        amountRaw,
        amountUsd: input.amountUsdc,
        depositTxHash: txHash,
        status: "open",
        depositPositionId: depositPosition.id,
        createdAt: now,
        updatedAt: now
      }
    });
    await updateDepositIntentStatus(intent.id, "completed").catch(() => undefined);
    await db.$executeRawUnsafe(`UPDATE jobs SET status = 'executed' WHERE id = ?`, directJob.id);

    // 새 Position 모델에 기록 (receipt 확인 후)
    // 임시 DepositIntent + Execution 생성 → Position 확정
    try {
      const execution = await createExecution({
        intentId: intent.id,
        protocol: "Aave",
        chain,
        action: "USDC Supply (eMode)",
        txHash,
        status: "confirmed",
        idempotencyKey: `aave_supply_${txHash}`
      });

      await updateExecutionConfirmed({
        executionId: execution.id,
        txHash,
        blockNumber: receipt.blockNumber ? Number(receipt.blockNumber) : undefined,
        receiptJson: JSON.stringify({ status: receipt.status, blockNumber: receipt.blockNumber?.toString(), from: receipt.from, to: receipt.to })
      });

      const confirmedExecution = { ...execution, status: "confirmed" as const, txHash };
      await createPositionFromExecution({
        execution: confirmedExecution,
        username,
        asset: "USDC",
        amountUsd: input.amountUsdc,
        poolAddress: config.pool,
        positionToken: reserve.aTokenAddress,
        positionRaw: amountRaw
      });
    } catch (posErr) {
      // Position 기록 실패는 non-fatal (레거시 AaveUsdcPosition은 이미 기록됨)
      console.error("new position model record failed (non-fatal):", posErr);
    }

    return { status: "confirmed", position: created };
  }

  // withdraw 처리
  const openRows = await db.aaveUsdcPosition.findMany({
    where: { username, walletAddress, chain, status: "open" },
    orderBy: { createdAt: "desc" }
  });
  let remaining = input.amountUsdc;
  for (const row of openRows) {
    if (remaining <= 0) break;
    const take = Math.min(row.amountUsd, remaining);
    const nextAmountUsd = Number((row.amountUsd - take).toFixed(6));
    await db.aaveUsdcPosition.update({
      where: { id: row.id },
      data: {
        amountUsd: nextAmountUsd,
        amountRaw: parseUnits(Math.max(0, nextAmountUsd).toFixed(6), 6).toString(),
        withdrawTxHash: txHash,
        status: nextAmountUsd <= 0.000001 ? "closed" : "open",
        updatedAt: now
      }
    });
    if (row.depositPositionId) {
      if (nextAmountUsd <= 0.000001) {
        await db.depositPosition.delete({ where: { id: row.depositPositionId } }).catch(() => undefined);
      } else {
        await db.depositPosition
          .update({ where: { id: row.depositPositionId }, data: { amountUsd: nextAmountUsd } })
          .catch(() => undefined);
      }
    }
    remaining -= take;
  }
  const actualWithdrawn = input.amountUsdc - Math.max(0, remaining);
  if (actualWithdrawn > 0) {
    await db.withdrawalLedger.create({
      data: {
        id: `wd_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        username,
        amountUsd: Number(actualWithdrawn.toFixed(2)),
        createdAt: now
      }
    });
  }

  return { status: "confirmed" };
}

export const AAVE_USDC_CHAINS = Object.keys(AAVE_USDC) as AaveUsdcChain[];

export async function checkAaveUsdcTransaction(
  chainRaw: unknown,
  txHashRaw: string
): Promise<{
  status: "pending" | "confirmed";
  receipt?: {
    from: string;
    to: string | null;
    blockNumber: string | null;
    status: string;
  };
}> {
  const chain = assertChain(chainRaw);
  const txHash = txHashRaw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error("txHash invalid");
  }
  const receipt = await getTransactionReceipt(chain, txHash);
  if (!receipt) {
    return { status: "pending" };
  }
  return {
    status: receipt.status === "success" ? "confirmed" : "pending",
    receipt: {
      from: receipt.from,
      to: receipt.to ?? null,
      blockNumber: receipt.blockNumber?.toString() ?? null,
      status: receipt.status
    }
  };
}
