import { useEffect, useState } from "react";
import { listSelfRegistrations, type SelfRegistrationRow } from "../lib/api";

export function SignupRegistrationsPanel() {
  const [rows, setRows] = useState<SelfRegistrationRow[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void (async () => {
      setMessage("");
      try {
        const data = await listSelfRegistrations();
        setRows(data);
      } catch (err) {
        setRows([]);
        setMessage(err instanceof Error ? err.message : "조회 실패");
      }
    })();
  }, []);

  return (
    <section className="card">
      <h2>회원가입 내역</h2>
      <p className="product-session-hint">
        <strong>운영자(orchestrator) 전용.</strong> 로그인 · 계정에서 직접 가입한 이용자만 나옵니다. 시드 계정(orchestrator_admin 등)은 제외됩니다.
      </p>
      {message ? (
        <p className="kpi-value" role="alert">
          {message}
        </p>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>아이디</th>
            <th>역할</th>
            <th>가입 시각 (UTC)</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !message ? (
            <tr>
              <td colSpan={3}>직접 가입한 계정이 없습니다.</td>
            </tr>
          ) : null}
          {rows.map((row) => (
            <tr key={row.username}>
              <td>{row.username}</td>
              <td>{row.role}</td>
              <td>{row.registeredAt ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
