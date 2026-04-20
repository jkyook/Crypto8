import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AddressType } from "@phantom/browser-sdk";
import { useAccounts, useEthereum, usePhantom } from "@phantom/react-sdk";
import {
  buildAaveUsdcSupplyTx,
  buildAaveUsdcWithdrawTx,
  confirmAaveUsdcTx,
  fetchAaveUsdcPosition,
  fetchMarketPrices,
  listAccountAssets,
  listAccountWallets,
  listWalletAssets,
  login,
  getSession,
  createOrchestratorJob,
  estimateProtocolFees,
  executeJob,
  fetchRuntimeInfo,
  linkAccountWallet,
  readAccessTokenSnapshot,
  subscribeLocalAuth,
  type AccountAssetBalance,
  type AccountAssetSymbol,
  type AaveUsdcChain,
  type AaveUsdcPositionSnapshot,
  type AaveTxRequest,
  type ExecuteJobResponse,
  type Job,
  type ProductNetwork,
  type ProductSubtype,
  type ProtocolFeeEstimate,
  type RuntimeInfo,
  type UserWallet
} from "../lib/api";
import { buildDepositAssetReadiness } from "../lib/depositAssetPlan";
import { buildExecutionPreviewRows } from "../lib/executionPreview";
import { buildAgentTasks, evaluateRisk } from "../lib/orchestrator";
import { checkGuardrails } from "../lib/strategyEngine";
import type { ExecutionPreviewRow } from "../lib/executionPreview";
import {
  fetchOnChainPortfolioWithFallback,
  getSolanaRpcCandidates,
  portfolioToAccountAssetBalances
} from "../lib/solanaChainAssets";

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
  previewRowsOverride?: ExecutionPreviewRow[];
  onActionNotice?: (notice: { variant: "error" | "info"; text: string }) => void;
  onOpenOperationsWithJob?: (jobId: string) => void;
  onExecutionComplete?: () => void | Promise<void>;
};

export function OrchestratorBoard({
  initialDepositUsd = 10000,
  initialProductName = "기본 상품",
  initialEstYieldUsd = 0,
  initialEstFeeUsd = 0,
  initialProductNetwork,
  initialProductSubtype,
  allowJobExecution: allowJobExecutionProp,
  previewRowsOverride,
  onActionNotice,
  onOpenOperationsWithJob,
  onExecutionComplete
}: OrchestratorBoardProps) {
  const { isConnected } = usePhantom();
  const { ethereum, isAvailable: isEthereumAvailable } = useEthereum();
  const accounts = useAccounts();
  const solanaAccount = accounts?.find((account) => account.addressType === AddressType.solana);
  const ethereumAccount = accounts?.find((account) => account.addressType === AddressType.ethereum);
  const [ethereumProviderAddress, setEthereumProviderAddress] = useState("");
  const isIdentityConfirmed = true;
  const [depositUsd, setDepositUsd] = useState(initialDepositUsd);
  useEffect(() => {
    setDepositUsd(initialDepositUsd);
  }, [initialDepositUsd]);
  const [job, setJob] = useState<Job | null>(null);
  const [isExecutionDone, setIsExecutionDone] = useState(false);
  const [isExecutionConfirmed, setIsExecutionConfirmed] = useState(false);
  const [apiMessage, setApiMessage] = useState<string>("");
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [accountAssets, setAccountAssets] = useState<AccountAssetBalance[]>([]);
  const [assetLoading, setAssetLoading] = useState(false);
  const [assetError, setAssetError] = useState("");
  const assetRequestSeq = useRef(0);
  const [selectedSourceAsset, setSelectedSourceAsset] = useState<AccountAssetSymbol>("USDC");
  const [feeEstimate, setFeeEstimate] = useState<ProtocolFeeEstimate | null>(null);
  const [feeEstimateError, setFeeEstimateError] = useState("");
  const [feeEstimateLoading, setFeeEstimateLoading] = useState(false);
  const [aavePosition, setAavePosition] = useState<AaveUsdcPositionSnapshot | null>(null);
  const [aaveLoading, setAaveLoading] = useState(false);
  const [aaveError, setAaveError] = useState("");
  const [aaveTxStatus, setAaveTxStatus] = useState("");
  const [aaveWithdrawLoading, setAaveWithdrawLoading] = useState(false);
  const [executionModeIntent, setExecutionModeIntent] = useState<"dry-run" | "live">("dry-run");
  const [lastExecution, setLastExecution] = useState<ExecuteJobResponse | null>(null);
  /** 현재 로그인 계정에 등록된 지갑 목록 (계정 연동 검증용) */
  const [linkedWallets, setLinkedWallets] = useState<UserWallet[]>([]);
  /** 실행 요청 전 비밀번호 확인 다이얼로그 표시 여부 */
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);
  const [execVerifyPassword, setExecVerifyPassword] = useState("");
  const [execVerifyLoading, setExecVerifyLoading] = useState(false);
  const [execVerifyError, setExecVerifyError] = useState("");
  const correlationId = useMemo(
    () => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `corr_${Date.now()}`),
    []
  );
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
  useEffect(() => {
    if (!isConnected || !isEthereumAvailable) {
      setEthereumProviderAddress("");
      return;
    }
    let disposed = false;
    const setFirstAddress = (accountsLike: unknown): void => {
      const rows = Array.isArray(accountsLike) ? accountsLike : [];
      const first = rows.find((row): row is string => typeof row === "string" && row.length > 0) ?? "";
      if (!disposed) {
        setEthereumProviderAddress(first);
      }
    };
    const sync = async (): Promise<void> => {
      try {
        const existing = await ethereum.getAccounts();
        setFirstAddress(existing);
      } catch {
        setFirstAddress(ethereum.accounts);
      }
    };
    void sync();
    ethereum.on("accountsChanged", setFirstAddress);
    return () => {
      disposed = true;
      ethereum.off("accountsChanged", setFirstAddress);
    };
  }, [ethereum, isConnected, isEthereumAvailable]);

  const evmWalletAddress = ethereumAccount?.address ?? ethereumProviderAddress;
  const aaveUsdcChain =
    initialProductNetwork === "Base" || initialProductNetwork === "Arbitrum" ? (initialProductNetwork as AaveUsdcChain) : null;
  const isAaveUsdcProduct = Boolean(aaveUsdcChain && selectedSourceAsset === "USDC");
  const needsEvmWalletForAave = isAaveUsdcProduct && !evmWalletAddress;
  const hasWallet = Boolean(isConnected && (solanaAccount?.address || evmWalletAddress));
  const jwtAccess = useSyncExternalStore(subscribeLocalAuth, readAccessTokenSnapshot, () => "");
  const session = useMemo(() => getSession(), [jwtAccess]);
  const isWalletLoginSession = Boolean(session?.username.startsWith("wallet_"));
  const canUseServerJobs = jwtAccess.length > 0 && allowJobExecutionProp !== false;
  const linkedEvmWalletAddress = useMemo(
    () => linkedWallets.find((wallet) => {
      const chain = wallet.chain.toLowerCase();
      return chain === "ethereum" || chain === "evm" || chain === "arbitrum" || chain === "base";
    })?.walletAddress ?? "",
    [linkedWallets]
  );
  const effectiveEvmWalletAddress = evmWalletAddress || linkedEvmWalletAddress;
  const aaveWalletNotice = needsEvmWalletForAave
    ? `${aaveUsdcChain ?? "Aave"} USDC 상품은 EVM 지갑이 필요합니다. Phantom의 EVM 계정을 연결하면 잔고 조회와 입금 버튼이 활성화됩니다.`
    : aaveUsdcChain
      ? `EVM 지갑 ${effectiveEvmWalletAddress ? `${effectiveEvmWalletAddress.slice(0, 6)}...${effectiveEvmWalletAddress.slice(-4)}` : "미연결"} 기준으로 ${aaveUsdcChain} USDC 잔고를 조회합니다.`
      : "";
  useEffect(() => {
    const walletAddress = solanaAccount?.address ?? "";
    const evmAddress = effectiveEvmWalletAddress ?? "";
    const hasWalletAddress = Boolean(walletAddress || evmAddress);

    // ── Case 1: 지갑 주소 보유 시 블록체인 잔고 직접 조회 (로그인 불필요, 공개 온체인 데이터)
    if (hasWallet && hasWalletAddress) {
      const controller = new AbortController();
      const requestSeq = assetRequestSeq.current + 1;
      assetRequestSeq.current = requestSeq;
      setAssetLoading(true);
      setAssetError("");
      void listWalletAssets(walletAddress, { signal: controller.signal }, evmAddress || undefined)
        .then(async (rows) => {
          if (controller.signal.aborted || requestSeq !== assetRequestSeq.current) return;
          if (rows.length === 0 && walletAddress) {
            try {
              const [priceSnapshot, onChain] = await Promise.all([
                fetchMarketPrices({ signal: controller.signal }),
                fetchOnChainPortfolioWithFallback(getSolanaRpcCandidates("mainnet"), walletAddress, "mainnet")
              ]);
              if (controller.signal.aborted || requestSeq !== assetRequestSeq.current) return;
              rows = portfolioToAccountAssetBalances(
                onChain.portfolio,
                priceSnapshot.prices,
                priceSnapshot.source,
                priceSnapshot.updatedAt
              );
            } catch {
              // 서버 경로가 비어 있어도 그대로 이어서 아래에서 빈 상태를 반영한다.
            }
          }
          setAccountAssets(rows);
          setSelectedSourceAsset((current) => (rows.some((row) => row.symbol === current) || !rows[0] ? current : rows[0].symbol));
        })
        .catch((error) => {
          if (controller.signal.aborted || requestSeq !== assetRequestSeq.current) return;
          setAccountAssets([]);
          setAssetError(error instanceof Error ? error.message : "연결 지갑 자산을 불러오지 못했습니다.");
        })
        .finally(() => {
          if (!controller.signal.aborted && requestSeq === assetRequestSeq.current) setAssetLoading(false);
        });
      return () => controller.abort();
    }

    // ── Case 2: 지갑 미연결 + 서버 잡 불가 → 빈 목록
    if (!canUseServerJobs) {
      setAccountAssets([]);
      setAssetError("");
      setAssetLoading(false);
      return;
    }

    // ── Case 3: 지갑 미연결 + 로그인됨 → 서버 계정 자산 (연결된 지갑 DB 조회 or 데모)
    if (isWalletLoginSession) {
      setAccountAssets([]);
      setAssetError("지갑 로그인 세션은 연결 지갑 잔고 확인이 필요합니다.");
      setAssetLoading(false);
      return;
    }
    const controller = new AbortController();
    const requestSeq = assetRequestSeq.current + 1;
    assetRequestSeq.current = requestSeq;
    setAssetLoading(true);
    setAssetError("");
    void listAccountAssets({ signal: controller.signal })
      .then((rows) => {
        if (controller.signal.aborted || requestSeq !== assetRequestSeq.current) return;
        setAccountAssets(rows);
        setSelectedSourceAsset((current) => (rows.some((row) => row.symbol === current) || !rows[0] ? current : rows[0].symbol));
      })
      .catch((error) => {
        if (controller.signal.aborted || requestSeq !== assetRequestSeq.current) return;
        setAccountAssets([]);
        setAssetError(error instanceof Error ? error.message : "계정 자산을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!controller.signal.aborted && requestSeq === assetRequestSeq.current) setAssetLoading(false);
      });
    return () => controller.abort();
  }, [canUseServerJobs, effectiveEvmWalletAddress, hasWallet, isWalletLoginSession, solanaAccount?.address]);
  useEffect(() => {
    if (!canUseServerJobs || !aaveUsdcChain || !effectiveEvmWalletAddress) {
      setAavePosition(null);
      setAaveError("");
      setAaveLoading(false);
      return;
    }
    const controller = new AbortController();
    setAaveLoading(true);
    setAaveError("");
    void fetchAaveUsdcPosition(aaveUsdcChain, effectiveEvmWalletAddress, { signal: controller.signal })
      .then((position) => {
        if (!controller.signal.aborted) setAavePosition(position);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setAavePosition(null);
        setAaveError(error instanceof Error ? error.message : "Aave USDC 포지션을 조회하지 못했습니다.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setAaveLoading(false);
      });
    return () => controller.abort();
  }, [aaveUsdcChain, canUseServerJobs, effectiveEvmWalletAddress]);
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
  const adapterResultStatus = (index: number): string | undefined => lastExecution?.payload?.adapterResults?.[index]?.status;
  const adapterResultStatusClass = (status?: string): string => {
    if (status === "confirmed" || status === "simulated") return "badge badge-low";
    if (status === "submitted") return "badge badge-medium";
    if (status === "unsupported") return "badge badge-high";
    if (status === "failed") return "badge badge-critical";
    return "badge badge-medium";
  };
  const adjustedAllocationTotal = quoteRows.reduce((acc, row) => acc + row.allocationUsd, 0);
  const connectedWalletNetwork = useMemo(() => {
    const assetChains = Array.from(new Set(accountAssets.map((asset) => asset.chain)));
    if (assetChains.length === 1) {
      return assetChains[0];
    }
    if (assetChains.length > 1) {
      return "Multi";
    }
    if (solanaAccount?.address && evmWalletAddress) return "Multi";
    if (solanaAccount?.address) return "Solana";
    if (evmWalletAddress) return "EVM";
    return undefined;
  }, [accountAssets, evmWalletAddress, solanaAccount?.address]);
  const assetReadiness = useMemo(
    () => buildDepositAssetReadiness(accountAssets, selectedSourceAsset, depositUsd, quoteRows, connectedWalletNetwork),
    [accountAssets, connectedWalletNetwork, depositUsd, quoteRows, selectedSourceAsset]
  );
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
  const aaveFundingOk = !isAaveUsdcProduct || Boolean(effectiveEvmWalletAddress && aavePosition && aavePosition.walletUsdc >= depositUsd);
  const canFundDeposit = canUseServerJobs && hasWallet && assetReadiness.isSufficient && aaveFundingOk;
  const canStartDepositFlow = canUseServerJobs && hasWallet && canFundDeposit;
  const canExecute = Boolean(job) && isExecutionConfirmed && canStartDepositFlow;
  const quoteTitle = lastExecution?.payload?.adapterResults?.some((r) => r.allocationUsd > 0)
    ? "실행 결과 배분"
    : "입금 처리할 항목";
  const stepIndex = !canFundDeposit ? 0 : quoteRows.length === 0 ? 1 : !job ? 2 : !isExecutionConfirmed ? 3 : !isExecutionDone ? 4 : 5;
  const stepLabels = ["자산", "스왑", "내역", "리스크", "입금", "완료"] as const;
  const autoChecks = [
    { key: "wallet", label: "지갑 연결", ok: hasWallet, detail: hasWallet ? "연결됨" : "연결 필요" },
    {
      key: "asset",
      label: "계정 자산",
      ok: assetReadiness.isSufficient && aaveFundingOk,
      detail:
        needsEvmWalletForAave
          ? "Aave USDC는 Arbitrum/Base EVM 지갑 연결이 필요합니다."
          : isAaveUsdcProduct && !aaveFundingOk
          ? `${aaveUsdcChain ?? ""} USDC 온체인 잔고 부족`
          : assetReadiness.isSufficient
            ? `${selectedSourceAsset} 잔고 충분`
            : `$${assetReadiness.missingUsd.toLocaleString()} 부족`
    },
    { key: "guardrail", label: "전략 가드레일", ok: guardrail.maxPoolOk && guardrail.maxChainOk && guardrail.minProtocolOk, detail: "pool/chain/protocol 점검" },
    { key: "identity", label: "본인 확인", ok: isIdentityConfirmed, detail: isIdentityConfirmed ? "계정 기준 진행" : "확인 대기" },
    { key: "depeg", label: "스테이블 디페그", ok: !isDepegAlert, detail: "실시간 피드 연동 전 기본 정상값" }
  ] as const;
  const findFeeForRoute = (route: (typeof assetReadiness.swapRows)[number]) =>
    feeEstimate?.rows.find((fee) => fee.protocol === route.protocol && fee.chain === route.chain && fee.action === route.action);
  const sendAaveTransaction = async (tx: AaveTxRequest): Promise<string> => {
    if (!ethereum || !effectiveEvmWalletAddress) {
      throw new Error("Aave 입금·출금은 Phantom EVM 지갑 연결이 필요합니다.");
    }
    await ethereum.switchChain(tx.chainId);
    return ethereum.sendTransaction({
      from: effectiveEvmWalletAddress,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      chainId: `0x${tx.chainId.toString(16)}`
    });
  };
  const waitForAaveConfirmation = async (
    chain: AaveUsdcChain,
    walletAddress: string,
    txHash: string,
    kind: "supply" | "withdraw",
    amountUsdc: number
  ) => {
    for (let i = 0; i < 20; i += 1) {
      const result = await confirmAaveUsdcTx(chain, walletAddress, txHash, kind, amountUsdc);
      if (result.status === "confirmed") {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return { status: "pending" as const };
  };
  const onCreateJob = async () => {
    if (!canUseServerJobs) {
      setApiMessage("내 계정에 입금 작업을 남기려면 먼저 로그인하세요.");
      return;
    }
    if (!hasWallet || (!solanaAccount?.address && !evmWalletAddress)) {
      setApiMessage("내 입금 작업을 만들려면 먼저 Phantom 지갑을 연결하세요.");
      return;
    }
    if (!assetReadiness.isSufficient) {
      setApiMessage(
        `${selectedSourceAsset} 가용액이 부족합니다. 가용 $${assetReadiness.availableUsd.toLocaleString()} / 요청 $${depositUsd.toLocaleString()}`
      );
      return;
    }
    if (needsEvmWalletForAave) {
      setApiMessage("Aave 단일 상품은 Arbitrum/Base EVM 지갑 연결이 필요합니다.");
      return;
    }
    if (!aaveFundingOk) {
      setApiMessage(
        `${aaveUsdcChain ?? "Aave"} USDC 온체인 잔고가 부족합니다. 가용 ${aavePosition?.walletUsdc.toLocaleString(undefined, {
          maximumFractionDigits: 6
        }) ?? "0"} USDC / 요청 ${depositUsd.toLocaleString()} USDC`
      );
      return;
    }
    try {
      const walletsToLink = [
        solanaAccount?.address ? { address: solanaAccount.address, chain: "Solana" } : null,
        evmWalletAddress ? { address: evmWalletAddress, chain: aaveUsdcChain ?? "Ethereum" } : null
      ].filter((wallet): wallet is { address: string; chain: string } => Boolean(wallet));
      for (const wallet of walletsToLink) {
        if (!linkedWallets.some((linked) => linked.walletAddress.toLowerCase() === wallet.address.toLowerCase())) {
          const linked = await linkAccountWallet(wallet.address, wallet.chain);
          setLinkedWallets((prev) => [linked, ...prev.filter((item) => item.walletAddress !== linked.walletAddress)]);
        }
      }
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
      setIsExecutionConfirmed(false);
      setLastExecution(null);
      setCustomAllocationPercents(null);

      setApiMessage(
        hasWallet
          ? `내 입금 작업 생성 완료: ${created.id}`
          : `내 입금 작업 생성 완료: ${created.id} · live 요청 전에는 Phantom(Solana) 지갑 서명이 필요합니다.`
      );
    } catch (error) {
      setApiMessage(error instanceof Error ? error.message : "작업 생성 실패");
    }
  };

  /** 실제 executeJob API 호출 (지갑 서명 또는 비밀번호 인증 후 공통 사용) */
  const runExecution = async (authNote: string) => {
    if (!job) return;
    const idemKey = `exec-${job.id}`;
    const result = await executeJob(job.id, {
      idempotencyKey: idemKey,
      correlationId,
      requestedMode: executionModeIntent
    });
    setIsExecutionDone(true);
    setLastExecution(result);
    const rid = result.requestId ? ` · requestId=${result.requestId}` : "";
    setApiMessage(`실행 결과: ${result.message}${rid}${authNote}`);
    await onExecutionComplete?.();
  };

  const runAaveLiveSupply = async () => {
    if (!job || !aaveUsdcChain) return;
    if (!evmWalletAddress) {
      setApiMessage("Aave 실제 입금 실행에는 Phantom EVM 지갑 연결이 필요합니다.");
      return;
    }
    setAaveTxStatus("Aave V3 입금 트랜잭션 생성 중...");
    const built = await buildAaveUsdcSupplyTx(aaveUsdcChain, evmWalletAddress, depositUsd);
    let supplyHash = "";
    for (const tx of built.transactions) {
      setAaveTxStatus(`${tx.description} · 지갑 서명 대기`);
      const txHash = await sendAaveTransaction(tx);
      setAaveTxStatus(`${tx.kind === "approve" ? "승인" : "입금"} 제출됨: ${txHash}`);
      if (tx.kind === "supply") {
        supplyHash = txHash;
      }
    }
    if (!supplyHash) {
      throw new Error("Aave supply 트랜잭션 해시를 받지 못했습니다.");
    }
    setAaveTxStatus("Aave 입금 영수증 확인 중...");
    const confirmed = await waitForAaveConfirmation(aaveUsdcChain, evmWalletAddress, supplyHash, "supply", depositUsd);
    const message = confirmed.status === "confirmed" ? "Aave V3 USDC 입금 확정" : "Aave V3 USDC 입금 제출됨";
    const result: ExecuteJobResponse = {
      ok: true,
      message,
      txId: supplyHash,
      summary:
        confirmed.status === "confirmed"
          ? "온체인 receipt 확인 후 포트폴리오 포지션을 확정했습니다."
          : "트랜잭션이 아직 pending입니다. 잠시 뒤 포지션 조회를 다시 확인하세요.",
      payload: {
        v: 1,
        mode: "live",
        correlationId,
        adapterResults: [
          {
            protocol: "Aave",
            chain: aaveUsdcChain,
            action: "USDC supply",
            allocationUsd: depositUsd,
            txId: supplyHash,
            status: confirmed.status === "confirmed" ? "confirmed" : "submitted"
          }
        ]
      }
    };
    setIsExecutionDone(true);
    setLastExecution(result);
    setApiMessage(`${message} · txId=${supplyHash}`);
    setAaveTxStatus(result.summary ?? message);
    await fetchAaveUsdcPosition(aaveUsdcChain, effectiveEvmWalletAddress).then(setAavePosition).catch(() => undefined);
    await onExecutionComplete?.();
  };

  const onAaveWithdraw = async () => {
    if (!aaveUsdcChain || !effectiveEvmWalletAddress) {
      setApiMessage("Aave 출금은 Phantom EVM 지갑 연결이 필요합니다.");
      return;
    }
    const amountUsdc = Math.min(depositUsd, aavePosition?.suppliedUsdc ?? 0);
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
      setApiMessage("출금할 Aave USDC 공급 잔고가 없습니다.");
      return;
    }
    setAaveWithdrawLoading(true);
    setAaveTxStatus("Aave V3 출금 트랜잭션 생성 중...");
    try {
      const built = await buildAaveUsdcWithdrawTx(aaveUsdcChain, effectiveEvmWalletAddress, amountUsdc);
      setAaveTxStatus(`${built.transaction.description} · 지갑 서명 대기`);
      const txHash = await sendAaveTransaction(built.transaction);
      setAaveTxStatus(`출금 제출됨: ${txHash} · 영수증 확인 중...`);
      const confirmed = await waitForAaveConfirmation(aaveUsdcChain, effectiveEvmWalletAddress, txHash, "withdraw", amountUsdc);
      const message = confirmed.status === "confirmed" ? "Aave V3 USDC 출금 확정" : "Aave V3 USDC 출금 제출됨";
      setApiMessage(`${message} · txId=${txHash}`);
      setAaveTxStatus(
        confirmed.status === "confirmed"
          ? "온체인 receipt 확인 후 포트폴리오와 출금 장부를 갱신했습니다."
          : "트랜잭션이 아직 pending입니다. 잠시 뒤 포지션 조회를 다시 확인하세요."
      );
      await fetchAaveUsdcPosition(aaveUsdcChain, effectiveEvmWalletAddress).then(setAavePosition).catch(() => undefined);
      await onExecutionComplete?.();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Aave 출금 실패";
      setApiMessage(msg);
      setAaveTxStatus(msg);
      onActionNotice?.({ variant: "error", text: msg });
    } finally {
      setAaveWithdrawLoading(false);
    }
  };

  const onExecute = async () => {
    if (!canUseServerJobs) {
      setApiMessage("내 입금 실행을 요청하려면 먼저 로그인하세요.");
      return;
    }
    if (!job) {
      setApiMessage("먼저 작업을 생성하세요.");
      return;
    }
    try {
      if (isLiveExecution && isAaveUsdcProduct) {
        await runAaveLiveSupply();
        return;
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
        // ✅ 계정 등록 지갑 → Phantom 서명
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
    if (!aaveFundingOk) {
      setApiMessage("Aave 단일 상품의 대상 체인 USDC 잔고가 입금액보다 작아 리스크 검토를 완료할 수 없습니다.");
      return;
    }
    setIsExecutionConfirmed(true);
    setApiMessage(
      hasWallet
        ? "리스크 검토 완료. 5번 버튼으로 내 입금 실행을 요청하세요."
        : "리스크 검토 완료. dry-run은 지갑 없이 내 실행 기록을 남길 수 있고, live는 Phantom(Solana) 서명이 필요합니다."
    );
  };

  const executionButtonLabel = isLiveExecution ? "4. 실제 입금 실행" : "4. 내 입금 실행 (dry-run)";

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
              {assetReadiness.selectedAsset ? ` · 계정 자산 보관 체인: ${assetReadiness.selectedAsset.chain}` : ""}
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
              }}
              disabled={accountAssets.length === 0}
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
        {aaveUsdcChain ? (
          <div className="deposit-aave-panel" role="region" aria-label="Aave V3 USDC 온체인 포지션">
            <div>
              <p className="section-eyebrow">Aave V3 USDC</p>
              <h3>{aaveUsdcChain} 단일 상품 온체인 조회</h3>
              <p>
                USDC 승인, Aave Pool 공급, aUSDC 잔고 조회, Pool 출금을 같은 지갑 주소 기준으로 처리합니다.
              </p>
            </div>
            <div className={`deposit-asset-summary ${needsEvmWalletForAave ? "warn" : "ok"}`}>
              <span>{needsEvmWalletForAave ? "EVM 지갑 필요" : "EVM 지갑 상태"}</span>
              <strong>{needsEvmWalletForAave ? "연결 필요" : "준비 완료"}</strong>
              <em>{aaveWalletNotice}</em>
            </div>
            {aaveLoading ? <p className="deposit-asset-muted">Aave 포지션 조회 중...</p> : null}
            {aaveError ? <p className="deposit-asset-error">{aaveError}</p> : null}
            {aavePosition ? (
              <div className="deposit-aave-metrics">
                <span>
                  <em>지갑 USDC</em>
                  <strong>{aavePosition.walletUsdc.toLocaleString(undefined, { maximumFractionDigits: 6 })}</strong>
                </span>
                <span>
                  <em>Aave 공급 USDC</em>
                  <strong>{aavePosition.suppliedUsdc.toLocaleString(undefined, { maximumFractionDigits: 6 })}</strong>
                </span>
                <span>
                  <em>Pool</em>
                  <code>{`${aavePosition.poolAddress.slice(0, 6)}...${aavePosition.poolAddress.slice(-4)}`}</code>
                </span>
                <span>
                  <em>aToken</em>
                  <code>{`${aavePosition.aTokenAddress.slice(0, 6)}...${aavePosition.aTokenAddress.slice(-4)}`}</code>
                </span>
              </div>
            ) : null}
            <div className="button-row">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  if (!aaveUsdcChain || !effectiveEvmWalletAddress) return;
                  setAaveLoading(true);
                  setAaveError("");
                  void fetchAaveUsdcPosition(aaveUsdcChain, effectiveEvmWalletAddress)
                    .then(setAavePosition)
                    .catch((error) => setAaveError(error instanceof Error ? error.message : "Aave 포지션 조회 실패"))
                    .finally(() => setAaveLoading(false));
                }}
                disabled={!effectiveEvmWalletAddress || aaveLoading}
              >
                {effectiveEvmWalletAddress ? "Aave 잔고 새로고침" : "EVM 지갑 먼저 연결"}
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => void onAaveWithdraw()}
                disabled={!effectiveEvmWalletAddress || !aavePosition || aavePosition.suppliedUsdc <= 0 || aaveWithdrawLoading}
              >
                {aaveWithdrawLoading
                  ? "출금 처리 중..."
                  : effectiveEvmWalletAddress
                    ? `Aave에서 ${Math.min(depositUsd, aavePosition?.suppliedUsdc ?? 0).toLocaleString()} USDC 출금`
                    : "EVM 지갑 연결 후 출금"}
              </button>
            </div>
            {needsEvmWalletForAave ? <p className="deposit-asset-error">Aave 입금/출금은 Arbitrum 또는 Base EVM 지갑 연결이 필요합니다.</p> : null}
            {aaveTxStatus ? <p className="deposit-asset-muted">{aaveTxStatus}</p> : null}
          </div>
        ) : null}
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
      </div>

      <div className="deposit-risk-review">
        <div className="deposit-risk-review-title">
          <p className="section-eyebrow">Risk Review</p>
          <h3>입금 전 본인 리스크 체크</h3>
        </div>
        <div className="deposit-risk-check-grid">
          {autoChecks.slice(1).map((item) => (
            <div key={item.key} className={item.ok ? "deposit-risk-check ok" : "deposit-risk-check wait"}>
              <span>{item.label}</span>
              <strong>{item.ok ? "통과" : "점검 필요"}</strong>
              <em>{item.detail}</em>
            </div>
          ))}
        </div>
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
                setExecutionModeIntent((prev) => (prev === "dry-run" ? "live" : "dry-run"));
                setIsExecutionConfirmed(false);
                setIsExecutionDone(false);
                setLastExecution(null);
                setApiMessage(
                  executionModeIntent === "dry-run"
                    ? "실제 입금 실행 모드로 전환했습니다. 리스크 검토 후 Phantom 서명이 필요합니다."
                    : "dry-run 모드로 전환했습니다. 지갑 서명 없이 시뮬레이션 기록이 가능합니다."
                );
              }}
              title="dry-run과 실제 입금 실행 요청 모드를 전환합니다."
            >
              {isLiveExecution ? "실제 입금 실행" : "DRY-RUN"}
            </button>
          </div>
        </div>
        {quoteRows.length > 0 ? (
          <div className="quote-card-grid">
            {quoteRows.map((row, idx) => (
              <div key={`${row.protocol}-${row.chain}-${idx}`} className="quote-card-row">
                <span className="quote-card-cell quote-card-protocol">{row.protocol}</span>
                <span className="quote-card-cell quote-card-chain">{row.chain}</span>
                <span className="quote-card-cell quote-card-action">{row.action}</span>
                <span className="quote-card-cell quote-card-usd">${row.allocationUsd.toFixed(2)}</span>
                {isResultQuote ? (
                  <span className="quote-card-cell quote-card-status">
                    <span className={adapterResultStatusClass(adapterResultStatus(idx))}>
                      {adapterResultStatus(idx) ?? "simulated"}
                    </span>
                  </span>
                ) : null}
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
        <p className="quote-card-foot">
          입금 전·후 동일한 표 형식으로 예상 배분과 서버 응답을 비교합니다.
          {!isResultQuote ? ` 조율 합계 $${adjustedAllocationTotal.toFixed(2)}` : ""}
        </p>
      </div>

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
          {lastExecution.payload ? (
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

      <div className="orchestrator-flow-steps" aria-label="예치 실행 절차">
        <button className={canFundDeposit ? "flow-step-btn done" : "flow-step-btn waiting"} disabled>
          1. 자산 확인 {canFundDeposit ? "완료" : "부족"}
        </button>
        <button className={quoteRows.length > 0 ? "flow-step-btn done" : "flow-step-btn waiting"} disabled>
          2. 스왑 경로 {quoteRows.length > 0 ? "준비" : "대기"}
        </button>
        <button
          className={job ? "flow-step-btn done" : "flow-step-btn waiting"}
          onClick={onCreateJob}
          disabled={!canStartDepositFlow}
        >
          3. 내 입금 작업 생성
        </button>
        <button className={isExecutionConfirmed ? "flow-step-btn done" : "flow-step-btn waiting"} onClick={onConfirmExecution} disabled={!job}>
          4. 리스크 검토
        </button>
        <button
          className={isExecutionDone ? "flow-step-btn done" : "flow-step-btn waiting"}
          onClick={onExecute}
          disabled={!canExecute}
        >
          {executionButtonLabel.replace("4.", "5.")}
        </button>
      </div>

      <div className="kpi-grid orchestrator-kpi">
        <div className="kpi-item">
          <p className="kpi-label">지갑 상태</p>
          <p className="kpi-value">{hasWallet ? `${solanaAccount?.address?.slice(0, 6)}...${solanaAccount?.address?.slice(-4)}` : "미연결"}</p>
          <p className="kpi-label">{hasWallet ? "입금 잔고·서명 확인용" : "지갑 연결 후 진행 가능"}</p>
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
