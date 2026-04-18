import { useState } from "react";
import { clearSession, getSession, login, type AuthSession } from "../lib/api";

type Props = {
  onSessionChange: (session: AuthSession | null) => void;
};

export function AuthPanel({ onSessionChange }: Props) {
  const [username, setUsername] = useState("orchestrator_admin");
  const [password, setPassword] = useState("orchestrator123");
  const [message, setMessage] = useState("");
  const session = getSession();

  const onLogin = async () => {
    try {
      const next = await login(username, password);
      onSessionChange(next);
      setMessage(`로그인 성공: ${next.role}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "로그인 실패");
    }
  };

  const onLogout = async () => {
    await clearSession();
    onSessionChange(null);
    setMessage("로그아웃 완료");
  };

  return (
    <section className="card">
      <h2>운영자 로그인 (JWT)</h2>
      <p>역할별 계정: orchestrator_admin / security_admin / viewer_admin</p>
      <div className="toggle-grid">
        <label>
          사용자명
          <input value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label>
          비밀번호
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
      </div>
      <div className="button-row">
        <button onClick={onLogin}>로그인</button>
        <button onClick={onLogout}>로그아웃</button>
      </div>
      <p>현재 세션: {session ? `${session.username} (${session.role})` : "없음"}</p>
      <p>{message || "대기 중"}</p>
    </section>
  );
}
