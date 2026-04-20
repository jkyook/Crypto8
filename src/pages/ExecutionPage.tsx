import { OrchestratorBoard } from "../components/OrchestratorBoard";
import { OperationsHistoryPanel } from "../components/activity/OperationsHistoryPanel";
import type { ExecutionEvent, Job } from "../lib/api";

export function ExecutionPage({
  hasSession,
  recentJobs,
  recentEvents,
  focusJobId,
  onOpenJob,
  onOpenEvent,
  onExecutionComplete
}: {
  hasSession: boolean;
  recentJobs: Job[];
  recentEvents: ExecutionEvent[];
  focusJobId?: string;
  onOpenJob: (jobId: string) => void;
  onOpenEvent: (jobId: string) => void;
  onExecutionComplete?: () => void | Promise<void>;
}) {
  return (
    <div className="page-shell execution-page-shell">
      <section className="mission-hero mission-hero--execution card">
        <div>
          <p className="section-eyebrow">Execution</p>
          <h1>내 입금 실행, 서명, dry-run, 감사 로그를 한 흐름으로 추적합니다</h1>
          <p>
            실행은 계획, 본인 확인, 서명, 제출, 확인, 기록으로 나뉩니다. 실패와 재실행은 운영 이력에서 추적합니다.
          </p>
        </div>
      </section>
      <div className="page-grid-two page-grid-two--execution execution-primary-grid">
        <OrchestratorBoard allowJobExecution={hasSession} onExecutionComplete={onExecutionComplete} />
      </div>
      <OperationsHistoryPanel
        focusJobId={focusJobId}
        recentJobs={recentJobs}
        recentEvents={recentEvents}
        onOpenJob={onOpenJob}
        onOpenEvent={onOpenEvent}
      />
    </div>
  );
}
