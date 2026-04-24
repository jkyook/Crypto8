import { useState } from "react";
import { PortfolioCommandCenter } from "../components/PortfolioCommandCenter";
import { MorphoBenchmarkPanel } from "../components/insights/MorphoBenchmarkPanel";
import type { DepositPosition } from "../types/portfolio";
import type { ExecutionEvent, Job, OnchainPositionPayload } from "../lib/api";
import type { MenuKey } from "../lib/menu";

export function CommandCenterPage({
  positions,
  onchainPositions = [],
  recentJobs,
  recentEvents,
  onGo,
  onOpenJob,
  onCancelJob
}: {
  positions: DepositPosition[];
  onchainPositions?: OnchainPositionPayload[];
  recentJobs: Job[];
  recentEvents: ExecutionEvent[];
  onGo: (menu: MenuKey) => void;
  onOpenJob: (jobId: string) => void;
  onCancelJob: (jobId: string) => void | Promise<void>;
}) {
  const [showPendingJobs, setShowPendingJobs] = useState(false);
  const pendingJobRows = recentJobs.filter((job) => job.status === "queued" || job.status === "blocked");
  const pendingJobs = pendingJobRows.length;
  const failedEvents = recentEvents.filter((event) => event.status === "failed").length;
  const executedJobs = recentJobs.filter((job) => job.status === "executed").length;

  return (
    <div className="page-shell command-page-shell">
      <section className="mission-hero card">
        <div>
          <p className="section-eyebrow">Dashboard</p>
          <h1>DeFi 자금 운용 상황판</h1>
          <p>
            예치, 리스크, 실행, 운영 로그를 한 화면에서 판단합니다. 상품 탐색보다 먼저 현재 포트폴리오가 안전한지와 오늘 조치할 항목을 보여줍니다.
          </p>
        </div>
        <div className="mission-action-stack">
          <button onClick={() => onGo("products")} title="Pools에서 상품을 선택하고 입금 금액을 조정합니다.">전략 검토</button>
          <button className="ghost-btn" onClick={() => onGo("execution")} title="입금 처리와 운영 이력을 확인합니다.">실행 보드</button>
        </div>
      </section>
      <div className="ops-status-rail">
        <button type="button" onClick={() => onGo("portfolio")} title="현재 포지션 상세 화면으로 이동합니다.">
          <span>Positions</span>
          <strong>{positions.length}</strong>
        </button>
        <button type="button" onClick={() => setShowPendingJobs((prev) => !prev)} title="대기 중인 Job 목록을 펼치고 필요 시 취소합니다.">
          <span>Pending Jobs</span>
          <strong>{pendingJobs}</strong>
        </button>
        <button type="button" onClick={() => onGo("operationsLog")} title="실패 이벤트 상세 운영 이력으로 이동합니다.">
          <span>Failures</span>
          <strong>{failedEvents}</strong>
        </button>
        <button type="button" onClick={() => onGo("execution")} title="실행 완료된 Job은 Execution 화면에서 운영 로그와 함께 확인합니다.">
          <span>Executed</span>
          <strong>{executedJobs}</strong>
        </button>
      </div>
      {showPendingJobs ? (
        <section className="card pending-jobs-panel">
          <div className="pending-jobs-head">
            <div>
              <p className="section-eyebrow">Pending Jobs</p>
              <h2>대기 중인 입금 작업</h2>
            </div>
            <button type="button" className="ghost-btn" onClick={() => onGo("execution")} title="Execution 화면에서 선택한 Job의 입금 처리를 이어갑니다.">
              실행 화면으로
            </button>
          </div>
          <div className="pending-jobs-list">
            {pendingJobRows.map((job) => (
              <div key={job.id} className="pending-job-row">
                <button type="button" onClick={() => onOpenJob(job.id)} title="이 Job을 Execution 화면에서 엽니다.">
                  <strong>Job {job.id.slice(-8)}</strong>
                  <span>{job.status} · ${job.input.depositUsd.toLocaleString()} · {job.riskLevel}</span>
                </button>
                <button type="button" className="ghost-btn pending-job-cancel" onClick={() => void onCancelJob(job.id)} title="아직 실행되지 않은 Job을 취소합니다.">
                  취소
                </button>
              </div>
            ))}
            {pendingJobRows.length === 0 ? <p className="recent-empty">대기 중인 Job이 없습니다.</p> : null}
          </div>
        </section>
      ) : null}
      <PortfolioCommandCenter positions={positions} onchainPositions={onchainPositions} onOpenExecution={() => onGo("execution")} />
      <div style={{ marginTop: 16 }}>
        <MorphoBenchmarkPanel />
      </div>
    </div>
  );
}
