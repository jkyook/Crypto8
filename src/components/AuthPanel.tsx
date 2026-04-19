import { useState } from "react";
import { AddressType } from "@phantom/browser-sdk";
import { useAccounts, useConnect } from "@phantom/react-sdk";
import { clearSession, getSession, login, loginWithWallet, register, type AuthSession } from "../lib/api";

type Props = {
  onSessionChange: (session: AuthSession | null) => void;
};

export function AuthPanel({ onSessionChange }: Props) {
  const { connect } = useConnect();
  const accounts = useAccounts();
  const solanaAccount = accounts?.find((account) => account.addressType === AddressType.solana);
  const [username, setUsername] = useState("orchestrator_admin");
  const [password, setPassword] = useState("orchestrator123");
  const [regUsername, setRegUsername] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regPassword2, setRegPassword2] = useState("");
  const [message, setMessage] = useState("");
  const [loginMode, setLoginMode] = useState<"id" | "wallet">("id");
  const [walletBusy, setWalletBusy] = useState(false);
  const session = getSession();

  const onLogin = async () => {
    try {
      const next = await login(username, password);
      onSessionChange(next);
      setMessage(`로그인 성공: ${next.username} (${next.role})`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "로그인 실패");
    }
  };

  const onRegister = async () => {
    setMessage("");
    if (regPassword !== regPassword2) {
      setMessage("비밀번호 확인이 일치하지 않습니다.");
      return;
    }
    try {
      const next = await register(regUsername, regPassword);
      onSessionChange(next);
      setMessage(`가입 및 로그인 완료: ${next.username} (이용자·viewer)`);
      setRegUsername("");
      setRegPassword("");
      setRegPassword2("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "회원가입 실패");
    }
  };

  const onLogout = async () => {
    await clearSession();
    onSessionChange(null);
    setMessage("로그아웃 완료");
  };

  const onWalletLogin = async () => {
    setWalletBusy(true);
    setMessage("");
    try {
      let addr = solanaAccount?.address;
      if (!addr) {
        await connect({ provider: "phantom" });
        addr = accounts?.find((account) => account.addressType === AddressType.solana)?.address;
      }
      if (!addr && typeof window !== "undefined") {
        addr = (window as { phantom?: { solana?: { publicKey?: { toString?: () => string } } } }).phantom?.solana?.publicKey?.toString?.();
      }
      if (!addr) {
        setMessage("지갑 연결은 완료되었지만 주소를 아직 읽지 못했습니다. 잠시 후 다시 눌러주세요.");
        return;
      }
      const next = await loginWithWallet(addr);
      onSessionChange(next);
      setMessage(`지갑 로그인 완료: ${next.username} (${next.role})`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "지갑 로그인 실패");
    } finally {
      setWalletBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>로그인 · 회원가입</h2>
      <div className="auth-mode-tabs" role="tablist" aria-label="로그인 방식">
        <button type="button" className={loginMode === "id" ? "active" : ""} onClick={() => setLoginMode("id")}>
          아이디 로그인
        </button>
        <button type="button" className={loginMode === "wallet" ? "active" : ""} onClick={() => setLoginMode("wallet")}>
          지갑 연결
        </button>
      </div>
      <p className="product-session-hint">
        <strong>데모:</strong> orchestrator_admin / orchestrator123 · security_admin / security123 · viewer_admin / viewer123 — 예치·승인·실행 API는 세
        역할 모두 사용할 수 있습니다.
      </p>
      <p className="product-session-hint">
        <strong>개별 이용자:</strong> 아래에서 가입하면 <code>viewer</code> 계정으로 예치·인출·예치 실행(Job)이 계정별로 분리됩니다.
      </p>
      {loginMode === "id" ? (
        <>
          <h3 className="kpi-label" style={{ marginTop: "1rem" }}>
            아이디 로그인
          </h3>
          <div className="toggle-grid">
            <label>
              사용자명
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
            </label>
            <label>
              비밀번호
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
            </label>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => void onLogin()}>
              로그인
            </button>
            <button type="button" onClick={() => void onWalletLogin()} disabled={walletBusy}>
              {walletBusy ? "지갑 연결 중..." : "지갑 생성 및 연결"}
            </button>
            <button type="button" onClick={() => void onLogout()}>
              로그아웃
            </button>
          </div>
        </>
      ) : (
        <div className="wallet-auth-box">
          <h3>지갑 연결 로그인</h3>
          <p>Phantom 지갑을 연결하면 별도 아이디 없이 viewer 계정으로 입금 처리를 진행할 수 있습니다.</p>
          <button type="button" onClick={() => void onWalletLogin()} disabled={walletBusy}>
            {walletBusy ? "지갑 로그인 중..." : "지갑 연결로 로그인"}
          </button>
        </div>
      )}

      <h3 className="kpi-label" style={{ marginTop: "1.25rem" }}>
        회원가입 (이용자)
      </h3>
      <div className="toggle-grid">
        <label>
          아이디 (3~64자, 영문·숫자·._-)
          <input value={regUsername} onChange={(e) => setRegUsername(e.target.value)} autoComplete="username" />
        </label>
        <label>
          비밀번호 (8자 이상)
          <input type="password" value={regPassword} onChange={(e) => setRegPassword(e.target.value)} autoComplete="new-password" />
        </label>
        <label>
          비밀번호 확인
          <input type="password" value={regPassword2} onChange={(e) => setRegPassword2(e.target.value)} autoComplete="new-password" />
        </label>
      </div>
      <div className="button-row">
        <button type="button" onClick={() => void onRegister()}>
          가입 후 바로 로그인
        </button>
      </div>

      <p style={{ marginTop: "1rem" }}>현재 세션: {session ? `${session.username} (${session.role})` : "없음"}</p>
      <p>{message || "대기 중"}</p>
    </section>
  );
}
