import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AddressType } from "@phantom/browser-sdk";
import { useAccounts, usePhantom } from "@phantom/react-sdk";
import {
  createOrchestratorJob,
  executeJob,
  fetchRuntimeInfo,
  readAccessTokenSnapshot,
  subscribeLocalAuth,
  type ExecuteJobResponse,
  type Job,
  type RuntimeInfo
} from "../lib/api";
import { buildExecutionPreviewRows } from "../lib/executionPreview";
import { buildAgentTasks, evaluateRisk } from "../lib/orchestrator";
import { checkGuardrails } from "../lib/strategyEngine";

type OrchestratorBoardProps = {
  initialDepositUsd?: number;
  initialProductName?: string;
  initialEstYieldUsd?: number;
  initialEstFeeUsd?: number;
  /** `false`이면 서버 예치 실행 단계를 막습니다(비로그인 상품 체험 등). JWT는 `localStorage` 구독으로 판별합니다. */
  allowJobExecution?: boolean;
  /** 직전 예치 저장으로 생성된 포지션 id(실행 이벤트 페이로드에 연결). */
  linkedPositionId?: string;
  onActionNotice?: (notice: { variant: "error" | "info"; text: string }) => void;
  onOpenOperationsWithJob?: (jobId: string) => void;
};

export function OrchestratorBoard({
  initialDepositUsd = 10000,
  initialProductName = "기본 상품",
  initialEstYieldUsd = 0,
  initialEstFeeUsd = 0,
  allowJobExecution: allowJobExecutionProp,
  linkedPositionId,
  onActionNotice,
  onOpenOperationsWithJob
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
  const canExecute = Boolean(job) && hasWallet && isExecutionConfirmed && canUseServerJobs;
  const quoteRows = useMemo(() => {
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
    const usd = job?.input.depositUsd ?? depositUsd;
    return buildExecutionPreviewRows(usd);
  }, [lastExecution, job, depositUsd]);
  const quoteTitle = lastExecution?.payload?.adapterResults?.some((r) => r.allocationUsd > 0)
    ? "실행 결과 배분"
    : "시뮬 견적 (어댑터 분배)";
  const stepIndex = !hasWallet ? 0 : !job ? 1 : !isExecutionConfirmed ? 2 : !isExecutionDone ? 3 : 4;
  const stepLabels = ["지갑", "작업", "확인", "실행", "완료"] as const;
  const autoChecks = [
    { key: "wallet", label: "지갑 연결", ok: hasWallet, detail: hasWallet ? "연결됨" : "연결 필요" },
    { key: "guardrail", label: "전략 가드레일", ok: guardrail.maxPoolOk && guardrail.maxChainOk && guardrail.minProtocolOk, detail: "pool/chain/protocol 점검" },
    { key: "security", label: "보안 승인", ok: isSecurityApproved, detail: isSecurityApproved ? "승인 완료" : "승인 대기" },
    { key: "depeg", label: "스테이블 디페그", ok: !isDepegAlert, detail: "실시간 피드 연동 전 기본 정상값" }
  ] as const;
  const onCreateJob = async () => {
    if (!canUseServerJobs) {
      setApiMessage("예치 요청을 서버에 남기려면 먼저 로그인하세요.");
      return;
    }
    try {
      const created = await createOrchestratorJob({
        depositUsd,
        isRangeOut,
        isDepegAlert,
        hasPendingRelease
      });
      setJob(created);
      setIsExecutionDone(false);
      setIsExecutionConfirmed(false);
      setLastExecution(null);
      setApiMessage(
        hasWallet
          ? `작업 생성 완료: ${created.id}`
          : `작업 생성 완료: ${created.id} · 서버 실행(3단계) 전에 Phantom(Solana) 지갑을 연결하세요.`
      );
    } catch (error) {
      setApiMessage(error instanceof Error ? error.message : "작업 생성 실패");
    }
  };

  const onExecute = async () => {
    if (!canUseServerJobs) {
      setApiMessage("서버 실행을 요청하려면 먼저 로그인하세요.");
      return;
    }
    if (!job) {
      setApiMessage("먼저 작업을 생성하세요.");
      return;
    }
    try {
      const walletProvider = (window as { phantom?: { solana?: { isPhantom?: boolean; signMessage?: (message: Uint8Array) => Promise<unknown> } } }).phantom
        ?.solana;
      if (!walletProvider?.isPhantom || typeof walletProvider.signMessage !== "function") {
        setApiMessage("지갑 승인 실패: Phantom 지갑 서명 기능을 사용할 수 없습니다.");
        return;
      }
      const approveMessage = new TextEncoder().encode(`Crypto8 execution approval for ${job.id}`);
      await walletProvider.signMessage(approveMessage);

      const idemKey = `exec-${job.id}`;
      const result = await executeJob(job.id, {
        idempotencyKey: idemKey,
        correlationId,
        positionId: linkedPositionId
      });
      setIsExecutionDone(true);
      setLastExecution(result);
      const rid = result.requestId ? ` · requestId=${result.requestId}` : "";
      setApiMessage(`실행 결과: ${result.message}${rid}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "실행 실패";
      setApiMessage(msg);
      onActionNotice?.({ variant: "error", text: msg });
    }
  };

  const onConfirmExecution = () => {
    if (!job) {
      setApiMessage("먼저 1번으로 예치 요청을 생성하세요.");
      return;
    }
    setIsExecutionConfirmed(true);
    setApiMessage(
      hasWallet
        ? "실행 확인 완료. 3번 버튼으로 서버 실행을 요청하세요."
        : "실행 확인 완료. 서버 실행을 하려면 Phantom(Solana) 지갑을 연결한 뒤 3번을 누르세요."
    );
  };

  const step3Label = runtime?.executionMode === "live" ? "3. 서버 실행" : "3. 서버 실행 (시뮬레이션)";

  return (
    <section className="card orchestrator-card">
      <h2>예치 실행 확인</h2>
      {runtime?.serverExecutionNote || !canUseServerJobs ? (
        <div className="runtime-scope-notice" role="note">
          {runtime?.serverExecutionNote ? <p className="runtime-scope-sub">{runtime.serverExecutionNote}</p> : null}
          {!canUseServerJobs ? (
            <p className="runtime-scope-sub" role="status">
              1~3단계는 <strong>로그인 · 계정</strong> 메뉴에서 아이디·비밀번호(JWT)로 로그인(또는 이용자 가입)한 뒤에 사용할 수 있습니다. Phantom 지갑만으로는 서버 예치 실행이 열리지 않습니다.
            </p>
          ) : (
            <p className="runtime-scope-sub" role="status">
              예치 요청·실행 이력은 현재 로그인한 이용자 계정에만 연결됩니다.
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
          <span className="quote-card-mode">{runtime?.executionMode ? runtime.executionMode.toUpperCase() : "—"}</span>
        </div>
        {quoteRows.length > 0 ? (
          <div className="quote-card-grid">
            {quoteRows.map((row, idx) => (
              <div key={`${row.protocol}-${row.chain}-${idx}`} className="quote-card-row">
                <span className="quote-card-cell quote-card-protocol">{row.protocol}</span>
                <span className="quote-card-cell quote-card-chain">{row.chain}</span>
                <span className="quote-card-cell quote-card-action">{row.action}</span>
                <span className="quote-card-cell quote-card-usd">${row.allocationUsd.toFixed(2)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="quote-card-empty">금액을 입력하면 어댑터별 시뮬 배분이 표시됩니다.</p>
        )}
        <p className="quote-card-foot">실행 전·후 동일한 표 형식으로 시뮬과 서버 응답을 비교합니다.</p>
      </div>

      {job ? (
        <div className="execution-summary-card" role="region" aria-label="실행 추적 키">
          <p className="execution-summary-title">실행 추적</p>
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
          <p className="execution-summary-title">직전 서버 응답</p>
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
        <button className={hasWallet ? "flow-step-btn done" : "flow-step-btn waiting"} disabled={!hasWallet}>
          0. 지갑 연결 {hasWallet ? "완료" : "필요"}
        </button>
        <button
          className={job ? "flow-step-btn done" : "flow-step-btn waiting"}
          onClick={onCreateJob}
          disabled={!canUseServerJobs}
        >
          1. 예치 요청 생성
        </button>
        <button className={isExecutionConfirmed ? "flow-step-btn done" : "flow-step-btn waiting"} onClick={onConfirmExecution} disabled={!job}>
          2. 실행 확인
        </button>
        <button
          className={isExecutionDone ? "flow-step-btn done" : "flow-step-btn waiting"}
          onClick={onExecute}
          disabled={!canExecute}
        >
          {step3Label}
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
          <p className="kpi-label">예치 작업 상태</p>
          <p className="kpi-value">{job?.id ? `Job ${job.id.slice(-8)}` : "작업 없음"}</p>
          <p className="kpi-label">{apiMessage || (job ? "상태: 실행 대기" : "상태: 대기 중")}</p>
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
            서버 실효 모드: {runtime ? runtime.executionMode.toUpperCase() : "조회 중"} (요청 {runtime?.executionModeRequested ?? "—"})
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
