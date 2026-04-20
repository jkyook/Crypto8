import type { ExecutionEvent, Job } from "../../lib/api";

export function RecentActivityPanel({
  recentJobs,
  recentEvents,
  onOpenJob,
  onOpenEvent
}: {
  recentJobs: Job[];
  recentEvents: ExecutionEvent[];
  onOpenJob: (jobId: string) => void;
  onOpenEvent: (jobId: string) => void;
}) {
  return (
    <section className="card">
      <h2>활동 피드</h2>
      <p>최근 작업/이벤트는 운영 문맥 추적용 보조 정보이며, 긴급 지표는 대시보드에서 우선 확인합니다.</p>
      <div className="activity-grid">
        <div className="activity-column">
          <h3>최근 작업</h3>
          <div className="recent-list">
            {recentJobs.map((job) => (
              <button key={job.id} className="recent-item" onClick={() => onOpenJob(job.id)}>
                <span className="recent-main">Job {job.id.slice(-6)}</span>
                <span className="recent-sub">
                  {job.status} · {new Date(job.createdAt).toLocaleString()}
                </span>
              </button>
            ))}
            {recentJobs.length === 0 ? <p className="recent-empty">최근 작업 없음</p> : null}
          </div>
        </div>
        <div className="activity-column">
          <h3>최근 실행 이벤트</h3>
          <div className="recent-list">
            {recentEvents.map((event) => (
              <button key={event.id} className="recent-item" onClick={() => onOpenEvent(event.jobId)}>
                <span className="recent-main">
                  <span className={`badge badge-${event.status === "accepted" ? "low" : event.status === "skipped" ? "medium" : "high"}`}>
                    {event.status}
                  </span>
                </span>
                <span className="recent-sub">
                  Job {event.jobId.slice(-6)} · {new Date(event.requestedAt).toLocaleString()}
                </span>
              </button>
            ))}
            {recentEvents.length === 0 ? <p className="recent-empty">최근 이벤트 없음</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
