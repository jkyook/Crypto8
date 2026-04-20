import { createPublicClient, encodeFunctionData, formatUnits, getAddress, http, isAddress, parseUnits, type Address, type Chain } from "viem";
import { arbitrum, base } from "viem/chains";
import { getDb } from "./db";
import { createDepositPosition } from "./positions";

export type AaveUsdcChain = "Arbitrum" | "Base";

type AaveUsdcConfig = {
  chain: Chain;
  chainId: number;
  pool: Address;
  usdc: Address;
  envKeys: string[];
  fallbackRpcUrls: string[];
};

const AAVE_USDC: Record<AaveUsdcChain, AaveUsdcConfig> = {
  Arbitrum: {
    chain: arbitrum,
    chainId: 42161,
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    envKeys: ["ARBITRUM_RPC_URL"],
    fallbackRpcUrls: ["https://arbitrum-one-rpc.publicnode.com", "https://rpc.ankr.com/arbitrum"]
  },
  Base: {
    chain: base,
    chainId: 8453,
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    envKeys: ["BASE_RPC_URL"],
    fallbackRpcUrls: ["https://base-rpc.publicnode.com", "https://rpc.ankr.com/base"]
  }
};

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bool" }]
  }
] as const;

const aavePoolAbi = [
  {
    type: "function",
    name: "supply",
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
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" }
    ],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
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
  }
] as const;

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

function assertChain(chain: unknown): AaveUsdcChain {
  if (chain === "Arbitrum" || chain === "Base") return chain;
  throw new Error("unsupported Aave USDC chain");
}

function assertAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new Error("wallet address invalid");
  }
  return getAddress(value);
}

function getRpcCandidates(chain: AaveUsdcChain): string[] {
  const config = AAVE_USDC[chain];
  const envUrls = config.envKeys.map((key) => process.env[key]?.trim()).filter((url): url is string => Boolean(url));
  return [...envUrls, ...config.fallbackRpcUrls.filter((url) => !envUrls.includes(url))];
}

function getClient(chain: AaveUsdcChain) {
  const rpcUrl = getRpcCandidates(chain)[0];
  if (!rpcUrl) {
    throw new Error(`${chain} RPC URL missing`);
  }
  return createPublicClient({ chain: AAVE_USDC[chain].chain, transport: http(rpcUrl, { timeout: 10_000 }) });
}

async function getAaveReserve(chain: AaveUsdcChain): Promise<{ aTokenAddress: Address; liquidityRateRay: string }> {
  const config = AAVE_USDC[chain];
  const reserve = await getClient(chain).readContract({
    address: config.pool,
    abi: aavePoolAbi,
    functionName: "getReserveData",
    args: [config.usdc]
  });
  return {
    aTokenAddress: getAddress(reserve.aTokenAddress),
    liquidityRateRay: reserve.currentLiquidityRate.toString()
  };
}

export async function getAaveUsdcPosition(chainRaw: unknown, walletRaw: string): Promise<{
  chain: AaveUsdcChain;
  chainId: number;
  walletAddress: string;
  poolAddress: string;
  underlyingAddress: string;
  aTokenAddress: string;
  walletUsdc: number;
  walletUsdcRaw: string;
  allowanceRaw: string;
  suppliedUsdc: number;
  suppliedUsdcRaw: string;
  liquidityRateRay: string;
}> {
  const chain = assertChain(chainRaw);
  const walletAddress = assertAddress(walletRaw);
  const config = AAVE_USDC[chain];
  const client = getClient(chain);
  const reserve = await getAaveReserve(chain);
  const [walletUsdcRaw, allowanceRaw, suppliedUsdcRaw] = await Promise.all([
    client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [walletAddress] }),
    client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "allowance", args: [walletAddress, config.pool] }),
    client.readContract({ address: reserve.aTokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [walletAddress] })
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
    liquidityRateRay: reserve.liquidityRateRay
  };
}

export async function buildAaveUsdcSupplyTransactions(input: {
  chain: unknown;
  walletAddress: string;
  amountUsdc: number;
}): Promise<{ amountRaw: string; transactions: AaveTxRequest[]; position: Awaited<ReturnType<typeof getAaveUsdcPosition>> }> {
  const chain = assertChain(input.chain);
  const walletAddress = assertAddress(input.walletAddress);
  if (!Number.isFinite(input.amountUsdc) || input.amountUsdc <= 0) {
    throw new Error("amountUsdc required");
  }
  const config = AAVE_USDC[chain];
  const amountRaw = parseUnits(input.amountUsdc.toFixed(6), 6);
  const position = await getAaveUsdcPosition(chain, walletAddress);
  if (BigInt(position.walletUsdcRaw) < amountRaw) {
    throw new Error(`insufficient ${chain} USDC balance`);
  }
  const transactions: AaveTxRequest[] = [];
  if (BigInt(position.allowanceRaw) < amountRaw) {
    transactions.push({
      kind: "approve",
      chain,
      chainId: config.chainId,
      from: walletAddress,
      to: config.usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [config.pool, amountRaw] }),
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
    data: encodeFunctionData({ abi: aavePoolAbi, functionName: "supply", args: [config.usdc, amountRaw, walletAddress, 0] }),
    value: "0x0",
    description: `Supply ${input.amountUsdc.toFixed(6)} USDC to Aave V3 on ${chain}`
  });
  return { amountRaw: amountRaw.toString(), transactions, position };
}

export async function buildAaveUsdcWithdrawTransaction(input: {
  chain: unknown;
  walletAddress: string;
  amountUsdc: number;
}): Promise<{ amountRaw: string; transaction: AaveTxRequest; position: Awaited<ReturnType<typeof getAaveUsdcPosition>> }> {
  const chain = assertChain(input.chain);
  const walletAddress = assertAddress(input.walletAddress);
  if (!Number.isFinite(input.amountUsdc) || input.amountUsdc <= 0) {
    throw new Error("amountUsdc required");
  }
  const config = AAVE_USDC[chain];
  const amountRaw = parseUnits(input.amountUsdc.toFixed(6), 6);
  const position = await getAaveUsdcPosition(chain, walletAddress);
  if (BigInt(position.suppliedUsdcRaw) < amountRaw) {
    throw new Error(`insufficient Aave ${chain} aUSDC balance`);
  }
  return {
    amountRaw: amountRaw.toString(),
    position,
    transaction: {
      kind: "withdraw",
      chain,
      chainId: config.chainId,
      from: walletAddress,
      to: config.pool,
      data: encodeFunctionData({ abi: aavePoolAbi, functionName: "withdraw", args: [config.usdc, amountRaw, walletAddress] }),
      value: "0x0",
      description: `Withdraw ${input.amountUsdc.toFixed(6)} USDC from Aave V3 on ${chain}`
    }
  };
}

export async function confirmAaveUsdcTransaction(username: string, input: {
  chain: unknown;
  walletAddress: string;
  txHash: string;
  kind: "supply" | "withdraw";
  amountUsdc: number;
}): Promise<{ status: "pending" | "confirmed"; position?: unknown }> {
  const chain = assertChain(input.chain);
  const walletAddress = assertAddress(input.walletAddress);
  const txHash = input.txHash.trim() as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error("txHash invalid");
  }
  if (!Number.isFinite(input.amountUsdc) || input.amountUsdc <= 0) {
    throw new Error("amountUsdc required");
  }
  const receipt = await getClient(chain).getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt) {
    return { status: "pending" };
  }
  if (receipt.status !== "success") {
    throw new Error("Aave transaction receipt failed");
  }
  const config = AAVE_USDC[chain];
  if (getAddress(receipt.from) !== walletAddress || !receipt.to || getAddress(receipt.to) !== config.pool) {
    throw new Error("Aave transaction receipt does not match wallet and pool");
  }
  const now = new Date().toISOString();
  const reserve = await getAaveReserve(chain);
  const amountRaw = parseUnits(input.amountUsdc.toFixed(6), 6).toString();
  const db = getDb();
  if (input.kind === "supply") {
    const existing = await db.aaveUsdcPosition.findUnique({ where: { depositTxHash: txHash } });
    if (existing) {
      return { status: "confirmed", position: existing };
    }
    const depositPosition = await createDepositPosition(username, {
      productName: `Aave V3 ${chain} USDC`,
      amountUsd: input.amountUsdc,
      expectedApr: 0.03,
      protocolMix: [{ name: "Aave", weight: 1, pool: `${chain} · USDC Supply` }]
    });
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
    return { status: "confirmed", position: created };
  }
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
        await db.depositPosition.update({ where: { id: row.depositPositionId }, data: { amountUsd: nextAmountUsd } }).catch(() => undefined);
      }
    }
    remaining -= take;
  }
  if (input.amountUsdc - remaining > 0) {
    await db.withdrawalLedger.create({
      data: {
        id: `wd_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        username,
        amountUsd: Number((input.amountUsdc - remaining).toFixed(2)),
        createdAt: now
      }
    });
  }
  return { status: "confirmed" };
}

export const AAVE_USDC_CHAINS = Object.keys(AAVE_USDC) as AaveUsdcChain[];
