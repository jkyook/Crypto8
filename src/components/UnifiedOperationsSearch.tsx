import { useEffect, useMemo, useState } from "react";
import { listExecutionEvents, listJobs, type ExecutionEvent, type Job } from "../lib/api";

type Props = {
  focusJobId?: string;
  onFocusJob: (jobId: string) => void;
};

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export function UnifiedOperationsSearch({ focusJobId, onFocusJob }: Props) {
  const [query, setQuery] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setMessage("");
    try {
      const [j, e] = await Promise.all([listJobs(), listExecutionEvents()]);
      setJobs(j);
      setEvents(e);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "목록을 불러오지 못했습니다.");
      setJobs([]);
      setEvents([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (focusJobId) {
      setQuery(focusJobId);
    }
  }, [focusJobId]);

  const q = norm(query);
  const filteredJobs = useMemo(() => {
    if (!q) {
      return jobs.slice(0, 40);
    }
    return jobs.filter(
      (job) =>
        norm(job.id).includes(q) ||
        norm(job.status).includes(q) ||
        String(job.input.depositUsd).includes(q) ||
        norm(job.riskLevel).includes(q)
    );
  }, [jobs, q]);

  const filteredEvents = useMemo(() => {
    if (!q) {
      return events.slice(0, 40);
    }
    return events.filter(
      (ev) =>
        norm(ev.id).includes(q) ||
        norm(ev.jobId).includes(q) ||
        norm(ev.status).includes(q) ||
        norm(ev.message).includes(q) ||
        (ev.txId ? norm(ev.txId).includes(q) : false) ||
        (ev.idempotencyKey ? norm(ev.idempotencyKey).includes(q) : false)
    );
  }, [events, q]);

  return (
    <section className="card unified-search-card">
      <div className="unified-search-head">
        <div>
          <h2 id="unified-ops-search-heading" className="unified-search-title">
            통합 검색
          </h2>
          <p className="unified-search-sub">Job·실행 이벤트를 한 곳에서 필터합니다.</p>
        </div>
        <button type="button" className="ghost-btn" onClick={() => void load()} disabled={loading}>
          새로고침
        </button>
      </div>
      <label className="unified-search-label">
        검색어
        <input
          className="unified-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="job id, 상태, 메시지, txId…"
          autoComplete="off"
        />
      </label>
      {message ? <p className="unified-search-msg">{message}</p> : null}
      {loading ? <p className="unified-search-msg">불러오는 중…</p> : null}
      <div className="unified-search-columns">
        <div>
          <h3 className="unified-search-col-title">작업 {q ? `(${filteredJobs.length})` : `(최대 40건)`}</h3>
          <ul className="unified-search-list">
            {filteredJobs.map((job) => (
              <li key={job.id}>
                <button type="button" className="unified-search-hit" onClick={() => onFocusJob(job.id)}>
                  <span className="unified-search-hit-badge">JOB</span>
                  <span className="unified-search-hit-main">{job.id}</span>
                  <span className="unified-search-hit-sub">
                    {job.status} · ${job.input.depositUsd.toFixed(0)} · {job.riskLevel}
                  </span>
                </button>
              </li>
            ))}
            {filteredJobs.length === 0 ? <li className="unified-search-empty">일치하는 작업이 없습니다.</li> : null}
          </ul>
        </div>
        <div>
          <h3 className="unified-search-col-title">실행 이벤트 {q ? `(${filteredEvents.length})` : `(최대 40건)`}</h3>
          <ul className="unified-search-list">
            {filteredEvents.map((ev) => (
              <li key={ev.id}>
                <button type="button" className="unified-search-hit" onClick={() => onFocusJob(ev.jobId)}>
                  <span className="unified-search-hit-badge unified-search-hit-badge--ev">EVT</span>
                  <span className="unified-search-hit-main">{ev.status}</span>
                  <span className="unified-search-hit-sub">
                    {ev.jobId} · {new Date(ev.requestedAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
            {filteredEvents.length === 0 ? <li className="unified-search-empty">일치하는 이벤트가 없습니다.</li> : null}
          </ul>
        </div>
      </div>
    </section>
  );
}
