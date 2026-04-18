import { Fragment, useEffect, useMemo, useState } from "react";
import { listExecutionEvents, type ExecutionEvent } from "../lib/api";

type Props = {
  focusJobId?: string;
};

export function ExecutionEventsDashboard({ focusJobId }: Props) {
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | ExecutionEvent["status"]>("all");
  const [jobFilter, setJobFilter] = useState("");
  const [message, setMessage] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [openPayloadId, setOpenPayloadId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return events.filter((item) => (statusFilter === "all" ? true : item.status === statusFilter));
  }, [events, statusFilter]);

  const onRefresh = async () => {
    try {
      const target = focusJobId || jobFilter.trim();
      const data = await listExecutionEvents(target || undefined);
      setEvents(data);
      setMessage(`실행 이벤트 ${data.length}건 로드됨`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "조회 실패");
    }
  };

  useEffect(() => {
    void onRefresh();
    // focusJobId 변경 시(운영 이력 딥링크) 목록 재조회
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusJobId]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      void onRefresh();
    }, 15000);
    return () => clearInterval(timer);
  }, [autoRefresh, jobFilter, statusFilter, focusJobId]);

  const statusClass = (status: ExecutionEvent["status"]) => `badge badge-${status === "accepted" ? "low" : status === "skipped" ? "medium" : "high"}`;

  return (
    <section className="card">
      <h2>실행 이벤트 대시보드</h2>
      <div className="toggle-grid">
        <label>
          Job ID 필터
          <input value={jobFilter} onChange={(event) => setJobFilter(event.target.value)} />
        </label>
        <label>
          상태 필터
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="all">전체</option>
            <option value="accepted">accepted</option>
            <option value="skipped">skipped</option>
            <option value="blocked">blocked</option>
            <option value="failed">failed</option>
          </select>
        </label>
      </div>
      <div className="button-row">
        <button onClick={onRefresh}>이벤트 새로고침</button>
        <button onClick={() => setAutoRefresh((prev) => !prev)}>{autoRefresh ? "자동 새로고침 ON" : "자동 새로고침 OFF"}</button>
      </div>
      <p>{message || "조회 전"}</p>
      <table className="execution-events-table">
        <thead>
          <tr>
            <th>시간</th>
            <th>상태</th>
            <th>Job</th>
            <th>메시지</th>
            <th>Idempotency</th>
            <th>txId</th>
            <th>페이로드</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((item) => (
            <Fragment key={item.id}>
              <tr>
                <td>{new Date(item.requestedAt).toLocaleString()}</td>
                <td>
                  <span className={statusClass(item.status)}>{item.status}</span>
                </td>
                <td>
                  <code className="table-mono">{item.jobId}</code>
                </td>
                <td>{item.message}</td>
                <td>{item.idempotencyKey ?? "—"}</td>
                <td>
                  {item.txId ? <code className="table-mono table-mono--sm">{item.txId}</code> : "—"}
                </td>
                <td>
                  {item.payload ? (
                    <button type="button" className="ghost-btn" onClick={() => setOpenPayloadId((prev) => (prev === item.id ? null : item.id))}>
                      {openPayloadId === item.id ? "닫기" : "JSON"}
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
              {openPayloadId === item.id && item.payload ? (
                <tr key={`${item.id}-payload`} className="execution-event-payload-row">
                  <td colSpan={7}>
                    <pre className="execution-event-payload-pre">{JSON.stringify(item.payload, null, 2)}</pre>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}
