import { useState } from "react";
import { ApprovalsDashboard } from "../ApprovalsDashboard";
import { ExecutionEventsDashboard } from "../ExecutionEventsDashboard";
import { RecentActivityPanel } from "./RecentActivityPanel";
import type { ExecutionEvent, Job } from "../../lib/api";

export function OperationsHistoryPanel({
  focusJobId,
  recentJobs = [],
  recentEvents = [],
  onOpenJob,
  onOpenEvent
}: {
  focusJobId?: string;
  recentJobs?: Job[];
  recentEvents?: ExecutionEvent[];
  onOpenJob?: (jobId: string) => void;
  onOpenEvent?: (jobId: string) => void;
}) {
  const [openSection, setOpenSection] = useState<"approvals" | "events" | "activity" | null>(focusJobId ? "events" : null);

  return (
    <section className="card">
      <h2>운영 이력</h2>
      <p>승인 로그와 실행 이벤트는 필요한 항목만 펼쳐 세부내역을 확인합니다.</p>
      <div className="operations-log-launcher">
        <button
          type="button"
          className={openSection === "approvals" ? "operations-log-card active" : "operations-log-card"}
          onClick={() => setOpenSection((prev) => (prev === "approvals" ? null : "approvals"))}
        >
          <span>Approval Trail</span>
          <strong>승인 로그 세부내역</strong>
          <em>{openSection === "approvals" ? "접기" : "열기"}</em>
        </button>
        <button
          type="button"
          className={openSection === "events" ? "operations-log-card active" : "operations-log-card"}
          onClick={() => setOpenSection((prev) => (prev === "events" ? null : "events"))}
        >
          <span>Execution Events</span>
          <strong>실행 이벤트 세부내역</strong>
          <em>{openSection === "events" ? "접기" : "열기"}</em>
        </button>
        <button
          type="button"
          className={openSection === "activity" ? "operations-log-card active" : "operations-log-card"}
          onClick={() => setOpenSection((prev) => (prev === "activity" ? null : "activity"))}
        >
          <span>Activity Feed</span>
          <strong>최근 활동 피드</strong>
          <em>{openSection === "activity" ? "접기" : "열기"}</em>
        </button>
      </div>
      {openSection === "approvals" ? <ApprovalsDashboard focusJobId={focusJobId} /> : null}
      {openSection === "events" ? <ExecutionEventsDashboard focusJobId={focusJobId} /> : null}
      {openSection === "activity" && onOpenJob && onOpenEvent ? (
        <RecentActivityPanel recentJobs={recentJobs} recentEvents={recentEvents} onOpenJob={onOpenJob} onOpenEvent={onOpenEvent} />
      ) : null}
    </section>
  );
}
