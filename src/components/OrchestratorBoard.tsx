import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AddressType } from "@phantom/browser-sdk";
import { useAccounts, usePhantom } from "@phantom/react-sdk";
import {
  listAccountAssets,
  createOrchestratorJob,
  estimateProtocolFees,
  executeJob,
  fetchRuntimeInfo,
  readAccessTokenSnapshot,
  subscribeLocalAuth,
  type AccountAssetBalance,
  type AccountAssetSymbol,
  type ExecuteJobResponse,
  type Job,
  type ProtocolFeeEstimate,
  type RuntimeInfo
} from "../lib/api";
import { buildDepositAssetReadiness } from "../lib/depositAssetPlan";
import { buildExecutionPreviewRows } from "../lib/executionPreview";
import { buildAgentTasks, evaluateRisk } from "../lib/orchestrator";
import { checkGuardrails } from "../lib/strategyEngine";
import type { ExecutionPreviewRow } from "../lib/executionPreview";

type OrchestratorBoardProps = {
  initialDepositUsd?: number;
  initialProductName?: string;
  initialEstYieldUsd?: number;
  initialEstFeeUsd?: number;
  /** `false`이면 서버 예치 실행 단계를 막습니다(비로그인 상품 체험 등). JWT는 `localStorage` 구독으로 판별합니다. */
  allowJobExecution?: boolean;
  /** 직전 예치 저장으로 생성된 포지션 id(실행 이벤트 페이로드에 연결). */
  linkedPositionId?: string;
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
  allowJobExecution: allowJobExecutionProp,
  linkedPositionId,
  previewRowsOverride,
  onActionNotice,
  onOpenOperationsWithJob,
  onExecutionComplete
}: OrchestratorBoardProps) {
  const { isConnected } = usePhantom();
  const accounts = useAccounts();
  const solanaAccount = accounts?.find((account) => account.addressType === AddressType.solana);
  const isSecurityApproved = true;
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
  const [selectedSourceAsset, setSelectedSourceAsset] = useState<AccountAssetSymbol>("USDC");
  const [feeEstimate, setFeeEstimate] = useState<ProtocolFeeEstimate | null>(null);
  const [feeEstimateError, setFeeEstimateError] = useState("");
  const [feeEstimateLoading, setFeeEstimateLoading] = useState(false);
  const [executionModeIntent, setExecutionModeIntent] = useState<"dry-run" | "live">("dry-run");
  const [lastExecution, setLastExecution] = useState<ExecuteJobResponse | null>(null);
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
  const hasPendingRelease = !isSecurityApproved;

  const risk = useMemo(
    () => evaluateRisk({ isSecurityApproved, isRangeOut, isDepegAlert, hasPendingRelease }),
    [isSecurityApproved, isRangeOut, isDepegAlert, hasPendingRelease]
  );
  const tasks = useMemo(
    () => buildAgentTasks({ isSecurityApproved, isRangeOut, isDepegAlert, hasPendingRelease }),
    [isSecurityApproved, isRangeOut, isDepegAlert, hasPendingRelease]
  );
  const riskClass = `badge badge-${risk.toLowerCase()}`;
  const hasWallet = Boolean(isConnected && solanaAccount?.address);
  const jwtAccess = useSyncExternalStore(subscribeLocalAuth, readAccessTokenSnapshot, () => "");
  const canUseServerJobs = jwtAccess.length > 0 && allowJobExecutionProp !== false;
  useEffect(() => {
    if (!canUseServerJobs) {
      setAccountAssets([]);
      setAssetError("");
      setAssetLoading(false);
      return;
    }
    const controller = new AbortController();
    setAssetLoading(true);
    setAssetError("");
    void listAccountAssets({ signal: controller.signal })
      .then((rows) => {
        if (controller.signal.aborted) return;
        setAccountAssets(rows);
        if (!rows.some((row) => row.symbol === selectedSourceAsset) && rows[0]) {
          setSelectedSourceAsset(rows[0].symbol);
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setAccountAssets([]);
        setAssetError(error instanceof Error ? error.message : "계정 자산을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setAssetLoading(false);
      });
    return () => controller.abort();
  }, [canUseServerJobs, selectedSourceAsset]);
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
    return buildExecutionPreviewRows(usd);
  }, [lastExecution, job, depositUsd, previewRowsOverride]);
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
  const connectedWalletNetwork = hasWallet ? "Solana" : undefined;
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
  const canFundDeposit = !canUseServerJobs || assetReadiness.isSufficient;
  const canExecute = Boolean(job) && isExecutionConfirmed && canUseServerJobs && canFundDeposit && (!isLiveExecution || hasWallet);
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
      ok: assetReadiness.isSufficient,
      detail: assetReadiness.isSufficient ? `${selectedSourceAsset} 잔고 충분` : `$${assetReadiness.missingUsd.toLocaleString()} 부족`
    },
    { key: "guardrail", label: "전략 가드레일", ok: guardrail.maxPoolOk && guardrail.maxChainOk && guardrail.minProtocolOk, detail: "pool/chain/protocol 점검" },
    { key: "security", label: "보안 승인", ok: isSecurityApproved, detail: isSecurityApproved ? "승인 완료" : "승인 대기" },
    { key: "depeg", label: "스테이블 디페그", ok: !isDepegAlert, detail: "실시간 피드 연동 전 기본 정상값" }
  ] as const;
  const findFeeForRoute = (route: (typeof assetReadiness.swapRows)[number]) =>
    feeEstimate?.rows.find((fee) => fee.protocol === route.protocol && fee.chain === route.chain && fee.action === route.action);
  const onCreateJob = async () => {
    if (!canUseServerJobs) {
      setApiMessage("입금내역을 서버에 남기려면 먼저 로그인하세요.");
      return;
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
        sourceAsset: selectedSourceAsset
      });
      setJob(created);
      setIsExecutionDone(false);
      setIsExecutionConfirmed(false);
      setLastExecution(null);
      setCustomAllocationPercents(null);
      setApiMessage(
        hasWallet
          ? `입금내역 확인 완료: ${created.id}`
          : `입금내역 확인 완료: ${created.id} · 라이브 모드 최종 입금 전에는 Phantom(Solana) 지갑 서명이 필요합니다.`
      );
    } catch (error) {
      setApiMessage(error instanceof Error ? error.message : "작업 생성 실패");
    }
  };

  const onExecute = async () => {
    if (!canUseServerJobs) {
      setApiMessage("최종 입금처리를 요청하려면 먼저 로그인하세요.");
      return;
    }
    if (!job) {
      setApiMessage("먼저 작업을 생성하세요.");
      return;
    }
    try {
      const walletProvider = (window as { phantom?: { solana?: { isPhantom?: boolean; signMessage?: (message: Uint8Array) => Promise<unknown> } } }).phantom
        ?.solana;
      const signMessage = walletProvider?.signMessage;
      const canSignWithPhantom = Boolean(walletProvider?.isPhantom && typeof signMessage === "function");
      if (canSignWithPhantom) {
        const approveMessage = new TextEncoder().encode(`Crypto8 execution approval for ${job.id}`);
        await signMessage?.(approveMessage);
      } else if (isLiveExecution) {
        setApiMessage("라이브 실행은 Phantom 지갑 서명이 필요합니다. 지갑 연결 상태를 확인하세요.");
        return;
      }

      const idemKey = `exec-${job.id}`;
      const result = await executeJob(job.id, {
        idempotencyKey: idemKey,
        correlationId,
        positionId: linkedPositionId,
        requestedMode: executionModeIntent
      });
      setIsExecutionDone(true);
      setLastExecution(result);
      const rid = result.requestId ? ` · requestId=${result.requestId}` : "";
      const signNote = canSignWithPhantom ? "" : " · dry-run 지갑 서명 생략";
      setApiMessage(`실행 결과: ${result.message}${rid}${signNote}`);
      await onExecutionComplete?.();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "실행 실패";
      setApiMessage(msg);
      onActionNotice?.({ variant: "error", text: msg });
    }
  };

  const onConfirmExecution = () => {
    if (!job) {
      setApiMessage("먼저 입금내역을 확인하세요.");
      return;
    }
    if (!assetReadiness.isSufficient) {
      setApiMessage("계정 가용 자산이 입금액보다 작아 리스크 검토를 완료할 수 없습니다.");
      return;
    }
    setIsExecutionConfirmed(true);
    setApiMessage(
      hasWallet
        ? "리스크 검토 완료. 4번 버튼으로 최종 입금처리를 요청하세요."
        : "리스크 검토 완료. dry-run은 지갑 없이 최종 입금처리를 기록할 수 있고, live는 Phantom(Solana) 서명이 필요합니다."
    );
  };

  const step4Label = isLiveExecution ? "4. 실제 입금처리" : "4. 최종 입금처리 (dry-run)";

  return (
    <section className="card orchestrator-card">
      <h2>입금 처리</h2>
      {runtime?.serverExecutionNote || !canUseServerJobs ? (
        <div className="runtime-scope-notice" role="note">
          {runtime?.serverExecutionNote ? <p className="runtime-scope-sub">{runtime.serverExecutionNote}</p> : null}
          {!canUseServerJobs ? (
            <p className="runtime-scope-sub" role="status">
          1~3단계는 <strong>로그인 · 계정</strong> 메뉴에서 아이디·비밀번호(JWT)로 로그인(또는 이용자 가입)한 뒤에 사용할 수 있습니다. dry-run은 Phantom 서명 없이도 최종 입금처리를 기록할 수 있습니다.
            </p>
          ) : (
            <p className="runtime-scope-sub" role="status">
              입금내역·리스크 검토·처리 이력은 현재 로그인한 이용자 계정에만 연결됩니다.
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
          <h3>입금 후 보안 체크</h3>
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
                    ? "실제입금처리 모드로 전환했습니다. 리스크 검토 후 Phantom 서명이 필요합니다."
                    : "dry-run 모드로 전환했습니다. 지갑 서명 없이 시뮬레이션 기록이 가능합니다."
                );
              }}
              title="dry-run과 실제입금처리 요청 모드를 전환합니다."
            >
              {isLiveExecution ? "실제입금처리" : "DRY-RUN"}
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
          {lastExecution.payload ? (
            <pre className="execution-payload-pre">{JSON.stringify(lastExecution.payload, null, 2)}</pre>
          ) : null}
        </div>
      ) : null}

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
          disabled={!canUseServerJobs || !canFundDeposit}
        >
          3. 입금내역 확인
        </button>
        <button className={isExecutionConfirmed ? "flow-step-btn done" : "flow-step-btn waiting"} onClick={onConfirmExecution} disabled={!job}>
          4. 리스크 검토
        </button>
        <button
          className={isExecutionDone ? "flow-step-btn done" : "flow-step-btn waiting"}
          onClick={onExecute}
          disabled={!canExecute}
        >
          {step4Label.replace("4.", "5.")}
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
          <p className="kpi-label">입금 처리 상태</p>
          <p className="kpi-value">{job?.id ? `Job ${job.id.slice(-8)}` : "작업 없음"}</p>
          <p className="kpi-label">{apiMessage || (job ? "상태: 최종 입금처리 대기" : "상태: 대기 중")}</p>
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
            {displayExecutionMode === "live" ? "실제입금처리" : "dry-run"}
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
