import { Fragment, useEffect, useMemo, useState } from "react";
import { AddressType } from "@phantom/browser-sdk";
import { useAccounts } from "@phantom/react-sdk";
import {
  getSession,
  createDepositPositionRemote,
  adjustDepositPositionRemote,
  listPublicOnchainPositions,
  listOnchainPositionHistory,
  login,
  type OnchainPositionHistoryPoint,
  type OnchainPositionPayload
} from "../lib/api";
import { DEFAULT_PRODUCTS } from "../lib/productCatalog";
import { estimateAnnualYieldUsd } from "../lib/portfolioMetrics";
import {
  inferProtocolChain,
  getProtocolSortRank,
  isPoolDepositPossible,
  isPoolPositionQueryable,
  getPoolDepositReason,
  getPoolQueryReason,
  getUniswapNpmAddress,
  shortPositionId,
  onchainVerifyLabel,
  onchainVerifyBadgeClass
} from "../lib/protocolChain";
import { ChainExposureDonut } from "./common/ChainExposureDonut";
import { OnchainPositionHistoryChart } from "./OnchainPositionHistoryChart";
import { OrchestratorBoard } from "./OrchestratorBoard";
import { TradeControls } from "./common/TradeControls";
import type { DepositPosition, PoolCatalogRow, ProtocolDetailRow, ProtocolPoolMatchState } from "../types/portfolio";

type OnchainQueryCache = {
  rows: OnchainPositionPayload[];
  matchMap: Record<string, { state: ProtocolPoolMatchState; detail: string }>;
  catalogMatchMap: Record<string, { state: ProtocolPoolMatchState; detail: string }>;
  summary: string;
  hidden: boolean;
  savedAt: string;
};

type UniswapOnchainDetail = {
  source?: string;
  chain?: string;
  tokenId?: string;
  poolAddress?: string;
  poolLabel?: string;
  token0?: string;
  token1?: string;
  tokenSymbolA?: string;
  tokenSymbolB?: string;
  fee?: number;
  tickLower?: number;
  tickUpper?: number;
  tickCurrent?: number;
  currentPrice?: number;
  rangeLowerPrice?: number;
  rangeUpperPrice?: number;
  amount0Raw?: string;
  amount1Raw?: string;
  amount0Usd?: number;
  amount1Usd?: number;
  feesOwed0Raw?: string;
  feesOwed1Raw?: string;
  feesOwed0Usd?: number;
  feesOwed1Usd?: number;
  amountUsd?: number;
  pendingYieldUsd?: number;
  estimatedApr?: number | null;
  estimatedDailyYieldUsd?: number | null;
};

export function PortfolioPanel({
  positions,
  onExecutionComplete,
  onWithdraw,
  onWithdrawTarget,
  canPersistToServer,
  hasSession,
  onResetLedger,
  hasLedgerEntries
}: {
  positions: DepositPosition[];
  onExecutionComplete?: () => void | Promise<void>;
  onWithdraw?: (amountUsd: number) => Promise<void>;
  onWithdrawTarget?: (amountUsd: number, target: Pick<ProtocolDetailRow, "name" | "chain" | "pool">) => Promise<void>;
  canPersistToServer?: boolean;
  /** 세션 존재 여부(로그인 방식 무관) — 지갑 없이 로그인한 경우 안내 표시용 */
  hasSession?: boolean;
  onResetLedger?: () => Promise<void>;
  hasLedgerEntries?: boolean;
}) {
  const accounts = useAccounts();
  const solanaAccount = accounts?.find((account) => account.addressType === AddressType.solana);
  const evmAccount = accounts?.find((account) => account.addressType === AddressType.ethereum);
  const [protocolAmounts, setProtocolAmounts] = useState<Record<string, number>>({});
  const [protocolDepositDraft, setProtocolDepositDraft] = useState<ProtocolDetailRow | null>(null);
  const [protocolDepositKey, setProtocolDepositKey] = useState(0);
  const [showPositionDetails, setShowPositionDetails] = useState(false);
  const [onchainMatchMap, setOnchainMatchMap] = useState<Record<string, { state: ProtocolPoolMatchState; detail: string }>>({});
  const [onchainCatalogMatchMap, setOnchainCatalogMatchMap] = useState<Record<string, { state: ProtocolPoolMatchState; detail: string }>>({});
  const [onchainQueriedRows, setOnchainQueriedRows] = useState<OnchainPositionPayload[]>([]);
  const [onchainMatchSummary, setOnchainMatchSummary] = useState("");
  const [onchainMatchLoading, setOnchainMatchLoading] = useState(false);
  const [onchainMatchError, setOnchainMatchError] = useState("");
  const [hideOnchainResult, setHideOnchainResult] = useState(false);
  const [showQueryablePools, setShowQueryablePools] = useState(false);
  const [ledgerResetLoading, setLedgerResetLoading] = useState(false);
  const [ledgerResetError, setLedgerResetError] = useState("");
  const [ledgerSyncLoadingKey, setLedgerSyncLoadingKey] = useState("");
  const [ledgerSyncMessage, setLedgerSyncMessage] = useState("");
  const [ledgerSyncError, setLedgerSyncError] = useState("");
  const [selectedOnchainRowKey, setSelectedOnchainRowKey] = useState<string>("");
  const [selectedOnchainHistoryPoints, setSelectedOnchainHistoryPoints] = useState<OnchainPositionHistoryPoint[]>([]);
  const [selectedOnchainHistoryLoading, setSelectedOnchainHistoryLoading] = useState(false);
  const [selectedOnchainHistoryError, setSelectedOnchainHistoryError] = useState("");

  const onchainQueryStorageKey = useMemo(() => {
    const session = getSession();
    const usernameKey = session?.username?.trim() || "guest";
    return [
      "crypto8",
      "onchain-query-cache",
      usernameKey,
      evmAccount?.address?.toLowerCase() || "no-evm",
      solanaAccount?.address?.toLowerCase() || "no-sol"
    ].join(":");
  }, [evmAccount?.address, solanaAccount?.address]);

  // ── 인출 상태 ──────────────────────────────────────────────
  const [withdrawDraft, setWithdrawDraft] = useState<{ row: ProtocolDetailRow; maxUsd: number } | null>(null);
  /** 슬라이더 값 = 인출할 USD 금액 (0 ~ maxUsd) */
  const [withdrawAmtUsd, setWithdrawAmtUsd] = useState(0);
  const [withdrawVerifyPwd, setWithdrawVerifyPwd] = useState("");
  const [withdrawVerifyLoading, setWithdrawVerifyLoading] = useState(false);
  const [withdrawVerifyError, setWithdrawVerifyError] = useState("");
  const [withdrawDoneMsg, setWithdrawDoneMsg] = useState("");

  /** 슬라이더 값 그대로 사용 — 서버로 보내는 금액과 일치 */
  const withdrawAmount = Number(withdrawAmtUsd.toFixed(2));

  const onOpenWithdraw = (row: ProtocolDetailRow) => {
    const inputAmt = protocolAmounts[row.key] ?? 0;
    // 입력칸 금액이 유효하면 사용, 없으면 잔액 전체를 기본값으로
    const initAmt = inputAmt > 0 && inputAmt <= row.amount
      ? inputAmt
      : row.amount;
    setWithdrawDraft({ row, maxUsd: row.amount });
    setWithdrawAmtUsd(Number(initAmt.toFixed(2)));
    setWithdrawVerifyPwd("");
    setWithdrawVerifyError("");
    setWithdrawDoneMsg("");
  };

  const onConfirmWithdraw = async () => {
    if (!withdrawDraft || withdrawAmount <= 0) return;
    const session = getSession();
    if (!session) {
      setWithdrawVerifyError("세션이 만료되었습니다. 다시 로그인해 주세요.");
      return;
    }
    if (!withdrawVerifyPwd) {
      setWithdrawVerifyError("비밀번호를 입력하세요.");
      return;
    }
    setWithdrawVerifyLoading(true);
    setWithdrawVerifyError("");
    try {
      await login(session.username, withdrawVerifyPwd);
      await (onWithdrawTarget
        ? onWithdrawTarget(withdrawAmount, {
            name: withdrawDraft.row.name,
            chain: withdrawDraft.row.chain,
            pool: withdrawDraft.row.pool
          })
        : onWithdraw?.(withdrawAmount));
      const doneMsg = `$${withdrawAmount.toFixed(2)} 인출 처리 완료`;
      setWithdrawDraft(null);
      setWithdrawVerifyPwd("");
      setWithdrawDoneMsg(doneMsg);
      window.setTimeout(() => setWithdrawDoneMsg(""), 5000);
    } catch (error) {
      setWithdrawVerifyError(error instanceof Error ? error.message : "인출 확인 실패");
    } finally {
      setWithdrawVerifyLoading(false);
    }
  };
  const totalDeposited = positions.reduce((acc, item) => acc + item.amountUsd, 0);
  const protocolTotals = positions.reduce<Record<string, ProtocolDetailRow>>((acc, item) => {
    item.protocolMix.forEach((mix) => {
      const chain = inferProtocolChain(mix.name, mix.pool);
      const pool = mix.pool ?? `${chain} · ${mix.name}`;
      const key = `${mix.name}__${chain}__${pool}`;
      const prev = acc[key];
      acc[key] = {
        key,
        name: mix.name,
        chain,
        pool,
        amount: (prev?.amount ?? 0) + item.amountUsd * mix.weight
      };
    });
    return acc;
  }, {});
  const protocolRows = Object.values(protocolTotals).sort((a, b) => {
    const byProtocolRank = getProtocolSortRank(a.name) - getProtocolSortRank(b.name);
    if (byProtocolRank !== 0) return byProtocolRank;
    const byName = a.name.localeCompare(b.name, "ko-KR", { sensitivity: "base" });
    if (byName !== 0) return byName;
    const byChain = a.chain.localeCompare(b.chain, "ko-KR", { sensitivity: "base" });
    if (byChain !== 0) return byChain;
    return a.pool.localeCompare(b.pool, "ko-KR", { sensitivity: "base" });
  });
  const annualYield = estimateAnnualYieldUsd(positions);
  const protocolMatchCounts = useMemo(
    () =>
      Object.values(onchainMatchMap).reduce<Record<ProtocolPoolMatchState, number>>(
        (acc, row) => ({ ...acc, [row.state]: acc[row.state] + 1 }),
        { matched: 0, drift: 0, missing: 0, unsupported: 0, error: 0, available: 0 }
    ),
    [onchainMatchMap]
  );
  const catalogPoolRows = useMemo<PoolCatalogRow[]>(() => {
    const rows = new Map<
      string,
      {
        productNames: Set<string>;
        protocol: string;
        chain: string;
        pool: string;
        depositPossible: boolean;
        queryable: boolean;
      }
    >();
    for (const product of DEFAULT_PRODUCTS) {
      for (const mix of product.protocolMix) {
        const chain = inferProtocolChain(mix.name, mix.pool);
        const pool = mix.pool ?? `${chain} · ${mix.name}`;
        const key = `${mix.name.toLowerCase()}__${chain.toLowerCase()}__${pool.toLowerCase()}`;
        const prev = rows.get(key);
        const productNames = prev?.productNames ?? new Set<string>();
        productNames.add(product.name);
        rows.set(key, {
          productNames,
          protocol: mix.name,
          chain,
          pool,
          depositPossible: isPoolDepositPossible(mix.name, chain),
          queryable: isPoolPositionQueryable(mix.name)
        });
      }
    }
    return Array.from(rows.entries())
      .map(([key, row]) => ({
        key,
        productNames: Array.from(row.productNames),
        protocol: row.protocol,
        chain: row.chain,
        pool: row.pool,
        depositPossible: row.depositPossible,
        queryable: row.queryable,
        memo: `${row.depositPossible ? "입금 경로 있음" : "입금 경로 없음"} · ${row.queryable ? "포지션 조회 가능" : "포지션 조회 미지원"}`
      }))
      .sort((a, b) => {
        const byProtocolRank = getProtocolSortRank(a.protocol) - getProtocolSortRank(b.protocol);
        if (byProtocolRank !== 0) return byProtocolRank;
        const byChain = a.chain.localeCompare(b.chain, "ko-KR", { sensitivity: "base" });
        if (byChain !== 0) return byChain;
        return a.pool.localeCompare(b.pool, "ko-KR", { sensitivity: "base" });
      });
  }, []);

  const evaluatePoolMatch = (
    protocol: string,
    chain: string,
    pool: string,
    combinedRows: OnchainPositionPayload[],
    expectedUsd?: number
  ): { state: ProtocolPoolMatchState; detail: string } => {
    const protocolKey = `${protocol.toLowerCase()}__${chain.toLowerCase()}`;
    const protocolChainCandidates = combinedRows.filter((row) => `${row.protocol.toLowerCase()}__${row.chain.toLowerCase()}` === protocolKey);
    if (protocolChainCandidates.length === 0) {
      return { state: "missing", detail: "실제 조회 포지션 없음" };
    }
    const poolAddressHint = (() => {
      const hex = pool.match(/0x[a-fA-F0-9]{40}/)?.[0];
      if (hex) return hex.toLowerCase();
      const base58 = pool.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/)?.[0];
      return base58 ? base58.toLowerCase() : null;
    })();
    const poolMatchedCandidates = poolAddressHint
      ? protocolChainCandidates.filter((item) => {
          const poolAddress = item.poolAddress?.toLowerCase();
          const protocolPositionId = item.protocolPositionId?.toLowerCase();
          return poolAddress === poolAddressHint || protocolPositionId === poolAddressHint;
        })
      : [];
    const candidates = poolMatchedCandidates.length > 0 ? poolMatchedCandidates : protocolChainCandidates;
    const basisLabel = poolMatchedCandidates.length > 0 ? "풀주소 기준" : "프로토콜/체인 기준";
    const statuses = candidates.map((item) => item.verify?.status ?? "unsupported");
    if (statuses.every((status) => status === "unsupported")) {
      return { state: "unsupported", detail: `${basisLabel} · 해당 프로토콜의 온체인 검증 미지원` };
    }
    if (statuses.some((status) => status === "rpc_error")) {
      return { state: "error", detail: `${basisLabel} · RPC 응답 불안정 (재시도 필요)` };
    }
    const actualUsd = candidates.reduce((sum, item) => sum + (item.currentValueUsd ?? item.amountUsd ?? 0), 0);
    if (typeof expectedUsd === "number") {
      const driftPct = Math.abs((actualUsd - expectedUsd) / Math.max(expectedUsd, 0.01)) * 100;
      if (driftPct <= 25) {
        return { state: "matched", detail: `${basisLabel} · 실제 $${actualUsd.toFixed(2)} · 차이 ${driftPct.toFixed(1)}%` };
      }
      return { state: "drift", detail: `${basisLabel} · 실제 $${actualUsd.toFixed(2)} · 차이 ${driftPct.toFixed(1)}%` };
    }
    if (poolMatchedCandidates.length > 0) {
      return { state: "matched", detail: `${basisLabel} · 실제 $${actualUsd.toFixed(2)} · 조회 성공` };
    }
    if (protocolChainCandidates.length > 0) {
      return { state: "available", detail: `${basisLabel} · 실제 조회 ${protocolChainCandidates.length}건` };
    }
    return { state: "missing", detail: "실제 조회 포지션 없음" };
  };

  const resolveCatalogSyncTarget = (row: (typeof catalogPoolRows)[number]) => {
    const poolHint = row.pool.match(/0x[a-fA-F0-9]{40}/)?.[0]?.toLowerCase() ?? row.pool.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/)?.[0]?.toLowerCase() ?? null;
    const protocolKey = `${row.protocol.toLowerCase()}__${row.chain.toLowerCase()}`;
    const candidates = onchainQueriedRows.filter((item) => `${item.protocol.toLowerCase()}__${item.chain.toLowerCase()}` === protocolKey);
    if (candidates.length === 0) return null;
    if (poolHint) {
      const matched = candidates.find((item) => {
        const itemPool = item.poolAddress?.toLowerCase();
        const itemToken = item.protocolPositionId?.toLowerCase() ?? item.positionToken?.toLowerCase();
        return itemPool === poolHint || itemToken === poolHint;
      });
      if (matched) return matched;
    }
    return candidates.find((item) => (item.verify?.onchainAmountUsd ?? item.currentValueUsd ?? item.amountUsd) > 0) ?? candidates[0] ?? null;
  };

  const resolveProtocolRowSyncTarget = (row: (typeof protocolRows)[number]) => {
    const poolHint = row.pool.match(/0x[a-fA-F0-9]{40}/)?.[0]?.toLowerCase() ?? row.pool.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/)?.[0]?.toLowerCase() ?? null;
    const protocolKey = `${row.name.toLowerCase()}__${row.chain.toLowerCase()}`;
    const candidates = onchainQueriedRows.filter((item) => `${item.protocol.toLowerCase()}__${item.chain.toLowerCase()}` === protocolKey);
    if (candidates.length === 0) return null;
    if (poolHint) {
      const matched = candidates.find((item) => {
        const itemPool = item.poolAddress?.toLowerCase();
        const itemToken = item.protocolPositionId?.toLowerCase() ?? item.positionToken?.toLowerCase();
        return itemPool === poolHint || itemToken === poolHint;
      });
      if (matched) return matched;
    }
    return candidates.find((item) => (item.verify?.onchainAmountUsd ?? item.currentValueUsd ?? item.amountUsd) > 0) ?? candidates[0] ?? null;
  };

  const recomputeQueryState = (combinedRows: OnchainPositionPayload[]) => {
    const nextMap: Record<string, { state: ProtocolPoolMatchState; detail: string }> = {};
    for (const row of protocolRows) {
      nextMap[row.key] = evaluatePoolMatch(row.name, row.chain, row.pool, combinedRows, row.amount);
    }
    const nextCatalogMap = catalogPoolRows.reduce<Record<string, { state: ProtocolPoolMatchState; detail: string }>>((acc, row) => {
      acc[row.key] = evaluatePoolMatch(row.protocol, row.chain, row.pool, combinedRows);
      return acc;
    }, {});
    const counts = Object.values(nextMap).reduce<Record<ProtocolPoolMatchState, number>>(
      (acc, row) => ({ ...acc, [row.state]: acc[row.state] + 1 }),
      { matched: 0, drift: 0, missing: 0, unsupported: 0, error: 0, available: 0 }
    );
    const summary = `매치 ${counts.matched} · 차이 ${counts.drift} · 미조회 ${counts.missing} · 미지원 ${counts.unsupported} · 오류 ${counts.error}`;
    return { nextMap, nextCatalogMap, summary };
  };

  const persistOnchainQueryCache = (
    payload: Omit<OnchainQueryCache, "savedAt"> & { savedAt?: string }
  ) => {
    try {
      const next: OnchainQueryCache = {
        ...payload,
        savedAt: payload.savedAt ?? new Date().toISOString()
      };
      window.localStorage.setItem(onchainQueryStorageKey, JSON.stringify(next));
    } catch {
      /* 저장 실패는 조용히 무시 */
    }
  };

  const loadOnchainQueryCache = () => {
    try {
      const raw = window.localStorage.getItem(onchainQueryStorageKey);
      if (!raw) return null;
      return JSON.parse(raw) as OnchainQueryCache;
    } catch {
      return null;
    }
  };

  const applyOnchainQueryRows = (combinedRows: OnchainPositionPayload[], hidden = false) => {
    const { nextMap, nextCatalogMap, summary } = recomputeQueryState(combinedRows);
    setOnchainQueriedRows(combinedRows);
    setOnchainMatchMap(nextMap);
    setOnchainCatalogMatchMap(nextCatalogMap);
    setOnchainMatchSummary(summary);
    setHideOnchainResult(hidden);
    setSelectedOnchainRowKey((current) => current || combinedRows.find((row) => row.verify?.status === "verified")?.id || combinedRows[0]?.id || "");
    persistOnchainQueryCache({
      rows: combinedRows,
      matchMap: nextMap,
      catalogMatchMap: nextCatalogMap,
      summary,
      hidden
    });
  };

  const buildLedgerSyncProductName = (row: OnchainPositionPayload): string => {
    const itemKey = shortPositionId(row.protocolPositionId ?? row.positionToken ?? row.poolAddress ?? row.asset);
    return `Onchain Sync · ${row.protocol} · ${row.chain} · ${itemKey}`;
  };

  const syncOnchainRowToLedger = async (row: OnchainPositionPayload, mode: "create" | "adjust" = "create") => {
    const syncAmount = row.verify?.onchainAmountUsd ?? row.currentValueUsd ?? row.amountUsd ?? 0;
    if (syncAmount <= 0) {
      setLedgerSyncError("0원인 포지션은 장부에 반영하지 않았습니다.");
      return;
    }
    const productName = buildLedgerSyncProductName(row);
    const existingLedgerRow = positions.find((position) => position.productName === productName);
    if (mode === "create" && existingLedgerRow) {
      setLedgerSyncMessage(`이미 장부에 반영된 항목입니다: ${productName}`);
      return;
    }
    const confirmed = window.confirm(
      [
        "이 실제 조회 결과의 온체인 현재값을 내부 예치 장부에 반영할까요?",
        `프로토콜: ${row.protocol}`,
        `체인: ${row.chain}`,
        `금액: $${syncAmount.toFixed(2)}`,
        `장부 이름: ${productName}`,
        mode === "adjust" ? "기존 장부 값을 온체인 현재값으로 수정합니다." : "새 장부 항목을 생성합니다."
      ].join("\n")
    );
    if (!confirmed) {
      return;
    }
    const syncKey = `${row.protocol}__${row.chain}__${row.protocolPositionId ?? row.positionToken ?? row.poolAddress ?? row.asset}`;
    setLedgerSyncLoadingKey(syncKey);
    setLedgerSyncError("");
    setLedgerSyncMessage("");
    try {
      const syncPayload = {
        productName,
        amountUsd: syncAmount,
        expectedApr: row.protocol === "Aave" ? 0.05 : row.protocol === "Uniswap" ? 0.08 : row.protocol === "Orca" ? 0.08 : 0.0,
        protocolMix: [
          {
            name: row.protocol,
            weight: 1,
            pool: row.poolAddress ?? row.positionToken ?? row.asset ?? undefined
          }
        ]
      };
      if (mode === "adjust") {
        await adjustDepositPositionRemote(syncPayload);
      } else {
        await createDepositPositionRemote(syncPayload);
      }
      await onExecutionComplete?.();
      setLedgerSyncMessage(mode === "adjust" ? `장부 수정 완료: ${productName}` : `장부 반영 완료: ${productName}`);
    } catch (error) {
      setLedgerSyncError(error instanceof Error ? error.message : mode === "adjust" ? "장부 수정 실패" : "장부 반영 실패");
    } finally {
      setLedgerSyncLoadingKey("");
    }
  };

  const verifyProtocolPoolMatches = async () => {
    setOnchainMatchLoading(true);
    setOnchainMatchError("");
    setOnchainMatchSummary("");
    try {
      const evmWalletAddress = evmAccount?.address;
      const solanaWalletAddress = solanaAccount?.address;
      if (!evmWalletAddress && !solanaWalletAddress) {
        throw new Error("연결된 지갑 주소가 없습니다. Solana 또는 EVM 지갑을 연결한 뒤 다시 시도해 주세요.");
      }
      const combinedRows = await listPublicOnchainPositions({}, { evmWalletAddress, solanaWalletAddress });
      applyOnchainQueryRows(combinedRows, false);
    } catch (error) {
      setOnchainMatchError(error instanceof Error ? error.message : "실제 포지션 조회 실패");
    } finally {
      setOnchainMatchLoading(false);
    }
  };

  const toggleQueryablePools = async () => {
    if (showQueryablePools) {
      setShowQueryablePools(false);
      return;
    }
    setShowQueryablePools(true);
  };

  const resetLedger = async () => {
    if (!canPersistToServer || ledgerResetLoading) return;
    const confirmed = window.confirm(
      "장부를 초기화하면 예치 장부와 출금 장부가 모두 삭제됩니다. 실제 온체인 포지션은 유지됩니다. 계속할까요?"
    );
    if (!confirmed) return;
    setLedgerResetLoading(true);
    setOnchainMatchError("");
    setOnchainMatchSummary("");
    setOnchainMatchMap({});
    setLedgerResetError("");
    try {
      if (!onResetLedger) {
        throw new Error("장부 초기화 기능을 사용할 수 없습니다.");
      }
      await onResetLedger();
    } catch (error) {
      setLedgerResetError(error instanceof Error ? error.message : "장부 리셋에 실패했습니다.");
    } finally {
      setLedgerResetLoading(false);
    }
  };

  useEffect(() => {
    const cached = loadOnchainQueryCache();
    if (!cached) return;
    if (cached.rows.length === 0) return;
    setOnchainQueriedRows(cached.rows);
    setOnchainMatchMap(cached.matchMap);
    setOnchainCatalogMatchMap(cached.catalogMatchMap);
    setOnchainMatchSummary(cached.summary);
    setHideOnchainResult(cached.hidden);
    setSelectedOnchainRowKey(cached.rows.find((row) => row.verify?.status === "verified")?.id ?? cached.rows[0]?.id ?? "");
  }, [onchainQueryStorageKey]);

  const selectedOnchainRow = useMemo(
    () => onchainQueriedRows.find((row) => row.id === selectedOnchainRowKey) ?? null,
    [onchainQueriedRows, selectedOnchainRowKey]
  );

  useEffect(() => {
    if (!selectedOnchainRow) {
      setSelectedOnchainHistoryPoints([]);
      setSelectedOnchainHistoryError("");
      setSelectedOnchainHistoryLoading(false);
      return;
    }
    const controller = new AbortController();
    setSelectedOnchainHistoryLoading(true);
    setSelectedOnchainHistoryError("");
    void listOnchainPositionHistory(
      {
        protocol: selectedOnchainRow.protocol,
        chain: selectedOnchainRow.chain,
        poolAddress: selectedOnchainRow.poolAddress ?? undefined,
        positionToken: selectedOnchainRow.positionToken ?? undefined,
        asset: selectedOnchainRow.asset ?? undefined,
        days: 30,
        bucket: "hour"
      },
      { signal: controller.signal }
    )
      .then((history) => {
        setSelectedOnchainHistoryPoints(history.points);
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        setSelectedOnchainHistoryError(error instanceof Error ? error.message : "히스토리 조회 실패");
        setSelectedOnchainHistoryPoints([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setSelectedOnchainHistoryLoading(false);
        }
      });
    return () => controller.abort();
  }, [selectedOnchainRow?.protocol, selectedOnchainRow?.chain, selectedOnchainRow?.poolAddress, selectedOnchainRow?.positionToken, selectedOnchainRow?.asset, selectedOnchainRow?.id]);

  const selectedOnchainDetail = useMemo<UniswapOnchainDetail | null>(() => {
    if (!selectedOnchainRow?.onchainDataJson) return null;
    try {
      return JSON.parse(selectedOnchainRow.onchainDataJson) as UniswapOnchainDetail;
    } catch {
      return null;
    }
  }, [selectedOnchainRow?.onchainDataJson]);

  const formatDetailMoney = (value: number | null | undefined, options?: { allowZeroPrefix?: boolean }) => {
    if (value == null) {
      return <span className="onchain-detail-value onchain-detail-value--muted">—</span>;
    }
    const isZero = Math.abs(value) < 0.005;
    const formatted = `$${Math.abs(value).toFixed(2)}`;
    const prefix = value > 0 ? "+" : value < 0 ? "-" : options?.allowZeroPrefix ? "+" : "";
    const toneClass = isZero ? "onchain-detail-value--zero" : value < 0 ? "onchain-detail-value--negative" : "onchain-detail-value--normal";
    return (
      <span className={`onchain-detail-value ${toneClass}`}>
        {prefix}
        {formatted}
      </span>
    );
  };

  const formatDetailPercent = (value: number | null | undefined) => {
    if (value == null) {
      return <span className="onchain-detail-value onchain-detail-value--muted">—</span>;
    }
    const isZero = Math.abs(value) < 0.00005;
    const toneClass = isZero ? "onchain-detail-value--zero" : value < 0 ? "onchain-detail-value--negative" : "onchain-detail-value--normal";
    const prefix = value > 0 ? "+" : value < 0 ? "-" : "";
    return (
      <span className={`onchain-detail-value ${toneClass}`}>
        {prefix}
        {(Math.abs(value) * 100).toFixed(2)}%
      </span>
    );
  };

  const formatDetailNumber = (value: number | null | undefined, options?: { digits?: number }) => {
    if (value == null) {
      return <span className="onchain-detail-value onchain-detail-value--muted">—</span>;
    }
    const digits = options?.digits ?? 4;
    const isZero = Math.abs(value) < Math.pow(10, -(digits + 1));
    const toneClass = isZero ? "onchain-detail-value--zero" : value < 0 ? "onchain-detail-value--negative" : "onchain-detail-value--normal";
    return (
      <span className={`onchain-detail-value ${toneClass}`}>
        {value.toLocaleString(undefined, { maximumFractionDigits: digits })}
      </span>
    );
  };

  const formatDetailText = (value: string | null | undefined) => {
    if (!value) {
      return <span className="onchain-detail-value onchain-detail-value--muted">—</span>;
    }
    return <span className="onchain-detail-value onchain-detail-value--normal">{value}</span>;
  };

  const orcaPnlUsd =
    selectedOnchainRow?.protocol === "Orca"
      ? (selectedOnchainRow.currentValueUsd ?? selectedOnchainRow.amountUsd) -
        (selectedOnchainRow.principalUsd ?? selectedOnchainRow.amountUsd)
      : null;
  const orcaCostBasisUsd =
    selectedOnchainRow?.protocol === "Orca"
      ? selectedOnchainRow.principalUsd ??
        ((selectedOnchainRow.currentValueUsd ?? selectedOnchainRow.amountUsd) - (orcaPnlUsd ?? 0))
      : null;
  const orcaPnlPct =
    selectedOnchainRow?.protocol === "Orca" && orcaCostBasisUsd && orcaCostBasisUsd > 0
      ? (orcaPnlUsd ?? 0) / orcaCostBasisUsd
      : null;
  const orcaEstimatedApr =
    selectedOnchainRow?.protocol === "Orca"
      ? (selectedOnchainDetail?.estimatedApr ?? selectedOnchainRow.expectedApr ?? selectedOnchainRow.netApy ?? 0.08)
      : null;
  const orca24hYieldUsd =
    selectedOnchainRow?.protocol === "Orca"
      ? selectedOnchainDetail?.estimatedDailyYieldUsd ??
        (orcaEstimatedApr == null ? null : ((selectedOnchainRow.currentValueUsd ?? selectedOnchainRow.amountUsd) * orcaEstimatedApr) / 365)
      : null;
  const orcaBalanceUsd = selectedOnchainRow?.protocol === "Orca" ? selectedOnchainRow.currentValueUsd ?? selectedOnchainRow.amountUsd : null;
  const orcaPendingYieldUsd =
    selectedOnchainRow?.protocol === "Orca"
      ? selectedOnchainDetail?.pendingYieldUsd ??
        selectedOnchainRow.feesPaidUsd ??
        ((orcaBalanceUsd ?? 0) * (orcaEstimatedApr ?? 0.08)) / 365
      : null;
  const orcaFallbackPoolLabel =
    selectedOnchainRow?.protocol === "Orca"
      ? selectedOnchainDetail?.poolLabel ??
        `Orca Whirlpools ${selectedOnchainRow.asset}`
      : null;
  const orcaFallbackPoolAddress =
    selectedOnchainRow?.protocol === "Orca"
      ? selectedOnchainDetail?.poolAddress ??
        selectedOnchainRow.poolAddress ??
        selectedOnchainRow.positionToken ??
        null
      : null;
  const orcaFallbackCurrentPrice =
    selectedOnchainRow?.protocol === "Orca"
      ? selectedOnchainDetail?.currentPrice ??
        (selectedOnchainDetail?.rangeLowerPrice != null && selectedOnchainDetail?.rangeUpperPrice != null
          ? (selectedOnchainDetail.rangeLowerPrice + selectedOnchainDetail.rangeUpperPrice) / 2
          : orcaBalanceUsd != null && orcaBalanceUsd > 0
            ? orcaBalanceUsd
            : null)
      : null;
  const orcaFallbackRangeLower =
    selectedOnchainRow?.protocol === "Orca"
      ? selectedOnchainDetail?.rangeLowerPrice ??
        (orcaFallbackCurrentPrice != null ? orcaFallbackCurrentPrice * 0.95 : null)
      : null;
  const orcaFallbackRangeUpper =
    selectedOnchainRow?.protocol === "Orca"
      ? selectedOnchainDetail?.rangeUpperPrice ??
        (orcaFallbackCurrentPrice != null ? orcaFallbackCurrentPrice * 1.05 : null)
      : null;

  return (
    <section className="card portfolio-panel-card">
      <div className="portfolio-overview-hero">
        <div>
          <p className="section-eyebrow">Positions Overview</p>
          <h2>${totalDeposited.toLocaleString(undefined, { maximumFractionDigits: 2 })}</h2>
          <p>입금된 상품과 프로토콜 노출을 기준으로 운영 상태를 크게 보여줍니다.</p>
        </div>
        <div className="portfolio-overview-metrics">
          <div>
            <span>예치 건수</span>
            <strong>{positions.length}건</strong>
          </div>
          <div>
            <span>프로토콜 수</span>
            <strong>{new Set(protocolRows.map((row) => row.name)).size}개</strong>
          </div>
          <div>
            <span>추정 연 수익</span>
            <strong>${Math.round(annualYield).toLocaleString()}</strong>
          </div>
        </div>
        <ChainExposureDonut positions={positions} compact />
      </div>
      <h3>프로토콜별 예치 상세</h3>
      <div className="button-row" style={{ marginBottom: 10 }}>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => void verifyProtocolPoolMatches()}
          disabled={onchainMatchLoading}
          title="실제 지갑 기준으로 프로토콜 풀 매치를 다시 확인합니다. 로그인하지 않았으면 안내 메시지가 표시됩니다."
        >
          {onchainMatchLoading ? "실제 포지션 조회 중..." : "실제 프로토콜 풀 조회 · 매치 확인"}
        </button>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => void toggleQueryablePools()}
          disabled={onchainMatchLoading}
          title="현재 조회 가능한 풀 목록을 펼치거나 닫습니다. 로그인 없이도 사용할 수 있습니다."
        >
          {showQueryablePools ? "조회가능풀 닫기" : "조회가능풀"}
        </button>
        <button
          type="button"
          className="ghost-btn danger-btn"
          onClick={() => void resetLedger()}
          disabled={ledgerResetLoading || !canPersistToServer || (!positions.length && !hasLedgerEntries)}
          title={
            !canPersistToServer
              ? hasSession ? "지갑 연결 후 사용할 수 있습니다." : "로그인 후 사용할 수 있습니다."
              : "예치 장부와 출금 장부를 비우고 실제 온체인 포지션은 유지합니다."
          }
        >
          {ledgerResetLoading ? "장부 초기화 중..." : "장부 리셋"}
        </button>
        {onchainMatchSummary ? <span className="kpi-label">{onchainMatchSummary}</span> : null}
      </div>
      {onchainMatchError ? <p className="exec-verify-error">{onchainMatchError}</p> : null}
      {ledgerResetError ? <p className="exec-verify-error">{ledgerResetError}</p> : null}
      {onchainQueriedRows.length > 0 ? (
        <div className="onchain-query-result-panel">
          <div className="onchain-query-result-head">
            <div>
              <h3>실제 조회 결과</h3>
              <p className="kpi-label">
                {hideOnchainResult
                  ? "이전 조회 결과가 저장되어 있습니다. 펼치기를 누르면 다시 보여주고, 새로고침으로 다시 조회합니다."
                  : "연결된 지갑에서 조회된 프로토콜 포지션입니다."}
              </p>
            </div>
            <div className="onchain-query-result-head-right">
              <span className="protocol-match-badge protocol-match-badge--pending">{onchainQueriedRows.length}건</span>
              <button
                type="button"
                className="ghost-btn onchain-result-close-btn"
                onClick={() => void verifyProtocolPoolMatches()}
                disabled={onchainMatchLoading}
                title="최신 상태로 다시 조회합니다."
              >
                {onchainMatchLoading ? "새로고침 중..." : "새로고침"}
              </button>
              <button
                type="button"
                className="ghost-btn onchain-result-close-btn"
                onClick={() => {
                  setHideOnchainResult((prev) => {
                    const next = !prev;
                    persistOnchainQueryCache({
                      rows: onchainQueriedRows,
                      matchMap: onchainMatchMap,
                      catalogMatchMap: onchainCatalogMatchMap,
                      summary: onchainMatchSummary,
                      hidden: next
                    });
                    return next;
                  });
                }}
                title={hideOnchainResult ? "이전 조회 결과 펼치기" : "조회 결과 접기"}
              >
                {hideOnchainResult ? "펼치기" : "접기"}
              </button>
            </div>
          </div>
          {ledgerSyncMessage ? (
            <div className="auth-message auth-message--ok ledger-sync-message">
              <span>{ledgerSyncMessage}</span>
              <button type="button" className="ghost-btn ghost-btn--compact" onClick={() => setLedgerSyncMessage("")}>
                닫기
              </button>
            </div>
          ) : null}
          {ledgerSyncError ? <p className="exec-verify-error">{ledgerSyncError}</p> : null}
          {!hideOnchainResult ? (
            <table className="protocol-detail-table portfolio-onchain-table">
              <thead>
                <tr>
                  <th>프로토콜</th>
                  <th>체인</th>
                  <th>자산</th>
                  <th>금액(USD)</th>
                  <th>상태</th>
                  <th>풀/포지션</th>
                  <th>상세</th>
                  <th>장부</th>
                </tr>
              </thead>
              <tbody>
                {onchainQueriedRows.map((position) => {
                  const verify = position.verify ?? undefined;
                  const verifyStatus = verify?.status;
                  const amountUsd = verify?.onchainAmountUsd ?? position.currentValueUsd ?? position.amountUsd;
                  const positionId = position.protocolPositionId ?? position.positionToken ?? position.poolAddress;
                  const poolAddress = position.poolAddress ?? (position.protocol === "Uniswap" ? getUniswapNpmAddress(position.chain) ?? undefined : undefined);
                  const syncProductName = buildLedgerSyncProductName(position);
                  const syncKey = `${position.protocol}__${position.chain}__${position.protocolPositionId ?? position.positionToken ?? position.poolAddress ?? position.asset}`;
                  const isLedgerRecorded = positions.some((item) => item.productName === syncProductName);
                  const detailRow = selectedOnchainRowKey === position.id && verifyStatus === "verified" ? selectedOnchainRow : null;
                  const verifiedAtLabel = verify?.verifiedAt
                    ? new Date(verify.verifiedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                    : undefined;
                  return (
                    <Fragment key={`${position.id}-${position.chain}-${position.protocol}`}>
                      <tr>
                        <td data-label="프로토콜">{position.protocol}</td>
                        <td data-label="체인">{position.chain}</td>
                        <td data-label="자산">{position.asset}</td>
                        <td data-label="금액(USD)">{amountUsd == null ? "—" : `$${amountUsd.toFixed(2)}`}</td>
                        <td data-label="상태">
                          <span
                            className={onchainVerifyBadgeClass(verifyStatus)}
                            title={[verify?.detail, verifiedAtLabel].filter(Boolean).join(" · ") || undefined}
                          >
                            {onchainVerifyLabel(verifyStatus)}
                          </span>
                        </td>
                        <td data-label="풀/포지션" className="product-pool-pool-label" title={[positionId, poolAddress].filter(Boolean).join(" · ") || undefined}>
                          {position.protocol === "Uniswap" ? (
                            <div className="portfolio-uniswap-position-cell">
                              <span className="portfolio-uniswap-position-primary">{shortPositionId(positionId)}</span>
                              <span className="portfolio-uniswap-position-secondary">
                                {poolAddress ? shortPositionId(poolAddress) : "조회 대상 없음"}
                              </span>
                            </div>
                          ) : (
                            shortPositionId(positionId)
                          )}
                        </td>
                        <td data-label="상세">
                          {verifyStatus === "verified" ? (
                            <button
                              type="button"
                              className={selectedOnchainRowKey === position.id ? "ghost-btn ghost-btn--active" : "ghost-btn"}
                              onClick={() => setSelectedOnchainRowKey((current) => (current === position.id ? "" : position.id))}
                              title="이 성공한 조회 결과의 세부 정보를 펼쳐 봅니다."
                            >
                              {selectedOnchainRowKey === position.id ? "열림" : "상세"}
                            </button>
                          ) : (
                            <span className="badge badge-low">-</span>
                          )}
                        </td>
                        <td data-label="장부">
                          {amountUsd && amountUsd > 0 ? (
                            isLedgerRecorded && verifyStatus !== "drift" ? (
                              <span className="badge badge-low" title={syncProductName}>기록됨</span>
                            ) : verifyStatus === "drift" && canPersistToServer ? (
                              <button
                                type="button"
                                className="ghost-btn"
                                disabled={ledgerSyncLoadingKey === syncKey}
                                onClick={() => void syncOnchainRowToLedger(position, isLedgerRecorded ? "adjust" : "create")}
                                title={
                                  isLedgerRecorded
                                    ? "이 조회 결과의 현재 값으로 기존 장부를 수정합니다."
                                    : "이 조회 결과의 현재 값으로 장부를 새로 반영합니다."
                                }
                              >
                                {ledgerSyncLoadingKey === syncKey
                                  ? "수정 중..."
                                  : isLedgerRecorded
                                    ? "현 값으로 수정"
                                    : "장부 반영"}
                              </button>
                            ) : canPersistToServer ? (
                              <button
                                type="button"
                                className="ghost-btn"
                                disabled={ledgerSyncLoadingKey === syncKey}
                                onClick={() => void syncOnchainRowToLedger(position, isLedgerRecorded ? "adjust" : "create")}
                                title="이 조회 결과를 내부 예치 장부에 반영합니다. 승인 후 1건씩 처리됩니다."
                              >
                                {ledgerSyncLoadingKey === syncKey ? "반영 중..." : "장부 반영"}
                              </button>
                            ) : (
                              <span className="badge badge-high" title="로그인 후 장부 반영 가능">로그인 필요</span>
                            )
                          ) : (
                            <span className="badge badge-high">-</span>
                          )}
                        </td>
                      </tr>
                      {detailRow ? (
                        <tr className="onchain-detail-row">
                          <td colSpan={8}>
                            <div className="onchain-detail-inline onchain-detail-inline--embedded">
                              {detailRow.protocol === "Orca" ? (
                                <div className="onchain-detail-breakdown">
                                  <div className="onchain-detail-table-wrap">
                                    <table className="onchain-detail-table onchain-detail-table--horizontal onchain-detail-table--compact onchain-detail-table--orca">
                                      <thead>
                                        <tr>
                                          <th>Pool</th>
                                          <th>Balance</th>
                                          <th>Cost Basis</th>
                                          <th>Total PnL</th>
                                          <th>PnL %</th>
                                          <th>Pending Yield</th>
                                          <th>Est. Yield</th>
                                          <th>24H</th>
                                          <th>Position Range</th>
                                          <th>Current Price</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        <tr>
                                          <td>
                                            <div className="onchain-detail-multi-cell">
                                              <strong>{orcaFallbackPoolLabel ?? "—"}</strong>
                                              <span>{orcaFallbackPoolAddress ? shortPositionId(orcaFallbackPoolAddress) : "—"}</span>
                                            </div>
                                          </td>
                                          <td>{formatDetailMoney(orcaBalanceUsd)}</td>
                                          <td>{formatDetailMoney(orcaCostBasisUsd)}</td>
                                          <td>{formatDetailMoney(orcaPnlUsd, { allowZeroPrefix: true })}</td>
                                          <td>{formatDetailPercent(orcaPnlPct)}</td>
                                          <td>{formatDetailMoney(orcaPendingYieldUsd)}</td>
                                          <td>{formatDetailPercent(orcaEstimatedApr)}</td>
                                          <td>{formatDetailMoney(orca24hYieldUsd)}</td>
                                          <td>
                                            {orcaFallbackRangeLower != null && orcaFallbackRangeUpper != null ? (
                                              <span className="onchain-detail-value onchain-detail-value--normal">
                                                {orcaFallbackRangeLower.toLocaleString(undefined, { maximumFractionDigits: 6 })} ~{" "}
                                                {orcaFallbackRangeUpper.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                                              </span>
                                            ) : (
                                              <span className="onchain-detail-value onchain-detail-value--muted">—</span>
                                            )}
                                          </td>
                                          <td>{formatDetailNumber(orcaFallbackCurrentPrice ?? null, { digits: 6 })}</td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              ) : null}
                              {detailRow.protocol === "Uniswap" ? (
                                <div className="onchain-detail-breakdown">
                                  <div className="onchain-detail-table-wrap">
                                    <table className="onchain-detail-table onchain-detail-table--horizontal onchain-detail-table--compact">
                                      <thead>
                                        <tr>
                                          <th>Pool</th>
                                          <th>Balance</th>
                                          <th>Total PnL</th>
                                          <th>Pending Yield</th>
                                          <th>Est. Yield</th>
                                          <th>24H</th>
                                          <th>Position Range</th>
                                          <th>Current Price</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        <tr>
                                          <td>
                                            <div className="onchain-detail-multi-cell">
                                              <strong>{selectedOnchainDetail?.poolAddress ? shortPositionId(selectedOnchainDetail.poolAddress) : "—"}</strong>
                                              <span>{formatDetailText(detailRow.asset)}</span>
                                            </div>
                                          </td>
                                          <td>{formatDetailMoney(detailRow.currentValueUsd ?? 0)}</td>
                                          <td>{formatDetailMoney(detailRow.unrealizedPnlUsd ?? null, { allowZeroPrefix: true })}</td>
                                          <td>{formatDetailMoney((selectedOnchainDetail?.feesOwed0Usd ?? 0) + (selectedOnchainDetail?.feesOwed1Usd ?? 0))}</td>
                                          <td>{formatDetailPercent(detailRow.netApy)}</td>
                                          <td>{formatDetailMoney(detailRow.netApy == null ? null : (detailRow.currentValueUsd ?? 0) * detailRow.netApy / 365)}</td>
                                          <td>
                                            {selectedOnchainDetail?.tickLower == null || selectedOnchainDetail.tickUpper == null ? (
                                              <span className="onchain-detail-value onchain-detail-value--muted">—</span>
                                            ) : (
                                              <span className="onchain-detail-value onchain-detail-value--normal">
                                                {selectedOnchainDetail.tickLower} ~ {selectedOnchainDetail.tickUpper}
                                              </span>
                                            )}
                                          </td>
                                          <td>{selectedOnchainDetail?.currentPrice == null ? <span className="onchain-detail-value onchain-detail-value--muted">—</span> : formatDetailNumber(selectedOnchainDetail.currentPrice, { digits: 6 })}</td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              ) : null}
                              <div className="onchain-history-section">
                                <div className="onchain-history-section-head">
                                  <div>
                                    <p className="section-eyebrow">Snapshot Timeline</p>
                                    <h4>조회 시점별 자산가치 · 수익</h4>
                                  </div>
                                  <span className="kpi-label">최근 30일 저장분</span>
                                </div>
                                {selectedOnchainHistoryLoading ? (
                                  <p className="kpi-label">히스토리 불러오는 중...</p>
                                ) : selectedOnchainHistoryError ? (
                                  <p className="exec-verify-error">{selectedOnchainHistoryError}</p>
                                ) : (
                                  <OnchainPositionHistoryChart
                                    points={selectedOnchainHistoryPoints}
                                    title={`${detailRow.protocol} · ${detailRow.chain}`}
                                    subtitle={selectedOnchainDetail?.poolLabel ?? detailRow.poolAddress ?? detailRow.positionToken ?? detailRow.asset}
                                  />
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
      <table className="protocol-detail-table">
        <thead>
          <tr>
            <th>프로토콜</th>
            <th>체인</th>
            <th>풀</th>
            <th>예치 금액 (USD)</th>
            <th>비중</th>
            <th>실제조회 매치</th>
            <th>입출금</th>
          </tr>
        </thead>
        <tbody>
          {protocolRows.map((row) => (
            <tr key={row.key}>
              <td>{row.name}</td>
              <td>{row.chain}</td>
              <td className="product-pool-pool-label">{row.pool}</td>
              <td>${row.amount.toFixed(2)}</td>
              <td>
                <span className="protocol-weight-cell">{totalDeposited > 0 ? ((row.amount / totalDeposited) * 100).toFixed(1) : "0.0"}%</span>
              </td>
              <td>
                {onchainMatchMap[row.key] ? (
                  <div className="catalog-match-cell">
                    <span
                      className={
                        onchainMatchMap[row.key].state === "matched"
                          ? "protocol-match-badge protocol-match-badge--ok"
                          : onchainMatchMap[row.key].state === "drift"
                            ? "protocol-match-badge protocol-match-badge--drift"
                            : onchainMatchMap[row.key].state === "unsupported"
                              ? "protocol-match-badge protocol-match-badge--unsupported"
                              : onchainMatchMap[row.key].state === "error"
                                ? "protocol-match-badge protocol-match-badge--error"
                                : "protocol-match-badge protocol-match-badge--missing"
                      }
                      title={onchainMatchMap[row.key].detail}
                    >
                      {onchainMatchMap[row.key].state === "matched"
                        ? "일치"
                        : onchainMatchMap[row.key].state === "drift"
                          ? "차이"
                          : onchainMatchMap[row.key].state === "unsupported"
                            ? "미지원"
                            : onchainMatchMap[row.key].state === "error"
                              ? "오류"
                              : "미조회"}
                    </span>
                    {onchainMatchMap[row.key].state === "drift" ? (
                      (() => {
                        const target = resolveProtocolRowSyncTarget(row);
                        const syncKey = target
                          ? `${target.protocol}__${target.chain}__${target.protocolPositionId ?? target.positionToken ?? target.poolAddress ?? target.asset}`
                          : row.key;
                        const isRecorded = target ? positions.some((item) => item.productName === buildLedgerSyncProductName(target)) : false;
                        return target && canPersistToServer ? (
                          <button
                            type="button"
                            className="ghost-btn ghost-btn--compact"
                            disabled={ledgerSyncLoadingKey === syncKey}
                            onClick={() => void syncOnchainRowToLedger(target, isRecorded ? "adjust" : "create")}
                            title="실제 조회된 현재 값으로 장부를 바로 맞춥니다."
                          >
                            {ledgerSyncLoadingKey === syncKey
                              ? "처리 중..."
                              : isRecorded
                                ? "현 값으로 수정"
                                : "장부 반영"}
                          </button>
                        ) : null;
                      })()
                    ) : null}
                  </div>
                ) : (
                  <span className="protocol-match-badge protocol-match-badge--pending">대기</span>
                )}
              </td>
              <td>
                <div className="protocol-inline-transfer">
                  <input
                    type="number"
                    min={1}
                    step={100}
                    value={protocolAmounts[row.key] ?? Math.max(100, Math.round(row.amount || 100))}
                    onChange={(event) =>
                      setProtocolAmounts((prev) => ({
                        ...prev,
                        [row.key]: Number(event.target.value)
                      }))
                    }
                    aria-label={`${row.name} ${row.chain} 입출금 금액`}
                  />
                  <TradeControls
                    onDeposit={() => {
                      const input = protocolAmounts[row.key] ?? Math.max(100, Math.round(row.amount || 100));
                      if (!Number.isFinite(input) || input <= 0) return;
                      setProtocolAmounts((prev) => ({ ...prev, [row.key]: input + 100 }));
                    }}
                    onWithdraw={() => {
                      const input = protocolAmounts[row.key] ?? Math.max(100, Math.round(row.amount || 100));
                      if (!Number.isFinite(input) || input <= 0) return;
                      setProtocolAmounts((prev) => ({ ...prev, [row.key]: Math.max(0, input - 100) }));
                    }}
                  />
                  <button
                    type="button"
                    className="protocol-deposit-action"
                    onClick={() => {
                      const input = protocolAmounts[row.key] ?? Math.max(100, Math.round(row.amount || 100));
                      if (!Number.isFinite(input) || input <= 0) return;
                      setProtocolDepositDraft({ ...row, amount: input });
                      setProtocolDepositKey((prev) => prev + 1);
                    }}
                    title="조정한 금액으로 입금 처리 팝업을 엽니다. 포지션은 내 계정 기준으로 기록됩니다."
                  >
                    입금
                  </button>
                  <button
                    type="button"
                    className="protocol-withdraw-action"
                    onClick={() => onOpenWithdraw(row)}
                    title={!canPersistToServer ? (hasSession ? "지갑 연결 후 인출이 가능합니다." : "로그인 후 인출이 가능합니다.") : "이 프로토콜에서 인출합니다."}
                    disabled={!canPersistToServer || row.amount <= 0}
                  >
                    인출
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {protocolRows.length === 0 ? (
            <tr>
              <td colSpan={7}>아직 예치 내역이 없습니다.</td>
            </tr>
          ) : (
            <tr className="protocol-total-row">
              <td>합계</td>
              <td>—</td>
              <td>—</td>
              <td>${totalDeposited.toFixed(2)}</td>
              <td>
                <span className="protocol-weight-cell">{totalDeposited > 0 ? "100.0" : "0.0"}%</span>
              </td>
              <td>
                <span className="kpi-label">
                  일치 {protocolMatchCounts.matched} · 차이 {protocolMatchCounts.drift} · 미조회 {protocolMatchCounts.missing}
                </span>
              </td>
              <td>—</td>
            </tr>
          )}
        </tbody>
      </table>
      {showQueryablePools ? (
        <>
          <h3>대상 풀 전체</h3>
          <p className="kpi-label">현재 상품 카탈로그에 들어있는 풀 전체를 보여주고, 각 풀의 입금 가능 여부와 포지션 조회 가능 여부를 O/X로 표시합니다.</p>
          <table className="protocol-detail-table portfolio-onchain-table">
            <thead>
              <tr>
                <th>상품</th>
                <th>프로토콜</th>
                <th>체인</th>
                <th>풀</th>
                <th>입금가능</th>
                <th>포지션조회가능</th>
                <th>조회상태</th>
                <th>메모</th>
              </tr>
            </thead>
            <tbody>
              {catalogPoolRows.length > 0 ? (
                catalogPoolRows.map((row) => {
                  const match = onchainCatalogMatchMap[row.key];
                  return (
                    <tr key={row.key}>
                      <td data-label="상품">{row.productNames.join(" / ")}</td>
                      <td data-label="프로토콜">{row.protocol}</td>
                      <td data-label="체인">{row.chain}</td>
                      <td data-label="풀" className="product-pool-pool-label">
                        {row.pool}
                      </td>
                      <td data-label="입금가능">
                        <span
                          className={row.depositPossible ? "badge badge-low" : "badge badge-high"}
                          title={getPoolDepositReason(row.protocol, row.chain)}
                        >
                          {row.depositPossible ? "O" : "X"}
                        </span>
                      </td>
                      <td data-label="포지션조회가능">
                        <span className={row.queryable ? "badge badge-low" : "badge badge-high"} title={getPoolQueryReason(row.protocol)}>
                          {row.queryable ? "O" : "X"}
                        </span>
                      </td>
                      <td data-label="조회상태">
                        {match ? (
                          <div className="catalog-match-cell">
                            <span
                              className={
                                match.state === "matched" || match.state === "available"
                                  ? "protocol-match-badge protocol-match-badge--ok"
                                  : match.state === "drift"
                                    ? "protocol-match-badge protocol-match-badge--drift"
                                    : match.state === "unsupported"
                                      ? "protocol-match-badge protocol-match-badge--unsupported"
                                      : match.state === "error"
                                        ? "protocol-match-badge protocol-match-badge--error"
                                        : "protocol-match-badge protocol-match-badge--missing"
                              }
                              title={match.detail}
                            >
                              {match.state === "matched"
                                ? "일치"
                                : match.state === "available"
                                  ? "조회됨"
                                  : match.state === "drift"
                                    ? "차이"
                                    : match.state === "unsupported"
                                      ? "미지원"
                                      : match.state === "error"
                                        ? "오류"
                                        : "미조회"}
                            </span>
                            {match.state === "drift" ? (
                              (() => {
                                const target = resolveCatalogSyncTarget(row);
                                const syncKey = target
                                  ? `${target.protocol}__${target.chain}__${target.protocolPositionId ?? target.positionToken ?? target.poolAddress ?? target.asset}`
                                  : row.key;
                                const isRecorded = target ? positions.some((item) => item.productName === buildLedgerSyncProductName(target)) : false;
                                return target && canPersistToServer ? (
                                  <button
                                    type="button"
                                    className="ghost-btn ghost-btn--compact"
                                    disabled={ledgerSyncLoadingKey === syncKey}
                                    onClick={() => void syncOnchainRowToLedger(target, isRecorded ? "adjust" : "create")}
                                    title="실제 조회된 현재 값으로 장부를 바로 맞춥니다."
                                  >
                                    {ledgerSyncLoadingKey === syncKey
                                      ? "처리 중..."
                                      : isRecorded
                                        ? "현 값으로 수정"
                                        : "장부 반영"}
                                  </button>
                                ) : null;
                              })()
                            ) : null}
                          </div>
                        ) : (
                          <span className="protocol-match-badge protocol-match-badge--pending">대기</span>
                        )}
                      </td>
                      <td data-label="메모">{row.memo}</td>
                    </tr>
                  );
                })
              ) : (
                <tr><td colSpan={8}>아직 대상 풀이 없습니다.</td></tr>
              )}
            </tbody>
          </table>
        </>
      ) : (
        <p className="kpi-label">`조회가능풀` 버튼을 누르면 현재 대상 풀 전체가 펼쳐집니다.</p>
      )}
      {/* ── 인출 확인 패널 ── */}
      {withdrawDraft ? (
        <div className="protocol-withdraw-confirm" role="dialog" aria-label="인출 확인">
          <p className="protocol-withdraw-confirm-title">
            💸 {withdrawDraft.row.name} · {withdrawDraft.row.chain} 인출
          </p>
          <p className="protocol-withdraw-confirm-desc">
            {withdrawDraft.row.pool} 현재 잔액 <strong>${withdrawDraft.maxUsd.toFixed(2)}</strong> — 슬라이더로 인출 금액을 조절하세요.
          </p>
          <div className="protocol-withdraw-slider-row">
            <span className="protocol-withdraw-slider-label">$0</span>
            <input
              type="range"
              min={0}
              max={withdrawDraft.maxUsd}
              step={Math.max(1, Math.round(withdrawDraft.maxUsd / 100))}
              value={withdrawAmtUsd}
              onChange={(e) => setWithdrawAmtUsd(Number(e.target.value))}
              className="protocol-withdraw-slider"
              aria-label="인출 금액"
              disabled={withdrawVerifyLoading}
            />
            <span className="protocol-withdraw-slider-label">${withdrawDraft.maxUsd.toFixed(0)}</span>
            <strong className="protocol-withdraw-amount-badge">
              ${withdrawAmount.toFixed(2)}
              {withdrawDraft.maxUsd > 0
                ? <em>({((withdrawAmount / withdrawDraft.maxUsd) * 100).toFixed(0)}%)</em>
                : null}
            </strong>
          </div>
          <label className="exec-verify-label">
            비밀번호 확인
            <input
              type="password"
              className="exec-verify-input"
              value={withdrawVerifyPwd}
              onChange={(e) => setWithdrawVerifyPwd(e.target.value)}
              disabled={withdrawVerifyLoading}
              autoFocus
              autoComplete="current-password"
              onKeyDown={(e) => e.key === "Enter" && void onConfirmWithdraw()}
            />
          </label>
          {withdrawVerifyError ? (
            <p className="exec-verify-error">{withdrawVerifyError}</p>
          ) : null}
          <div className="exec-verify-actions">
            <button
              type="button"
              className="auth-primary-btn protocol-withdraw-confirm-btn"
              onClick={() => void onConfirmWithdraw()}
              disabled={withdrawVerifyLoading || !withdrawVerifyPwd || withdrawAmount <= 0}
            >
              {withdrawVerifyLoading ? "처리 중…" : `$${withdrawAmount.toFixed(2)} 인출 확인`}
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setWithdrawDraft(null);
                setWithdrawVerifyPwd("");
                setWithdrawVerifyError("");
              }}
              disabled={withdrawVerifyLoading}
            >
              취소
            </button>
          </div>
        </div>
      ) : null}
      {withdrawDoneMsg ? (
        <p className="auth-message auth-message--ok protocol-withdraw-done">{withdrawDoneMsg}</p>
      ) : null}

      {protocolDepositDraft ? (
        <div className="modal-backdrop modal-backdrop--execution" role="dialog" aria-modal="true" aria-label="프로토콜 입금 처리 팝업">
          <div className="modal-card execution-modal-card deposit-execution-modal">
            <button type="button" className="modal-close-icon" aria-label="닫기" onClick={() => setProtocolDepositDraft(null)}>
              x
            </button>
            <div className="inline-execution-panel-head">
              <div>
                <p className="section-eyebrow">Protocol Deposit</p>
                <h3>
                  {protocolDepositDraft.name} · {protocolDepositDraft.chain} 입금 처리
                </h3>
              </div>
            </div>
            <OrchestratorBoard
              key={`${protocolDepositDraft.name}-${protocolDepositKey}`}
              initialDepositUsd={protocolDepositDraft.amount}
              initialProductName={`${protocolDepositDraft.name} ${protocolDepositDraft.chain} direct pool`}
              initialEstYieldUsd={protocolDepositDraft.amount * 0.08}
              initialEstFeeUsd={0}
              previewRowsOverride={[
                {
                  protocol: protocolDepositDraft.name,
                  chain: protocolDepositDraft.chain,
                  action: protocolDepositDraft.pool.replace(`${protocolDepositDraft.chain} · `, ""),
                  allocationUsd: protocolDepositDraft.amount
                }
              ]}
              onExecutionComplete={onExecutionComplete}
            />
          </div>
        </div>
      ) : null}
      <div className="position-detail-toggle-row">
        <button type="button" className="ghost-btn" onClick={() => setShowPositionDetails((prev) => !prev)} aria-expanded={showPositionDetails}>
          예치 건별 상세내역 {showPositionDetails ? "닫기" : "보기"}
        </button>
      </div>
      {showPositionDetails ? (
        <table>
          <thead>
            <tr>
              <th>상품</th>
              <th>예치 금액</th>
              <th>예상 APR</th>
              <th>프로토콜 믹스</th>
              <th>예치 시각</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => (
              <tr key={position.id}>
                <td>{position.productName}</td>
                <td>${position.amountUsd.toFixed(2)}</td>
                <td>{(position.expectedApr * 100).toFixed(2)}%</td>
                <td>{position.protocolMix.map((mix) => `${mix.name} ${(mix.weight * 100).toFixed(0)}%`).join(" / ")}</td>
                <td>{new Date(position.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {positions.length === 0 ? (
              <tr>
                <td colSpan={5}>아직 예치 내역이 없습니다.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
