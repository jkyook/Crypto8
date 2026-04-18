import { useMemo, useState } from "react";
import { listApprovals, type ApprovalLog } from "../lib/api";

type Props = {
  focusJobId?: string;
};

export function ApprovalsDashboard({ focusJobId }: Props) {
  const [approvals, setApprovals] = useState<ApprovalLog[]>([]);
  const [decisionFilter, setDecisionFilter] = useState<"all" | ApprovalLog["decision"]>("all");
  const [jobFilter, setJobFilter] = useState("");
  const [message, setMessage] = useState("");

  const filtered = useMemo(() => {
    const targetJob = focusJobId || jobFilter.trim();
    return approvals.filter((item) => {
      const decisionOk = decisionFilter === "all" ? true : item.decision === decisionFilter;
      const jobOk = targetJob ? item.jobId === targetJob : true;
      return decisionOk && jobOk;
    });
  }, [approvals, decisionFilter, jobFilter, focusJobId]);

  const decisionClass = (decision: ApprovalLog["decision"]) => {
    if (decision === "Go") return "badge badge-low";
    if (decision === "Conditional Go") return "badge badge-medium";
    return "badge badge-high";
  };

  const onRefresh = async () => {
    try {
      const data = await listApprovals();
      setApprovals(data);
      setMessage(`승인 로그 ${data.length}건 로드됨`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "조회 실패");
    }
  };

  const isExpiringSoon = (expiresAt: string) => {
    const diffMs = new Date(expiresAt).getTime() - Date.now();
    return diffMs > 0 && diffMs < 60 * 60 * 1000;
  };

  return (
    <section className="card">
      <h2>승인 로그 대시보드</h2>
      <div className="button-row">
        <button onClick={onRefresh}>로그 새로고침</button>
        <input
          placeholder="Job ID 필터"
          value={jobFilter}
          onChange={(event) => setJobFilter(event.target.value)}
        />
        <select value={decisionFilter} onChange={(event) => setDecisionFilter(event.target.value as typeof decisionFilter)}>
          <option value="all">전체</option>
          <option value="Go">Go</option>
          <option value="Conditional Go">Conditional Go</option>
          <option value="No-Go">No-Go</option>
        </select>
      </div>
      <p>{message || "조회 전"}</p>
      <table>
        <thead>
          <tr>
            <th>결정</th>
            <th>Job</th>
            <th>승인자</th>
            <th>만료시각</th>
            <th>경고</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((item) => (
            <tr key={item.id}>
              <td>
                <span className={decisionClass(item.decision)}>{item.decision}</span>
              </td>
              <td>{item.jobId}</td>
              <td>{item.approver}</td>
              <td>{new Date(item.expiresAt).toLocaleString()}</td>
              <td>{isExpiringSoon(item.expiresAt) ? "1시간 이내 만료" : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
