import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AddressType } from "@phantom/browser-sdk";
import { useAccounts, usePhantom } from "@phantom/react-sdk";
import type { ISolanaChain } from "@phantom/chain-interfaces";
import {
  listAccountAssets,
  listLiveAccountAssets,
  listAccountWallets,
  fetchMarketPrices,
  login,
  getSession,
  createOrchestratorJob,
  createDepositPositionRemote,
  estimateProtocolFees,
  executeJob,
  fetchRuntimeInfo,
  readAccessTokenSnapshot,
  loginWithWallet,
  subscribeLocalAuth,
  type AccountAssetBalance,
  type AccountAssetSymbol,
  type ExecuteJobResponse,
  type Job,
  type MarketPriceSnapshot,
  type ProtocolExecutionReadiness,
  type ProductNetwork,
  type ProductSubtype,
  type ProtocolFeeEstimate,
  type RuntimeInfo,
  type UserWallet
} from "../lib/api";
import { loadCachedAccountAssets, saveCachedAccountAssets } from "../lib/accountAssetCache";
import { getSolanaNetworkPreference } from "../lib/solanaNetworkPreference";
import { getMainnetLivePreference, setMainnetLivePreference } from "../lib/mainnetLivePreference";
import { getOrcaMinimumAllocationPreference, setOrcaMinimumAllocationPreference } from "../lib/orcaMinimumAllocationPreference";
import { buildDepositAssetReadiness } from "../lib/depositAssetPlan";
import { buildDepositExecutionPlan, type DepositExecutionPlanStep } from "../lib/depositExecutionPlan";
import { buildExecutionPreviewRows } from "../lib/executionPreview";
import { buildAgentTasks, evaluateRisk } from "../lib/orchestrator";
import { checkGuardrails } from "../lib/strategyEngine";
import { ORCA_MIN_LIVE_ALLOCATION_USD } from "../lib/constants";
import type { ExecutionPreviewRow } from "../lib/executionPreview";
import { fetchEvmPortfolioWithFallback, getEvmRpcCandidates } from "../lib/evmChainAssets";
import { fetchOnChainPortfolioWithFallback, getSolanaRpcCandidates } from "../lib/solanaChainAssets";
import { diffOnChainPortfolios, summarizeDepositEvidence } from "../lib/solanaTxMonitor";
import type { OrcaClientExecutionResult } from "../lib/orcaWalletExecution";

type OrchestratorBoardProps = {
  initialDepositUsd?: number;
  initialProductName?: string;
  initialEstYieldUsd?: number;
  initialEstFeeUsd?: number;
  /** 선택한 예치상품의 대상 네트워크. 어댑터 라우팅에 사용됨. */
  initialProductNetwork?: ProductNetwork;
  /** 선택한 예치상품의 서브타입. 어댑터 배분 비율 결정에 사용됨. */
  initialProductSubtype?: ProductSubtype;
  /** `false`이면 서버 예치 실행 단계를 막습니다(비로그인 상품 체험 등). JWT는 `localStorage` 구독으로 판별합니다. */
  allowJobExecution?: boolean;
  /** 직전 예치 저장으로 생성된 포지션 id(실행 이벤트 페이로드에 연결). */
  linkedPositionId?: string;
  previewRowsOverride?: ExecutionPreviewRow[];
  onActionNotice?: (notice: { variant: "error" | "info"; text: string }) => void;
  onOpenOperationsWithJob?: (jobId: string) => void;
  onExecutionComplete?: () => void | Promise<void>;
};

type ExecutionStepLogEntry = {
  key: string;
  title: string;
  detail: string;
  state: "planned" | "quoted" | "approved" | "submitting" | "submitted" | "confirmed" | "accounted" | "skipped" | "failed";
  txId?: string;
  message?: string;
};

function executionStateLabel(state: ExecutionStepLogEntry["state"]): string {
  switch (state) {
    case "planned":
      return "예정";
    case "quoted":
      return "견적";
    case "approved":
      return "승인";
    case "submitting":
      return "전송";
    case "submitted":
      return "전송됨";
    case "confirmed":
      return "확정";
    case "accounted":
      return "장부";
    case "skipped":
      return "건너뜀";
    case "failed":
      return "실패";
    default:
      return "상태";
  }
}

function buildFallbackDryRunAssets(
  prices: MarketPriceSnapshot["prices"],
  priceSource: string,
  priceUpdatedAt: string
): AccountAssetBalance[] {
  const defaults: Array<{ symbol: AccountAssetSymbol; chain: string; amount: number }> = [
    { symbol: "USDC", chain: "Solana", amount: 10000 },
    { symbol: "USDT", chain: "Solana", amount: 2500 },
    { symbol: "SOL", chain: "Solana", amount: 12.5 },
    { symbol: "MSOL", chain: "Solana", amount: 1.8 },
    { symbol: "ETH", chain: "Ethereum", amount: 1.2 }
  ];
  return defaults.map((asset) => {
    const usdPrice = prices[asset.symbol] ?? 0;
    return {
      symbol: asset.symbol,
      chain: asset.chain,
      amount: asset.amount,
      usdPrice,
      usdValue: Number((asset.amount * usdPrice).toFixed(2)),
      priceSource,
      priceUpdatedAt
    };
  });
}

export function OrchestratorBoard({
  initialDepositUsd = 10000,
  initialProductName = "기본 상품",
  initialEstYieldUsd = 0,
  initialEstFeeUsd = 0,
  initialProductNetwork,
  initialProductSubtype,
  allowJobExecution: allowJobExecutionProp,
  linkedPositionId,
  previewRowsOverride,
  onActionNotice,
  onOpenOperationsWithJob,
  onExecutionComplete
}: OrchestratorBoardProps) {
  const { isConnected, sdk } = usePhantom();
  const accounts = useAccounts();
  const solanaAccount = accounts?.find((account) => account.addressType === AddressType.solana);
  const evmAccount = accounts?.find((account) => account.addressType === AddressType.ethereum);
  const isIdentityConfirmed = true;
  const [depositUsd, setDepositUsd] = useState(initialDepositUsd);
  useEffect(() => {
    setDepositUsd(initialDepositUsd);
  }, [initialDepositUsd]);
  const [job, setJob] = useState<Job | null>(null);
  const [isExecutionDone, setIsExecutionDone] = useState(false);
  const [isExecutionSettled, setIsExecutionSettled] = useState(false);
  const [isExecutionConfirmed, setIsExecutionConfirmed] = useState(false);
  const [isPlanApproved, setIsPlanApproved] = useState(false);
  const [isExecutionSubmitting, setIsExecutionSubmitting] = useState(false);
  const [apiMessage, setApiMessage] = useState<string>("");
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [prices, setPrices] = useState<MarketPriceSnapshot>({
    prices: { USDC: 1, USDT: 1, ETH: 0, SOL: 0, MSOL: 0 },
    updatedAt: new Date().toISOString(),
    source: "fallback"
  });
  const [accountAssets, setAccountAssets] = useState<AccountAssetBalance[]>([]);
  const [assetLoading, setAssetLoading] = useState(false);
  const [assetError, setAssetError] = useState("");
  const [assetSourceLabel, setAssetSourceLabel] = useState("가상 잔고");
  const [assetSnapshotLabel, setAssetSnapshotLabel] = useState("업데이트 전");
  const [solanaNetworkPreference, setSolanaNetworkPreference] = useState<"mainnet" | "devnet">(() => getSolanaNetworkPreference());
  const [selectedSourceAsset, setSelectedSourceAsset] = useState<AccountAssetSymbol>("USDC");
  const [feeEstimate, setFeeEstimate] = useState<ProtocolFeeEstimate | null>(null);
  const [feeEstimateError, setFeeEstimateError] = useState("");
  const [feeEstimateLoading, setFeeEstimateLoading] = useState(false);
  const [executionModeIntent, setExecutionModeIntent] = useState<"dry-run" | "live">(() =>
    getMainnetLivePreference() ? "live" : "dry-run"
  );
  const [applyOrcaMinimumAllocation, setApplyOrcaMinimumAllocation] = useState<boolean>(() =>
    getOrcaMinimumAllocationPreference()
  );
  const [lastExecution, setLastExecution] = useState<ExecuteJobResponse | null>(null);
  /** Job 생성 시 quoteRows로 미리 만들어 둔 포지션 ID (서버 중복 생성 방지용) */
  const [preCreatedPositionId, setPreCreatedPositionId] = useState<string | undefined>(undefined);
  /** 현재 로그인 계정에 등록된 지갑 목록 (계정 연동 검증용) */
  const [linkedWallets, setLinkedWallets] = useState<UserWallet[]>([]);
  /** 실행 요청 전 비밀번호 확인 다이얼로그 표시 여부 */
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);
  const [execVerifyPassword, setExecVerifyPassword] = useState("");
  const [execVerifyLoading, setExecVerifyLoading] = useState(false);
  const [execVerifyError, setExecVerifyError] = useState("");
  const [showPlanConfirm, setShowPlanConfirm] = useState(false);
  const [planApprovalLoading, setPlanApprovalLoading] = useState(false);
  const [planApprovalError, setPlanApprovalError] = useState("");
  const [pendingPlan, setPendingPlan] = useState<DepositExecutionPlanStep[] | null>(null);
  const [executionStepLog, setExecutionStepLog] = useState<ExecutionStepLogEntry[]>([]);
  const [showFundingDetails, setShowFundingDetails] = useState(false);
  const [showRiskDetails, setShowRiskDetails] = useState(false);
  const [showExecutionPlanDetails, setShowExecutionPlanDetails] = useState(false);
  const [showRawPayload, setShowRawPayload] = useState(false);
  const selectedSourceAssetRef = useRef(selectedSourceAsset);
  const correlationId = useMemo(
    () => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `corr_${Date.now()}`),
    []
  );
  useEffect(() => {
    selectedSourceAssetRef.current = selectedSourceAsset;
  }, [selectedSourceAsset]);
  useEffect(() => {
    void (async () => {
      try {
        const info = await fetchRuntimeInfo();
        setRuntime(info);
      } catch {
        setRuntime(null);
      }
    })();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetchMarketPrices({ signal: controller.signal })
      .then((snapshot) => {
        if (!controller.signal.aborted) {
          setPrices(snapshot);
        }
      })
      .catch(() => {
        // 가격은 보조 정보이므로 실패 시 기본값을 유지한다.
      });
    return () => controller.abort();
  }, []);
  const guardrail = useMemo(() => checkGuardrails(), []);
  const isRangeOut = !guardrail.maxPoolOk || !guardrail.maxChainOk;
  const isDepegAlert = false;
  const hasPendingRelease = !isIdentityConfirmed;

  const risk = useMemo(
    () => evaluateRisk({ isSecurityApproved: isIdentityConfirmed, isRangeOut, isDepegAlert, hasPendingRelease }),
    [isIdentityConfirmed, isRangeOut, isDepegAlert, hasPendingRelease]
  );
  const tasks = useMemo(
    () => buildAgentTasks({ isSecurityApproved: isIdentityConfirmed, isRangeOut, isDepegAlert, hasPendingRelease }),
    [isIdentityConfirmed, isRangeOut, isDepegAlert, hasPendingRelease]
  );
  const riskClass = `badge badge-${risk.toLowerCase()}`;
  const hasWallet = Boolean(isConnected && (solanaAccount?.address || evmAccount?.address));
  const jwtAccess = useSyncExternalStore(subscribeLocalAuth, readAccessTokenSnapshot, () => "");
  /**
   * canUseServerJobs: 서버 Job 생성·실행 가능 여부.
   * - JWT 세션 + 지갑 연결 둘 다 필요.
   * - 아이디/비밀번호만 로그인한 경우(hasWallet=false)에는 비활성.
   */
  const canUseServerJobs = jwtAccess.length > 0 && hasWallet && allowJobExecutionProp !== false;
  const canLoadLiveAssets = executionModeIntent === "live" ? hasWallet : canUseServerJobs;
  const sessionUsername = getSession()?.username ?? "";
  useEffect(() => {
    const sync = () => {
      setSolanaNetworkPreference(getSolanaNetworkPreference());
      setExecutionModeIntent(getMainnetLivePreference() ? "live" : "dry-run");
      setApplyOrcaMinimumAllocation(getOrcaMinimumAllocationPreference());
    };
    if (typeof window !== "undefined") {
      window.addEventListener("storage", sync);
    }
    sync();
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("storage", sync);
      }
    };
  }, []);
  const liveSolanaNetwork = solanaNetworkPreference;
  useEffect(() => {
    const controller = new AbortController();
    const cacheScope = {
      kind: "orchestrator" as const,
      mode: executionModeIntent,
      username: sessionUsername,
      solanaAddress: solanaAccount?.address,
      evmAddress: evmAccount?.address
    };
    const sharedWalletCacheScope = {
      kind: "wallet" as const,
      mode: "dry-run" as const,
      username: sessionUsername,
      solanaAddress: solanaAccount?.address,
      evmAddress: evmAccount?.address
    };
    const cachedAssets = loadCachedAccountAssets(cacheScope) ?? loadCachedAccountAssets(sharedWalletCacheScope);
    if (cachedAssets && cachedAssets.length > 0) {
      setAccountAssets(cachedAssets);
      setAssetSnapshotLabel(executionModeIntent === "live" ? "업데이트 전" : "");
      setAssetSourceLabel(executionModeIntent === "live" ? "실잔고(캐시)" : "가상 잔고(캐시)");
      if (!cachedAssets.some((row) => row.symbol === selectedSourceAssetRef.current) && cachedAssets[0]) {
        setSelectedSourceAsset(cachedAssets[0].symbol);
      }
    } else if (!canLoadLiveAssets) {
      setAccountAssets([]);
      setAssetSourceLabel("가상 잔고");
    }
    setAssetLoading(Boolean(canLoadLiveAssets));
    setAssetError("");
    const loadAssets = async () => {
      try {
        if (!canLoadLiveAssets) {
          return;
        }
        if (executionModeIntent === "live") {
          if (!hasWallet) {
            throw new Error("REAL-RUN은 실제 지갑 연결이 필요합니다.");
          }
          const evmAddress = evmAccount?.address as `0x${string}` | undefined;
          const [solanaPortfolioResult, evmPortfolios] = await Promise.all([
            solanaAccount?.address
              ? fetchOnChainPortfolioWithFallback(
                  getSolanaRpcCandidates(liveSolanaNetwork, liveSolanaNetwork !== "devnet"),
                  solanaAccount.address,
                  liveSolanaNetwork
                )
                  .then((value) => ({ ok: true as const, value }))
                  .catch((error: unknown) => ({ ok: false as const, error }))
              : Promise.resolve({ ok: true as const, value: null }),
            evmAddress
              ? Promise.allSettled(
                  (["Ethereum", "Arbitrum", "Base"] as const).map((chainName) =>
                    fetchEvmPortfolioWithFallback(
                      getEvmRpcCandidates(chainName),
                      evmAddress,
                      chainName,
                      prices.prices,
                      prices.source,
                      prices.updatedAt
                    )
                  )
                )
              : Promise.resolve([])
          ]);
          const nextAssets: AccountAssetBalance[] = [];
          if (solanaPortfolioResult.ok && solanaPortfolioResult.value) {
            const solanaPortfolio = solanaPortfolioResult.value;
            const solanaRows: AccountAssetBalance[] = [
              {
                symbol: "SOL",
                chain: "Solana",
                amount: solanaPortfolio.portfolio.sol,
                usdPrice: prices.prices.SOL,
                usdValue: Number((solanaPortfolio.portfolio.sol * prices.prices.SOL).toFixed(2)),
                priceSource: prices.source,
                priceUpdatedAt: prices.updatedAt
              },
              ...solanaPortfolio.portfolio.tokens
                .map((token) => {
                  const symbol: AccountAssetSymbol | null = token.symbol.includes("mSOL")
                    ? "MSOL"
                    : token.symbol.includes("USDC")
                    ? "USDC"
                    : token.symbol.includes("USDT")
                      ? "USDT"
                      : token.symbol.includes("ETH")
                        ? "ETH"
                        : null;
                  if (!symbol) return null;
                  const usdPrice = prices.prices[symbol] ?? 0;
                  const row: AccountAssetBalance = {
                    symbol,
                    chain: "Solana",
                    amount: token.amount,
                    usdPrice,
                    usdValue: Number((token.amount * usdPrice).toFixed(2)),
                    priceSource: prices.source,
                    priceUpdatedAt: prices.updatedAt
                  };
                  return row;
                })
                .filter((row): row is AccountAssetBalance => row !== null)
            ];
            nextAssets.push(...solanaRows);
          }
          evmPortfolios.forEach((result, idx) => {
            if (result.status === "fulfilled") {
              nextAssets.push(...result.value.portfolio);
            } else if (!controller.signal.aborted) {
              console.warn(`EVM ${(["Ethereum", "Arbitrum", "Base"] as const)[idx]} balance fetch failed:`, result.reason);
            }
          });
          // 브라우저 RPC(CORS/레이트리밋) 실패 시 서버 경유 실잔고 API로 자동 폴백
          if (!solanaPortfolioResult.ok || nextAssets.length === 0) {
            const fallbackRows = await listLiveAccountAssets(
              {
                network: liveSolanaNetwork,
                solanaAddress: solanaAccount?.address ?? null,
                evmAddress: evmAddress ?? null
              },
              { signal: controller.signal }
            ).catch(() => []);
            if (fallbackRows.length > 0) {
              if (nextAssets.length === 0) {
                nextAssets.push(...fallbackRows);
              } else if (!nextAssets.some((row) => row.chain === "Solana")) {
                nextAssets.push(...fallbackRows.filter((row) => row.chain === "Solana"));
              }
            }
          }
          if (nextAssets.length === 0) {
            if (cachedAssets && cachedAssets.length > 0) {
              setAccountAssets(cachedAssets);
              saveCachedAccountAssets(cacheScope, cachedAssets);
              setAssetSnapshotLabel("업데이트 전");
              setAssetSourceLabel("실잔고(공유 캐시)");
              if (!cachedAssets.some((row) => row.symbol === selectedSourceAssetRef.current) && cachedAssets[0]) {
                setSelectedSourceAsset(cachedAssets[0].symbol);
              }
              return;
            }
            throw new Error("실잔고를 불러오지 못했습니다.");
          }
          setAccountAssets(nextAssets);
          saveCachedAccountAssets(cacheScope, nextAssets);
          setAssetSourceLabel("실잔고");
          setAssetSnapshotLabel("업데이트 후");
          if (!nextAssets.some((row) => row.symbol === selectedSourceAssetRef.current) && nextAssets[0]) {
            setSelectedSourceAsset(nextAssets[0].symbol);
          }
        } else if (canUseServerJobs) {
          const rows = await listAccountAssets({ signal: controller.signal }, "dry-run");
          if (controller.signal.aborted) return;
          setAccountAssets(rows);
          saveCachedAccountAssets(cacheScope, rows);
          setAssetSourceLabel("가상 잔고");
          setAssetSnapshotLabel("업데이트 후");
          if (!rows.some((row) => row.symbol === selectedSourceAssetRef.current) && rows[0]) {
            setSelectedSourceAsset(rows[0].symbol);
          }
        } else {
          const rows = buildFallbackDryRunAssets(prices.prices, prices.source, prices.updatedAt);
          if (controller.signal.aborted) return;
          setAccountAssets(rows);
          saveCachedAccountAssets(cacheScope, rows);
          setAssetSourceLabel("가상 잔고");
          setAssetSnapshotLabel("업데이트 후");
          if (!rows.some((row) => row.symbol === selectedSourceAssetRef.current) && rows[0]) {
            setSelectedSourceAsset(rows[0].symbol);
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setAssetError(error instanceof Error ? error.message : "계정 자산을 불러오지 못했습니다.");
        if (cachedAssets && cachedAssets.length > 0) {
          setAccountAssets(cachedAssets);
          setAssetSnapshotLabel(executionModeIntent === "live" ? "업데이트 전" : "");
          setAssetSourceLabel(executionModeIntent === "live" ? "실잔고(캐시)" : "가상 잔고(캐시)");
        } else {
          setAccountAssets([]);
          setAssetSnapshotLabel(executionModeIntent === "live" ? "업데이트 전" : "");
          setAssetSourceLabel(executionModeIntent === "live" ? "실잔고" : "가상 잔고");
        }
      } finally {
        if (!controller.signal.aborted) setAssetLoading(false);
      }
    };
    void loadAssets();
    return () => controller.abort();
  }, [canLoadLiveAssets, evmAccount?.address, executionModeIntent, hasWallet, liveSolanaNetwork, selectedSourceAsset, sessionUsername, solanaAccount?.address]);

  useEffect(() => {
    if (accountAssets.length === 0) {
      return;
    }
    if (!accountAssets.some((row) => row.symbol === selectedSourceAsset) && accountAssets[0]) {
      setSelectedSourceAsset(accountAssets[0].symbol);
    }
  }, [accountAssets, selectedSourceAsset]);
  // 로그인 상태가 바뀔 때마다 계정에 연결된 지갑 목록을 가져옴
  useEffect(() => {
    if (!canUseServerJobs) {
      setLinkedWallets([]);
      return;
    }
    const controller = new AbortController();
    void listAccountWallets({ signal: controller.signal })
      .then((wallets) => {
        if (!controller.signal.aborted) setLinkedWallets(wallets);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLinkedWallets([]);
      });
    return () => controller.abort();
  }, [canUseServerJobs]);

  const displayExecutionMode = executionModeIntent;
  const isLiveExecution = displayExecutionMode === "live";
  const livePresetLabel = isLiveExecution ? "REAL-RUN" : "DRY-RUN";
  const [customAllocationPercents, setCustomAllocationPercents] = useState<number[] | null>(null);
  const baseQuoteRows = useMemo(() => {
    const ar = lastExecution?.payload?.adapterResults;
    if (ar && ar.length > 0) {
      const positive = ar.filter((r) => r.allocationUsd > 0);
      if (positive.length > 0) {
        return positive.map((r) => ({
          protocol: r.protocol,
          chain: r.chain,
          action: r.action,
          allocationUsd: r.allocationUsd
        }));
      }
    }
    if (previewRowsOverride && previewRowsOverride.length > 0) {
      return previewRowsOverride;
    }
    const usd = job?.input.depositUsd ?? depositUsd;
    return buildExecutionPreviewRows(usd, initialProductNetwork, initialProductSubtype);
  }, [lastExecution, job, depositUsd, previewRowsOverride, initialProductNetwork, initialProductSubtype]);
  const quoteRows = useMemo(() => {
    if (lastExecution?.payload?.adapterResults?.some((r) => r.allocationUsd > 0)) {
      return baseQuoteRows;
    }
    const total = job?.input.depositUsd ?? depositUsd;
    if (!customAllocationPercents || total <= 0) {
      return baseQuoteRows;
    }
    return baseQuoteRows.map((row, idx) => ({
      ...row,
      allocationUsd: Number(((total * (customAllocationPercents[idx] ?? 0)) / 100).toFixed(2))
    }));
  }, [baseQuoteRows, customAllocationPercents, depositUsd, job, lastExecution]);
  const defaultAllocationPercents = useMemo(() => {
    const total = job?.input.depositUsd ?? depositUsd;
    if (total <= 0) return [];
    return baseQuoteRows.map((row) => Number(((row.allocationUsd / total) * 100).toFixed(2)));
  }, [baseQuoteRows, depositUsd, job]);
  const isResultQuote = Boolean(lastExecution?.payload?.adapterResults?.some((r) => r.allocationUsd > 0));
  const adjustedAllocationTotal = quoteRows.reduce((acc, row) => acc + row.allocationUsd, 0);
  const connectedWalletNetwork = solanaAccount?.address ? "Solana" : evmAccount?.address ? "Ethereum" : undefined;
  const protocolReadiness = useMemo<ProtocolExecutionReadiness[]>(
    () =>
      quoteRows.map((row) => {
        const implemented = !["Aerodrome", "Raydium", "Curve"].includes(row.protocol);
        const requiresSolanaWallet = row.chain === "Solana" || row.protocol === "Orca";
        const requiresEvmWallet = !requiresSolanaWallet && ["Ethereum", "Arbitrum", "Base"].includes(row.chain);
        const hasRequiredWallet = requiresSolanaWallet ? Boolean(solanaAccount?.address) : requiresEvmWallet ? Boolean(evmAccount?.address) : true;
        const orcaLiveSupported = !isLiveExecution || row.protocol !== "Orca" || Boolean(solanaAccount?.address);
        const orcaMinReady =
          !isLiveExecution ||
          row.protocol !== "Orca" ||
          !applyOrcaMinimumAllocation ||
          row.allocationUsd >= ORCA_MIN_LIVE_ALLOCATION_USD;
        const ready = implemented && hasRequiredWallet && orcaLiveSupported && orcaMinReady;
        return {
          protocol: row.protocol,
          chain: row.chain,
          action: row.action,
          implemented,
          flagOn: isLiveExecution,
          ready,
          reason: !implemented
            ? "라이브 미구현"
            : !hasRequiredWallet
              ? requiresSolanaWallet
              ? "Solana 키 필요"
              : "EVM 키 필요"
              : isLiveExecution && row.protocol === "Orca" && !solanaAccount?.address
                ? "Phantom Solana 지갑 필요"
              : isLiveExecution && row.protocol === "Orca" && applyOrcaMinimumAllocation && row.allocationUsd < ORCA_MIN_LIVE_ALLOCATION_USD
                ? `Orca 최소 $${ORCA_MIN_LIVE_ALLOCATION_USD.toFixed(2)} 필요`
              : isLiveExecution && row.protocol === "Orca" && !applyOrcaMinimumAllocation && row.allocationUsd < ORCA_MIN_LIVE_ALLOCATION_USD
                ? `최소금액 미적용 · $${ORCA_MIN_LIVE_ALLOCATION_USD.toFixed(2)} 미만도 시도`
              : "실행 가능"
        };
      }),
    [applyOrcaMinimumAllocation, evmAccount?.address, isLiveExecution, quoteRows, solanaAccount?.address]
  );
  const protocolReadyCount = protocolReadiness.filter((row) => row.ready).length;
  const protocolFlagOnlyCount = protocolReadiness.filter((row) => row.flagOn && !row.ready).length;
  const protocolUnsupportedCount = protocolReadiness.filter((row) => !row.implemented).length;
  const protocolSkippedCount = quoteRows.length - protocolReadyCount;
  const liveExecutableQuoteRows = useMemo(
    () => quoteRows.filter((_row, idx) => protocolReadiness[idx]?.ready ?? true),
    [protocolReadiness, quoteRows]
  );
  const assetReadiness = useMemo(
    () => buildDepositAssetReadiness(accountAssets, selectedSourceAsset, depositUsd, quoteRows, connectedWalletNetwork),
    [accountAssets, connectedWalletNetwork, depositUsd, quoteRows, selectedSourceAsset]
  );
  const executionPlan = useMemo(
    () => buildDepositExecutionPlan(assetReadiness.swapRows, isLiveExecution ? liveExecutableQuoteRows : quoteRows),
    [assetReadiness.swapRows, isLiveExecution, liveExecutableQuoteRows, quoteRows]
  );
  const canCreateJob = assetReadiness.isSufficient && canUseServerJobs;
  useEffect(() => {
    if (!canUseServerJobs || quoteRows.length === 0 || isResultQuote) {
      setFeeEstimate(null);
      setFeeEstimateError("");
      setFeeEstimateLoading(false);
      return;
    }
    const controller = new AbortController();
    setFeeEstimateLoading(true);
    setFeeEstimateError("");
    void estimateProtocolFees(quoteRows, { signal: controller.signal })
      .then((estimate) => {
        if (!controller.signal.aborted) setFeeEstimate(estimate);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setFeeEstimate(null);
        setFeeEstimateError(error instanceof Error ? error.message : "프로토콜별 수수료를 추정하지 못했습니다.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setFeeEstimateLoading(false);
      });
    return () => controller.abort();
  }, [canUseServerJobs, isResultQuote, quoteRows]);
  const canFundDeposit = !canUseServerJobs || assetReadiness.isSufficient;
  const canExecute = Boolean(job) && isExecutionConfirmed && canFundDeposit && (!isLiveExecution || protocolReadyCount > 0) && canUseServerJobs;
  const walletApprovalStepCount = executionPlan.filter((step) => step.requiresWalletApproval).length;
  const quoteTitle = lastExecution?.payload?.adapterResults?.some((r) => r.allocationUsd > 0)
    ? "실행 결과 배분"
    : "입금 처리할 항목";
  const stepIndex = !canFundDeposit
    ? 0
    : quoteRows.length === 0
      ? 1
      : !job
        ? 2
        : !isExecutionConfirmed
          ? 3
          : !isPlanApproved
            ? 4
            : !isExecutionDone
              ? 5
              : !isExecutionSettled
                ? 6
                : 7;
  const stepLabels = ["자산 확인", "견적 확인", "내역 기록", "리스크 검토", "승인 완료", "전송", "확정", "장부 반영"] as const;
  const autoChecks = [
    { key: "wallet", label: "지갑 연결", ok: hasWallet, detail: hasWallet ? "연결됨" : "연결 필요" },
    {
      key: "asset",
      label: "계정 자산",
      ok: assetReadiness.isSufficient,
      detail: assetReadiness.isSufficient ? `${selectedSourceAsset} 잔고 충분` : `$${assetReadiness.missingUsd.toLocaleString()} 부족`
    },
    { key: "guardrail", label: "전략 가드레일", ok: guardrail.maxPoolOk && guardrail.maxChainOk && guardrail.minProtocolOk, detail: "pool/chain/protocol 점검" },
    { key: "identity", label: "본인 확인", ok: isIdentityConfirmed, detail: isIdentityConfirmed ? "계정 기준 진행" : "확인 대기" },
    { key: "depeg", label: "스테이블 디페그", ok: !isDepegAlert, detail: "실시간 피드 연동 전 기본 정상값" }
  ] as const;
  const riskCheckItems = autoChecks.slice(1);
  const passedRiskChecks = riskCheckItems.filter((item) => item.ok).length;
  const findFeeForRoute = (route: (typeof assetReadiness.swapRows)[number]) =>
    feeEstimate?.rows.find((fee) => fee.protocol === route.protocol && fee.chain === route.chain && fee.action === route.action);
  /**
   * quoteRows → protocolMix 변환 헬퍼.
   * 풀별 인출이 정확히 동작하도록 protocol+chain으로 합치지 않고 실행 행 단위 풀을 유지한다.
   */
  function buildProtocolMixFromQuoteRows(rows: typeof quoteRows): { name: string; weight: number; pool?: string }[] {
    const totalUsd = rows.reduce((acc, r) => acc + r.allocationUsd, 0);
    if (totalUsd <= 0 || rows.length === 0) return [];
    return rows.map((row) => ({
      name: row.protocol,
      weight: row.allocationUsd / totalUsd,
      pool: `${row.chain} · ${row.action}`
    }));
  }

  const onCreateJob = async () => {
    if (!canUseServerJobs) {
      if (!hasWallet) {
        setApiMessage("내 입금 작업을 남기려면 먼저 로그인하거나 지갑을 연결하세요.");
        return;
      }
      const walletAddress = solanaAccount?.address ?? evmAccount?.address;
      if (!walletAddress) {
        setApiMessage("지갑 주소를 아직 읽지 못했습니다. 연결 후 다시 시도해 주세요.");
        return;
      }
      try {
        await loginWithWallet(walletAddress, { sdk });
      } catch (error) {
        setApiMessage(error instanceof Error ? error.message : "지갑 세션을 만들지 못했습니다.");
        return;
      }
    }
    if (!assetReadiness.isSufficient) {
      setApiMessage(
        `${selectedSourceAsset} 가용액이 부족합니다. 가용 $${assetReadiness.availableUsd.toLocaleString()} / 요청 $${depositUsd.toLocaleString()}`
      );
      return;
    }
    try {
      const created = await createOrchestratorJob({
        depositUsd,
        isRangeOut,
        isDepegAlert,
        hasPendingRelease,
        sourceAsset: selectedSourceAsset,
        productNetwork: initialProductNetwork,
        productSubtype: initialProductSubtype
      });
      setJob(created);
      setIsExecutionDone(false);
      setIsExecutionSettled(false);
      setIsExecutionConfirmed(false);
      setIsPlanApproved(false);
      setIsExecutionSubmitting(false);
      setLastExecution(null);
      setCustomAllocationPercents(null);
      setPreCreatedPositionId(undefined);
      setExecutionStepLog([
        {
          key: `job-${created.id}-planned`,
          title: "내역 기록",
          detail: `${quoteRows.length}건의 배분안을 기준으로 실행 준비를 시작했습니다.`,
          state: "planned"
        }
      ]);

      // quoteRows(사용자가 선택한 배분)로 포지션을 미리 생성 → 서버의 자동배분 덮어쓰기를 방지
      try {
        const protocolMix = buildProtocolMixFromQuoteRows(quoteRows);
        if (protocolMix.length > 0) {
          const expectedApr = depositUsd > 0 ? initialEstYieldUsd / depositUsd : 0.08;
          const pos = await createDepositPositionRemote({
            productName: initialProductName,
            amountUsd: depositUsd,
            expectedApr: Number.isFinite(expectedApr) && expectedApr > 0 ? expectedApr : 0.08,
            protocolMix
          });
          setPreCreatedPositionId(pos.id);
        }
      } catch {
        // 포지션 사전 생성 실패 시 서버 자동 생성에 위임 (무시)
      }

      setApiMessage(
        hasWallet
          ? `내 입금 작업 생성 완료: ${created.id}${isLiveExecution && protocolSkippedCount > 0 ? ` · 실행 제외 ${protocolSkippedCount}건` : ""}`
          : `내 입금 작업 생성 완료: ${created.id} · REAL-RUN에서는 준비되지 않은 프로토콜을 건너뜁니다.`
      );
    } catch (error) {
      setApiMessage(error instanceof Error ? error.message : "작업 생성 실패");
    }
  };

  /** 실제 executeJob API 호출 (지갑 서명 또는 비밀번호 인증 후 공통 사용) */
  const runExecution = async (authNote: string, clientExecutionResults?: OrcaClientExecutionResult[]) => {
    if (!job) return;
    const idemKey = `exec-${job.id}`;
    const effectivePositionId = preCreatedPositionId ?? linkedPositionId;
    setIsPlanApproved(true);
    setIsExecutionSubmitting(true);
    setExecutionStepLog((prev) => [
      ...prev,
      {
        key: `job-${job.id}-submitting`,
        title: "전송",
        detail: "executeJob 요청을 서버에 전달하는 중입니다.",
        state: "submitting"
      }
    ]);
    try {
      const result = await executeJob(job.id, {
        idempotencyKey: idemKey,
        correlationId,
        positionId: effectivePositionId,
        requestedMode: executionModeIntent,
        protocolReadiness,
        clientExecutionResults: clientExecutionResults?.length ? clientExecutionResults.map((row) => ({ ...row })) : undefined
      });
      setLastExecution(result);
      setIsExecutionDone(true);
      const txRef = result.txId ?? result.requestId;
      const rid = result.requestId ? ` · requestId=${result.requestId}` : "";
      const skippedCount = isLiveExecution ? Math.max(0, protocolReadiness.length - (result.payload?.adapterResults?.length ?? 0)) : 0;
      const skippedNote = skippedCount > 0 ? ` · skipped ${skippedCount}` : "";
      setExecutionStepLog((prev) => [
        ...prev,
        {
          key: `job-${job.id}-submitted`,
          title: "전송됨",
          detail: result.message,
          state: "submitted",
          txId: txRef ?? undefined,
          message: `서버 응답 수신${skippedNote}`
        },
        {
          key: `job-${job.id}-confirmed`,
          title: "확정",
          detail: "서버 실행 결과가 반영되었습니다.",
          state: "confirmed",
          txId: txRef ?? undefined
        }
      ]);
      setApiMessage(`실행 결과: ${result.message}${rid}${skippedNote}${authNote}`);
      await onExecutionComplete?.();
      setIsExecutionSettled(true);
      setExecutionStepLog((prev) => [
        ...prev,
        {
          key: `job-${job.id}-accounted`,
          title: "장부 반영",
          detail: "온체인/장부 동기화가 완료되었습니다.",
          state: "accounted",
          txId: txRef ?? undefined
        }
      ]);
    } catch (error) {
      setExecutionStepLog((prev) => [
        ...prev,
        {
          key: `job-${job.id}-failed`,
          title: "실행 실패",
          detail: error instanceof Error ? error.message : "실행 실패",
          state: "failed"
        }
      ]);
      throw error;
    } finally {
      setIsExecutionSubmitting(false);
    }
  };

  const onExecute = async () => {
    if (!job) {
      setApiMessage("먼저 작업을 생성하세요.");
      return;
    }
    if (!canUseServerJobs && !hasWallet) {
      setApiMessage("내 입금 실행을 요청하려면 먼저 로그인하거나 지갑을 연결하세요.");
      return;
    }
    if (!isExecutionConfirmed) {
      setApiMessage("먼저 리스크 검토를 완료하세요.");
      return;
    }
    if (isLiveExecution && protocolReadyCount === 0) {
      setApiMessage("REAL-RUN으로 실행할 준비된 프로토콜이 없습니다. Phantom Solana 지갑 연결, Orca 최소 금액, 또는 미구현 어댑터 상태를 확인하세요.");
      return;
    }
    try {
      if (!canUseServerJobs && hasWallet) {
        const walletAddress = solanaAccount?.address ?? evmAccount?.address;
        if (!walletAddress) {
          setApiMessage("지갑 주소를 아직 읽지 못했습니다. 연결 후 다시 시도해 주세요.");
          return;
        }
        await loginWithWallet(walletAddress, { sdk });
      }
      const walletProvider = (window as { phantom?: { solana?: { isPhantom?: boolean; signMessage?: (message: Uint8Array) => Promise<unknown> } } }).phantom
        ?.solana;
      const signMessage = walletProvider?.signMessage;
      const canSignWithPhantom = Boolean(walletProvider?.isPhantom && typeof signMessage === "function");

      // 연결된 지갑이 이 계정에 등록된 지갑인지 확인
      const connectedAddress = (solanaAccount?.address ?? "").toLowerCase();
      const isLinkedWallet =
        connectedAddress.length > 0 &&
        linkedWallets.some((w) => w.walletAddress.toLowerCase() === connectedAddress);

      if (isLinkedWallet && canSignWithPhantom) {
        if (isLiveExecution) {
          setPendingPlan(executionPlan);
          setPlanApprovalError("");
          setShowPlanConfirm(true);
          setApiMessage("배분안 확인 후 지갑 순차 승인으로 진행하세요.");
          return;
        }
        const approveMessage = new TextEncoder().encode(`Crypto8 execution approval for ${job.id}`);
        await signMessage?.(approveMessage);
        await runExecution(" · 계정 연동 지갑 서명");
      } else {
        // ⚠️ 등록되지 않은 지갑이거나 지갑 미연결 → 비밀번호 확인 필요
        setExecVerifyPassword("");
        setExecVerifyError("");
        setShowPasswordConfirm(true);
        setApiMessage(
          isLinkedWallet === false && connectedAddress.length > 0
            ? "연결된 Phantom 지갑이 이 계정에 등록된 지갑과 다릅니다. 비밀번호로 본인 확인 후 진행하세요."
            : "내 입금 실행을 위해 비밀번호를 입력해 주세요."
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "실행 실패";
      setApiMessage(msg);
      onActionNotice?.({ variant: "error", text: msg });
    }
  };

  /** 비밀번호 확인 후 실행 처리 */
  const onPasswordVerifiedExecute = async () => {
    const session = getSession();
    if (!session) {
      setExecVerifyError("세션이 만료되었습니다. 다시 로그인해 주세요.");
      return;
    }
    if (!execVerifyPassword) {
      setExecVerifyError("비밀번호를 입력하세요.");
      return;
    }
    setExecVerifyLoading(true);
    setExecVerifyError("");
    try {
      // 비밀번호 재확인 (login API 재호출 → credentials 검증)
      await login(session.username, execVerifyPassword);
      setShowPasswordConfirm(false);
      setExecVerifyPassword("");
      await runExecution(" · 비밀번호 인증");
    } catch (error) {
      setExecVerifyError(error instanceof Error ? error.message : "비밀번호 확인 실패");
    } finally {
      setExecVerifyLoading(false);
    }
  };

  const onConfirmExecution = () => {
    if (!job) {
      setApiMessage("먼저 내 입금 작업을 생성하세요.");
      return;
    }
    if (!assetReadiness.isSufficient) {
      setApiMessage("계정 가용 자산이 입금액보다 작아 리스크 검토를 완료할 수 없습니다.");
      return;
    }
    setIsExecutionConfirmed(true);
    setExecutionStepLog((prev) => [
      ...prev,
      {
        key: `job-${job.id}-quoted`,
        title: "견적 확인",
        detail: "배분안과 실행 내역을 검토했습니다.",
        state: "quoted"
      }
    ]);
    setApiMessage(
      hasWallet
        ? "리스크 검토 완료. 5번에서 승인 완료 후 6번으로 전송하세요."
        : "리스크 검토 완료. dry-run은 지갑 없이 내 실행 기록을 남길 수 있고, REAL-RUN은 준비된 프로토콜만 실제 실행합니다."
    );
  };

  const runPlannedApprovals = async () => {
    if (!job || !pendingPlan || pendingPlan.length === 0) {
      return;
    }
    const walletProvider = (window as { phantom?: { solana?: { isPhantom?: boolean; signMessage?: (message: Uint8Array) => Promise<unknown> } } }).phantom
      ?.solana;
    const signMessage = walletProvider?.signMessage;
    if (!walletProvider?.isPhantom || typeof signMessage !== "function") {
      throw new Error("지갑 서명을 사용할 수 없습니다.");
    }
    setPlanApprovalLoading(true);
    setPlanApprovalError("");
    try {
      const encoded = new TextEncoder();
      let clientExecutionResults: OrcaClientExecutionResult[] | undefined;
      const orcaRows = isLiveExecution ? liveExecutableQuoteRows.filter((row) => row.protocol === "Orca") : [];
      const nextLogs: ExecutionStepLogEntry[] = [];
      setExecutionStepLog([]);
      nextLogs.push({
        key: `job-${job.id}-planned`,
        title: "내역 기록",
        detail: `승인 대상 ${pendingPlan.length}건을 정리했습니다.`,
        state: "planned"
      });
      setExecutionStepLog([...nextLogs]);
      if (isLiveExecution && orcaRows.length > 0) {
        const phantomSolana = (window as { phantom?: { solana?: ISolanaChain } }).phantom?.solana;
        if (!phantomSolana?.publicKey) {
          throw new Error("REAL-RUN Orca 실행을 위해 Phantom Solana 지갑이 필요합니다.");
        }
        const { executeOrcaPlanWithWallet } = await import("../lib/orcaWalletExecution");
        clientExecutionResults = [];
        // 실입금 증빙을 위한 사전 잔고 스냅샷 (실패해도 전체 실행을 막지 않음)
        const solanaAddressForSnapshot = (() => {
          const pk = phantomSolana.publicKey;
          if (!pk) return undefined;
          if (typeof pk === "string") return pk;
          const maybe = pk as { toBase58?: () => string; toString?: () => string };
          return maybe.toBase58?.() ?? maybe.toString?.() ?? undefined;
        })();
        let portfolioBefore: Awaited<ReturnType<typeof fetchOnChainPortfolioWithFallback>>["portfolio"] | null = null;
        if (solanaAddressForSnapshot) {
          try {
            const snap = await fetchOnChainPortfolioWithFallback(
              getSolanaRpcCandidates(liveSolanaNetwork, liveSolanaNetwork !== "devnet"),
              solanaAddressForSnapshot,
              liveSolanaNetwork
            );
            portfolioBefore = snap.portfolio;
          } catch (snapError) {
            console.warn("[OrchestratorBoard] pre-deposit balance snapshot failed:", snapError);
          }
        }
        for (const [index, row] of orcaRows.entries()) {
          const rowPlanSteps = pendingPlan.filter((step) => step.action === row.action && step.requiresWalletApproval);
          for (const step of rowPlanSteps) {
            const message = [
              "Crypto8 step approval",
              `job=${job.id}`,
              `step=${step.order}`,
              `kind=${step.kind}`,
              `title=${step.title}`,
              `detail=${step.detail}`
            ].join("\n");
            await signMessage(encoded.encode(message));
            nextLogs.push({
              key: `approval-${step.order}-${step.kind}-${step.action ?? row.action}`,
              title: step.title,
              detail: step.detail,
              state: "approved"
            });
            setExecutionStepLog([...nextLogs]);
          }
          setIsPlanApproved(true);
          const stepKey = `orca-${index}-${row.action}`;
          nextLogs.push({
            key: stepKey,
            title: `${row.protocol} · ${row.chain} · ${row.action}`,
            detail: `배분 $${row.allocationUsd.toFixed(2)} 실행 중`,
            state: "submitting"
          });
          setExecutionStepLog([...nextLogs]);
          const results = await executeOrcaPlanWithWallet({
            solana: phantomSolana,
            depositUsd: row.allocationUsd,
            productNetwork: job.input.productNetwork,
            productSubtype: job.input.productSubtype,
            network: liveSolanaNetwork,
            sourceAsset: selectedSourceAsset,
            sourceChain: assetReadiness.selectedAsset?.chain,
            actionFilter: [row.action],
            applyMinimumAllocationCheck: applyOrcaMinimumAllocation
          });
          if (results.length === 0) {
            throw new Error(`Orca 실행 결과가 비어 있습니다: ${row.action}`);
          }
          clientExecutionResults.push(...results);
          const executed = results[0];
          nextLogs[nextLogs.length - 1] = {
            ...nextLogs[nextLogs.length - 1],
            state: executed.status === "submitted" ? "submitted" : "skipped",
            txId: executed.txId || undefined,
            message:
              executed.status === "submitted"
                ? "실제 처리 확인됨"
                : executed.errorMessage ?? "최소 금액 미달로 건너뜀"
          };
          setExecutionStepLog([...nextLogs]);
        }
        // 실입금 증빙: 사전 스냅샷이 있었다면 사후 잔고 비교로 변화 감지 로그 남김
        if (portfolioBefore && solanaAddressForSnapshot) {
          try {
            const snapAfter = await fetchOnChainPortfolioWithFallback(
              getSolanaRpcCandidates(liveSolanaNetwork, liveSolanaNetwork !== "devnet"),
              solanaAddressForSnapshot,
              liveSolanaNetwork
            );
            const deltas = diffOnChainPortfolios(portfolioBefore, snapAfter.portfolio);
            const evidence = summarizeDepositEvidence(deltas);
            if (evidence.hasOutflow && evidence.topOutflow) {
              nextLogs.push({
                key: "deposit-evidence",
                title: "실입금 감지",
                detail: `잔고 변화: ${evidence.outflowSymbols.join(", ")} 차감 확인 (top: ${evidence.topOutflow.symbol} ${evidence.topOutflow.delta.toFixed(4)})`,
                state: "confirmed",
                message: "on-chain 잔고 스냅샷 비교"
              });
            } else {
              nextLogs.push({
                key: "deposit-evidence",
                title: "실입금 감지",
                detail: "on-chain 잔고 변화가 감지되지 않았습니다. (네트워크 지연/컨펌 대기 중일 수 있습니다)",
                state: "confirmed",
                message: "잔고 변화 미확인"
              });
            }
            setExecutionStepLog([...nextLogs]);
          } catch (verifyError) {
            console.warn("[OrchestratorBoard] post-deposit balance snapshot failed:", verifyError);
          }
        }
      } else {
        for (const step of pendingPlan) {
          if (!step.requiresWalletApproval) continue;
          const message = [
            "Crypto8 step approval",
            `job=${job.id}`,
            `step=${step.order}`,
            `kind=${step.kind}`,
            `title=${step.title}`,
            `detail=${step.detail}`
          ].join("\n");
          await signMessage(encoded.encode(message));
          nextLogs.push({
            key: `approval-${step.order}-${step.kind}`,
            title: step.title,
            detail: step.detail,
            state: "approved"
          });
          setExecutionStepLog([...nextLogs]);
        }
        setIsPlanApproved(true);
      }
      setShowPlanConfirm(false);
      setPendingPlan(null);
      await runExecution(" · 배분안 순차 승인", clientExecutionResults);
    } catch (error) {
      setPlanApprovalError(error instanceof Error ? error.message : "배분안 승인 실패");
      setExecutionStepLog((prev) =>
        prev.length > 0 ? [...prev.slice(0, -1), { ...prev[prev.length - 1], state: "failed", message: error instanceof Error ? error.message : "배분안 승인 실패" }] : prev
      );
    } finally {
      setPlanApprovalLoading(false);
    }
  };

  return (
    <section className="card orchestrator-card">
      <h2>입금 처리</h2>
      {runtime?.serverExecutionNote || !canUseServerJobs ? (
        <div className="runtime-scope-notice" role="note">
          {runtime?.serverExecutionNote ? <p className="runtime-scope-sub">{runtime.serverExecutionNote}</p> : null}
          {!canUseServerJobs ? (
            <p className="runtime-scope-sub" role="status">
          1~3단계는 <strong>로그인 · 계정</strong> 메뉴에서 아이디·비밀번호(JWT)로 로그인(또는 이용자 가입)한 뒤에 사용할 수 있습니다. dry-run은 Phantom 서명 없이도 내 실행 기록을 남길 수 있습니다.
            </p>
          ) : (
            <p className="runtime-scope-sub" role="status">
              입금 작업·리스크 검토·처리 이력은 현재 로그인한 이용자 계정에만 연결됩니다.
            </p>
          )}
        </div>
      ) : null}
      <div className="execution-context-row">
        <p>상품: {initialProductName}</p>
        <p>금액: ${depositUsd.toFixed(2)}</p>
        <p>예상 수익: ${initialEstYieldUsd.toFixed(2)}</p>
        <p>예상 수수료: ${initialEstFeeUsd.toFixed(2)}</p>
      </div>

      <div className="deposit-asset-routing-card" role="region" aria-label="계정 자산 및 스왑 준비">
        <div className="deposit-asset-routing-head">
          <div>
            <p className="section-eyebrow">Funding Check</p>
            <h3>계정 자산 확인 · 스왑 준비</h3>
            <p>입금액이 선택 자산의 가용액보다 작아야 하며, 각 풀에 필요한 자산으로 스왑·브릿지한 뒤 예치합니다.</p>
            <p className="deposit-asset-network-line">
              연결 지갑 네트워크: <strong>{connectedWalletNetwork ?? "미연결"}</strong>
              {executionModeIntent === "live" ? ` · 실잔고 네트워크: ${liveSolanaNetwork === "mainnet" ? "메인넷" : "데브넷"}` : ""}
              {assetReadiness.selectedAsset ? ` · 계정 자산 보관 체인: ${assetReadiness.selectedAsset.chain}` : ""}
              · 표시 기준: <strong>{assetSnapshotLabel}</strong>
              · 잔고 기준: <strong>{assetSourceLabel}</strong>
            </p>
          </div>
          <label className="deposit-asset-select">
            입금 자산
            <select
              value={selectedSourceAsset}
              onChange={(event) => {
                setSelectedSourceAsset(event.target.value as AccountAssetSymbol);
                setIsExecutionConfirmed(false);
                setIsExecutionDone(false);
                setIsExecutionSettled(false);
                setIsPlanApproved(false);
                setIsExecutionSubmitting(false);
              }}
              disabled={!canUseServerJobs || accountAssets.length === 0}
            >
              {accountAssets.length > 0 ? (
                accountAssets.map((asset) => (
                  <option key={`${asset.symbol}-${asset.chain}`} value={asset.symbol}>
                    {asset.symbol} · {asset.chain}
                  </option>
                ))
              ) : (
                <option value={selectedSourceAsset}>{selectedSourceAsset}</option>
              )}
            </select>
          </label>
        </div>
        {assetLoading ? <p className="deposit-asset-muted">계정별 가용 자산 조회 중...</p> : null}
        {assetError ? <p className="deposit-asset-error">{assetError}</p> : null}
        <div className="deposit-asset-summary-grid">
          <div className={assetReadiness.isSufficient ? "deposit-asset-summary ok" : "deposit-asset-summary warn"}>
            <span>가용액</span>
            <strong>${assetReadiness.availableUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
            <em>
              {assetReadiness.selectedAsset
                ? `${assetReadiness.selectedAsset.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${assetReadiness.selectedAsset.symbol}`
                : "자산 없음"}
            </em>
            <em>{assetSnapshotLabel} · {assetSourceLabel}</em>
          </div>
          <div className={assetReadiness.isSufficient ? "deposit-asset-summary ok" : "deposit-asset-summary warn"}>
            <span>입금 가능 여부</span>
            <strong>{assetReadiness.isSufficient ? "가능" : "부족"}</strong>
            <em>
              {assetReadiness.isSufficient
                ? "잔고 검증 통과"
                : `$${assetReadiness.missingUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} 추가 필요`}
            </em>
          </div>
          <div className="deposit-asset-summary">
            <span>선행 절차</span>
            <strong>스왑 · 브릿지</strong>
            <em>풀별 필요 자산 확보 후 예치</em>
          </div>
          <div className="deposit-asset-summary">
            <span>예상 실행 수수료</span>
            <strong>
              {feeEstimateLoading
                ? "조회 중"
                : feeEstimate
                  ? `$${feeEstimate.totalFeeUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                  : "—"}
            </strong>
            <em>{feeEstimate ? `${feeEstimate.priceSource} · ${new Date(feeEstimate.updatedAt).toLocaleTimeString()}` : "가스·스왑 수수료 포함"}</em>
          </div>
        </div>
        <div className="button-row" style={{ marginTop: 8 }}>
          <button type="button" className="ghost-btn" onClick={() => setShowFundingDetails((prev) => !prev)} aria-expanded={showFundingDetails}>
            {showFundingDetails ? "스왑/수수료 상세 닫기" : "스왑/수수료 상세 보기"}
          </button>
        </div>
        {showFundingDetails ? (
          <>
            <div className="deposit-swap-route-list" aria-label="스왑 및 브릿지 계획">
              {assetReadiness.swapRows.map((row, idx) => {
                const fee = findFeeForRoute(row);
                return (
                  <div key={`${row.target}-${idx}`} className="deposit-swap-route-row">
                    <span>
                      <strong>{row.target}</strong>
                      <em>
                        현재 {row.sourceAsset} · {row.sourceChain} / 목표 {row.requiredAssets.join("/")} · {row.chain}
                      </em>
                    </span>
                    <span>
                      <strong>{row.note}</strong>
                      <em>{row.route}</em>
                    </span>
                    <span>
                      <strong>
                        {fee ? `$${fee.estimatedFeeUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : feeEstimateLoading ? "비용 조회 중" : "비용 —"}
                      </strong>
                      <em>
                        배분 ${row.requiredUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        {fee
                          ? ` · 네트워크 $${fee.networkFeeUsd.toFixed(4)} · 스왑 $${fee.swapFeeUsd.toFixed(2)} · 전송 $${fee.bridgeFeeUsd.toFixed(2)}`
                          : ""}
                      </em>
                    </span>
                  </div>
                );
              })}
            </div>
            {feeEstimateError ? <p className="deposit-asset-error">{feeEstimateError}</p> : null}
            {feeEstimate ? (
              <p className="deposit-fee-estimate-total">
                총 예상 처리비용 ${feeEstimate.totalFeeUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} ·{" "}
                {feeEstimate.rows.some((row) => row.confidence === "medium") ? "일부 실시간 가스 기반" : "fallback 추정"} · 가격 {feeEstimate.priceSource}
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="deposit-risk-review">
        <div className="deposit-risk-review-title">
          <p className="section-eyebrow">Risk Review</p>
          <h3>입금 전 본인 리스크 체크</h3>
        </div>
        <p className="kpi-label">
          핵심 체크 {passedRiskChecks}/{riskCheckItems.length} 통과
        </p>
        <div className="button-row" style={{ marginTop: 6 }}>
          <button type="button" className="ghost-btn" onClick={() => setShowRiskDetails((prev) => !prev)} aria-expanded={showRiskDetails}>
            {showRiskDetails ? "리스크 상세 닫기" : "리스크 상세 보기"}
          </button>
        </div>
        {showRiskDetails ? (
          <div className="deposit-risk-check-grid">
            {riskCheckItems.map((item) => (
              <div key={item.key} className={item.ok ? "deposit-risk-check ok" : "deposit-risk-check wait"}>
                <span>{item.label}</span>
                <strong>{item.ok ? "통과" : "점검 필요"}</strong>
                <em>{item.detail}</em>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <ol className={`execution-steps-strip${isExecutionDone ? " execution-steps-strip--complete" : ""}`} aria-label="진행 단계">
        {stepLabels.map((label, i) => (
          <li
            key={label}
            className={`execution-step${i < stepIndex ? " execution-step--done" : ""}${i === stepIndex ? " execution-step--active" : ""}`}
          >
            <span className="execution-step-n">{i + 1}</span>
            <span className="execution-step-t">{label}</span>
          </li>
        ))}
      </ol>

      <div className="quote-card" role="region" aria-label={quoteTitle}>
        <div className="quote-card-head">
          <h3 className="quote-card-title">{quoteTitle}</h3>
          <div className="quote-card-head-actions">
            {!isResultQuote ? (
              <button type="button" className="quote-default-btn" onClick={() => setCustomAllocationPercents(null)}>
                Default
              </button>
            ) : null}
            <button
              type="button"
              className={isLiveExecution ? "quote-card-mode quote-card-mode--live" : "quote-card-mode"}
              onClick={() => {
                const nextMode = executionModeIntent === "dry-run" ? "live" : "dry-run";
                setExecutionModeIntent(nextMode);
                setMainnetLivePreference(nextMode === "live");
                setIsExecutionConfirmed(false);
                setIsExecutionDone(false);
                setIsExecutionSettled(false);
                setIsPlanApproved(false);
                setIsExecutionSubmitting(false);
                setLastExecution(null);
                setApiMessage(
                  executionModeIntent === "dry-run"
                    ? "REAL-RUN 모드로 전환했습니다. 준비된 프로토콜만 실제 실행됩니다."
                    : "dry-run 모드로 전환했습니다. 지갑 서명 없이 시뮬레이션 기록이 가능합니다."
                );
              }}
              title="dry-run과 REAL-RUN 모드를 전환합니다."
            >
              {livePresetLabel}
            </button>
          </div>
        </div>
        <div className="quote-readiness-summary" aria-label="프로토콜 준비 상태">
          <span className="quote-readiness-pill quote-readiness-pill--ready">실행 가능 {protocolReadyCount}</span>
          <span className="quote-readiness-pill quote-readiness-pill--flag">플래그만 ON {protocolFlagOnlyCount}</span>
          <span className="quote-readiness-pill quote-readiness-pill--blocked">미구현 {protocolUnsupportedCount}</span>
          {isLiveExecution && protocolSkippedCount > 0 ? (
            <span className="quote-readiness-pill quote-readiness-pill--blocked">실행 제외 {protocolSkippedCount}</span>
          ) : null}
        </div>
        {quoteRows.length > 0 ? (
          <div className="quote-card-grid">
            {quoteRows.map((row, idx) => (
              <div key={`${row.protocol}-${row.chain}-${idx}`} className="quote-card-row">
                <span className="quote-card-cell quote-card-protocol">{row.protocol}</span>
                <span className="quote-card-cell quote-card-chain">{row.chain}</span>
                <span className="quote-card-cell quote-card-action">{row.action}</span>
                <span className="quote-card-cell quote-card-usd">${row.allocationUsd.toFixed(2)}</span>
                <span
                  className={
                    protocolReadiness[idx]?.ready
                      ? "quote-card-cell quote-card-readiness quote-card-readiness--ready"
                      : protocolReadiness[idx]?.implemented
                        ? "quote-card-cell quote-card-readiness quote-card-readiness--flag"
                        : "quote-card-cell quote-card-readiness quote-card-readiness--blocked"
                  }
                >
                  {protocolReadiness[idx]?.ready
                    ? "실행 가능"
                    : protocolReadiness[idx]?.implemented
                      ? "플래그만 ON"
                      : "미구현"}
                </span>
                {!isResultQuote ? (
                  <label className="quote-card-slider" aria-label={`${row.protocol} 배분 조율`}>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={(customAllocationPercents ?? defaultAllocationPercents)[idx] ?? 0}
                      onChange={(event) => {
                        const next = [...(customAllocationPercents ?? defaultAllocationPercents)];
                        next[idx] = Number(event.target.value);
                        setCustomAllocationPercents(next);
                      }}
                    />
                    <span>{((customAllocationPercents ?? defaultAllocationPercents)[idx] ?? 0).toFixed(0)}%</span>
                  </label>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="quote-card-empty">금액을 입력하면 어댑터별 시뮬 배분이 표시됩니다.</p>
        )}
        <div className="quote-orca-min-row" aria-label="Orca 최소 배분 설정">
          <label className="quote-orca-min-toggle">
            <input
              type="checkbox"
              checked={applyOrcaMinimumAllocation}
              onChange={(event) => {
                const next = event.target.checked;
                setApplyOrcaMinimumAllocation(next);
                setOrcaMinimumAllocationPreference(next);
                setIsExecutionConfirmed(false);
                setIsExecutionSettled(false);
                setIsPlanApproved(false);
                setIsExecutionSubmitting(false);
                setApiMessage(
                  next
                    ? `Orca 최소 배분 $${ORCA_MIN_LIVE_ALLOCATION_USD.toFixed(2)} 적용`
                    : `Orca 최소 배분 $${ORCA_MIN_LIVE_ALLOCATION_USD.toFixed(2)} 미적용`
                );
              }}
            />
            <span>Orca 최소 배분 적용</span>
          </label>
          <span className="quote-orca-min-hint">
            live 실행에서 <strong>${ORCA_MIN_LIVE_ALLOCATION_USD.toFixed(2)}</strong> 미만 Orca 항목을{" "}
            {applyOrcaMinimumAllocation ? "자동 제외" : "그대로 시도"}합니다.
          </span>
        </div>
        <p className="quote-card-foot">
          입금 전·후 동일한 표 형식으로 예상 배분과 서버 응답을 비교합니다.
          {!isResultQuote ? ` 조율 합계 $${adjustedAllocationTotal.toFixed(2)}` : ""}
          {isLiveExecution ? ` · 실행 가능 ${protocolReadyCount}/${protocolReadiness.length}` : ""}
          {isLiveExecution && protocolSkippedCount > 0 ? ` · 제외 ${protocolSkippedCount}건` : ""}
        </p>
      </div>

      <div className="orchestrator-section" aria-label="실행 순서">
        <h3>배분안 실행 순서</h3>
        <p className="kpi-label">지갑 승인 필요 단계 {walletApprovalStepCount}개 / 전체 {executionPlan.length}개</p>
        <div className="button-row" style={{ marginTop: 6 }}>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => setShowExecutionPlanDetails((prev) => !prev)}
            aria-expanded={showExecutionPlanDetails}
          >
            {showExecutionPlanDetails ? "실행 순서 상세 닫기" : "실행 순서 상세 보기"}
          </button>
        </div>
        {isLiveExecution && protocolSkippedCount > 0 ? (
          <p className="kpi-label">
            live 실행에서는 {applyOrcaMinimumAllocation ? "Orca 최소 금액 미만 또는 " : ""}미지원 항목 {protocolSkippedCount}건이 자동 제외됩니다.
          </p>
        ) : null}
        {showExecutionPlanDetails ? (
          <>
            <p className="kpi-label">
              각 항목은 순서대로 확인되고, REAL-RUN에서는 지갑 승인 프롬프트가 단계별로 뜹니다. 승인 없이 다음 단계로 넘어가지 않습니다.
            </p>
            <ol className="approval-plan-list">
              {executionPlan.map((step) => (
                <li key={`${step.order}-${step.kind}-${step.title}`} className={`approval-plan-step approval-plan-step--${step.kind}`}>
                  <div>
                    <strong>
                      {step.order}. {step.title}
                    </strong>
                    <p>{step.detail}</p>
                  </div>
                  <span>{step.requiresWalletApproval ? "지갑 승인 필요" : "검토만"}</span>
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </div>

      {executionStepLog.length > 0 ? (
        <div className="execution-summary-card" role="region" aria-label="단계별 실행 로그">
          <p className="execution-summary-title">단계별 실행 로그</p>
          <div className="execution-summary-subgroup">
            {executionStepLog.map((step) => (
              <div key={step.key} className={`execution-summary-subline execution-summary-subline--${step.state}`}>
                <p className="execution-summary-line">
                  <span className="execution-summary-k">
                    {executionStateLabel(step.state)}
                  </span>{" "}
                  {step.title}
                </p>
                <p className="execution-summary-line">{step.detail}</p>
                {step.txId ? (
                  <p className="execution-summary-line">
                    <span className="execution-summary-k">tx</span> <code className="execution-summary-code">{step.txId}</code>
                  </p>
                ) : null}
                {step.message ? <p className="execution-summary-line">{step.message}</p> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {job ? (
        <div className="execution-summary-card" role="region" aria-label="실행 추적 키">
          <p className="execution-summary-title">입금 처리 추적</p>
          <p className="execution-summary-line">
            <span className="execution-summary-k">Job</span> {job.id}
          </p>
          <p className="execution-summary-line">
            <span className="execution-summary-k">멱등 키</span> <code className="execution-summary-code">exec-{job.id}</code>
          </p>
          <p className="execution-summary-line">
            <span className="execution-summary-k">상관 ID</span> <code className="execution-summary-code">{correlationId}</code>
          </p>
          {linkedPositionId ? (
            <p className="execution-summary-line">
              <span className="execution-summary-k">연결 포지션</span> <code className="execution-summary-code">{linkedPositionId}</code>
            </p>
          ) : null}
          {onOpenOperationsWithJob ? (
            <div className="button-row" style={{ marginTop: 8 }}>
              <button type="button" className="ghost-btn" onClick={() => onOpenOperationsWithJob(job.id)}>
                운영 이력에서 이 Job 보기
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {lastExecution ? (
        <div className="execution-summary-card execution-summary-result" role="status">
          <p className="execution-summary-title">직전 입금 처리 응답</p>
          <p className="execution-summary-line">
            <span className="execution-summary-k">ok</span> {String(lastExecution.ok)}
          </p>
          {lastExecution.txId ? (
            <p className="execution-summary-line">
              <span className="execution-summary-k">txId</span> <code className="execution-summary-code">{lastExecution.txId}</code>
            </p>
          ) : null}
          {lastExecution.summary ? <p className="execution-summary-line">{lastExecution.summary}</p> : null}
          {lastExecution.payload?.adapterResults?.length ? (
            <div className="execution-summary-subgroup">
              {lastExecution.payload.adapterResults.map((row, idx) => (
                <div key={`${row.protocol}-${row.chain}-${row.action}-${idx}`} className="execution-summary-subline">
                  <p className="execution-summary-line">
                    <span className="execution-summary-k">
                      {row.protocol} / {row.chain}
                    </span>{" "}
                    {row.action}
                  </p>
                  <p className="execution-summary-line">
                    <span className="execution-summary-k">전송</span>{" "}
                    {row.status === "submitted" ? "실제 전송" : row.status === "unsupported" ? "건너뜀" : "시뮬레이션"}
                  </p>
                  <p className="execution-summary-line">
                    <span className="execution-summary-k">tx</span> <code className="execution-summary-code">{row.txId}</code>
                  </p>
                </div>
              ))}
            </div>
          ) : null}
          {lastExecution.payload ? (
            <div className="button-row" style={{ marginTop: 8 }}>
              <button type="button" className="ghost-btn" onClick={() => setShowRawPayload((prev) => !prev)} aria-expanded={showRawPayload}>
                {showRawPayload ? "원본 payload 닫기" : "원본 payload 보기"}
              </button>
            </div>
          ) : null}
          {lastExecution.payload && showRawPayload ? (
            <pre className="execution-payload-pre">{JSON.stringify(lastExecution.payload, null, 2)}</pre>
          ) : null}
        </div>
      ) : null}

      {/* ── 비밀번호 확인 다이얼로그 ── */}
      {showPasswordConfirm && (
        <div className="exec-verify-overlay" role="dialog" aria-modal="true" aria-label="본인 확인">
          <div className="exec-verify-box">
            <p className="exec-verify-title">🔐 본인 확인</p>
            <p className="exec-verify-desc">
              내 입금 실행을 위해 계정 비밀번호를 입력하거나,
              이 계정에 등록된 Phantom 지갑을 연결하세요.
            </p>
            <label className="exec-verify-label">
              비밀번호
              <input
                className="exec-verify-input"
                type="password"
                value={execVerifyPassword}
                onChange={(e) => setExecVerifyPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus
                disabled={execVerifyLoading}
                onKeyDown={(e) => e.key === "Enter" && void onPasswordVerifiedExecute()}
              />
            </label>
            {execVerifyError && (
              <p className="exec-verify-error">{execVerifyError}</p>
            )}
            <div className="exec-verify-actions">
              <button
                type="button"
                className="auth-primary-btn"
                onClick={() => void onPasswordVerifiedExecute()}
                disabled={execVerifyLoading || !execVerifyPassword}
              >
                {execVerifyLoading ? "확인 중…" : "확인 후 실행"}
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  setShowPasswordConfirm(false);
                  setExecVerifyPassword("");
                  setExecVerifyError("");
                }}
                disabled={execVerifyLoading}
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}

      {showPlanConfirm && pendingPlan ? (
        <div className="exec-verify-overlay" role="dialog" aria-modal="true" aria-label="배분안 승인">
          <div className="exec-verify-box exec-verify-box--wide">
            <p className="exec-verify-title">📋 배분안 승인</p>
            <p className="exec-verify-desc">
              아래 순서대로 지갑 승인을 요청합니다. 승인한 뒤에는 중간 단계 없이 순서대로 진행됩니다.
            </p>
            <div className="approval-plan-modal-list">
              {pendingPlan.map((step) => (
                <div key={`${step.order}-${step.kind}-${step.title}`} className="approval-plan-modal-row">
                  <strong>
                    {step.order}. {step.title}
                  </strong>
                  <p>{step.detail}</p>
                </div>
              ))}
            </div>
            {planApprovalError ? <p className="exec-verify-error">{planApprovalError}</p> : null}
            <div className="exec-verify-actions">
              <button
                type="button"
                className="auth-primary-btn"
                onClick={() => void runPlannedApprovals()}
                disabled={planApprovalLoading}
              >
                {planApprovalLoading ? "승인 중…" : `순차 승인 시작 (${walletApprovalStepCount}단계)`}
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  setShowPlanConfirm(false);
                  setPendingPlan(null);
                  setPlanApprovalError("");
                }}
                disabled={planApprovalLoading}
              >
                취소
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {jwtAccess.length > 0 && !hasWallet ? (
        <p className="exec-wallet-required-hint">
          ⚠️ <strong>지갑 연결</strong>이 필요합니다. 지갑을 연결하면 Job 생성·실행·입금이 활성화됩니다.
        </p>
      ) : null}

      <div className="orchestrator-flow-steps" aria-label="예치 실행 절차">
        <button className={canFundDeposit ? "flow-step-btn done" : "flow-step-btn waiting"} disabled>
          1. 자산 확인 {canFundDeposit ? "완료" : "부족"}
        </button>
        <button className={quoteRows.length > 0 ? "flow-step-btn done" : "flow-step-btn waiting"} disabled>
          2. 견적 확인 {quoteRows.length > 0 ? "준비" : "대기"}
        </button>
        <button
          className={job ? "flow-step-btn done" : "flow-step-btn waiting"}
          onClick={onCreateJob}
          disabled={!canCreateJob}
        >
          3. 내역 기록
        </button>
        <button className={isExecutionConfirmed ? "flow-step-btn done" : "flow-step-btn waiting"} onClick={onConfirmExecution} disabled={!job}>
          4. 리스크 검토
        </button>
        <button className={isPlanApproved ? "flow-step-btn done" : "flow-step-btn waiting"} disabled={!job}>
          5. 승인 완료 {isPlanApproved ? "완료" : showPlanConfirm ? "대기" : "대기"}
        </button>
        <button
          className={isExecutionSubmitting ? "flow-step-btn done" : isExecutionDone ? "flow-step-btn done" : "flow-step-btn waiting"}
          onClick={onExecute}
          disabled={!canExecute}
        >
          6. 전송 {isExecutionSubmitting ? "진행" : isExecutionDone ? "완료" : "대기"}
        </button>
        <button className={isExecutionDone ? "flow-step-btn done" : "flow-step-btn waiting"} disabled>
          7. 확정 {isExecutionDone ? "완료" : "대기"}
        </button>
        <button className={isExecutionSettled ? "flow-step-btn done" : "flow-step-btn waiting"} disabled>
          8. 장부 반영 {isExecutionSettled ? "완료" : "대기"}
        </button>
      </div>

      <div className="kpi-grid orchestrator-kpi">
        <div className="kpi-item">
          <p className="kpi-label">지갑 상태</p>
          <p className="kpi-value">{hasWallet ? `${solanaAccount?.address?.slice(0, 6)}...${solanaAccount?.address?.slice(-4)}` : "미연결"}</p>
          <p className="kpi-label">{hasWallet ? "서명·연결용 (Solana)" : "연결 후 진행 가능"}</p>
        </div>
        <div className="kpi-item">
          <p className="kpi-label">현재 위험도</p>
          <p className="kpi-value">
            <span className={riskClass}>{risk}</span>
          </p>
        </div>
        <div className="kpi-item">
          <p className="kpi-label">안전 기준 점검</p>
          <p className="kpi-value">
            pool({guardrail.maxPoolOk ? "OK" : "FAIL"}) / chain({guardrail.maxChainOk ? "OK" : "FAIL"}) / protocol(
            {guardrail.minProtocolOk ? "OK" : "FAIL"})
          </p>
        </div>
        <div className="kpi-item">
          <p className="kpi-label">내 입금 실행 상태</p>
          <p className="kpi-value">{job?.id ? `Job ${job.id.slice(-8)}` : "작업 없음"}</p>
          <p className="kpi-label">{apiMessage || (job ? "상태: 내 입금 실행 대기" : "상태: 대기 중")}</p>
          {lastExecution?.txId ? (
            <p className="kpi-label">
              최근 tx: <code className="execution-summary-code">{lastExecution.txId}</code>
            </p>
          ) : null}
          {lastExecution?.payload?.adapterResults?.length ? (
            <p className="kpi-label">
              최근 전송: {lastExecution.payload.adapterResults.filter((row) => row.status === "submitted").length}건 /{" "}
              {lastExecution.payload.adapterResults.length}건
            </p>
          ) : null}
        </div>
      </div>

      <div className="button-row orchestrator-detail-toggle">
        <button className="ghost-btn" onClick={() => setIsAdvancedOpen((prev) => !prev)}>
          {isAdvancedOpen ? "상세 옵션 닫기" : "상세 옵션 보기"}
        </button>
      </div>

      {isAdvancedOpen ? (
        <div className="orchestrator-section">
          <h3>상세 옵션</h3>
          <p className="kpi-label">
            서버 실효 모드: {runtime ? runtime.executionMode.toUpperCase() : "조회 중"} (요청 {runtime?.executionModeRequested ?? "—"}) · 화면 선택:{" "}
            {displayExecutionMode === "live" ? "실제 입금 실행" : "dry-run"}
          </p>
          <div className="orchestrator-auto-checks">
            {autoChecks.map((item) => (
              <div key={item.key} className={item.ok ? "auto-check-item ok" : "auto-check-item wait"}>
                <p className="kpi-label">{item.label}</p>
                <p className="kpi-value">{item.ok ? "OK" : "대기"}</p>
                <p className="kpi-label">{item.detail}</p>
              </div>
            ))}
          </div>
          <table>
            <thead>
              <tr>
                <th>에이전트</th>
                <th>우선순위</th>
                <th>목표</th>
                <th>완료 조건</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={`${task.agent}-${task.priority}`}>
                  <td>{task.agent}</td>
                  <td>{task.priority}</td>
                  <td>{task.objective}</td>
                  <td>{task.doneDefinition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
