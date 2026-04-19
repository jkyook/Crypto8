import { useState } from "react";
import { AddressType } from "@phantom/browser-sdk";
import { useAccounts, useConnect } from "@phantom/react-sdk";
import { clearSession, getSession, login, loginWithWallet, register, type AuthSession } from "../lib/api";

type Props = {
  onSessionChange: (session: AuthSession | null) => void;
};

type MainTab = "login" | "signup";
type LoginMode = "id" | "wallet";

export function AuthPanel({ onSessionChange }: Props) {
  const { connect } = useConnect();
  const accounts = useAccounts();
  const solanaAccount = accounts?.find((account) => account.addressType === AddressType.solana);

  const [mainTab, setMainTab] = useState<MainTab>("login");
  const [loginMode, setLoginMode] = useState<LoginMode>("id");

  // 로그인 폼
  const [username, setUsername] = useState("orchestrator_admin");
  const [password, setPassword] = useState("orchestrator123");

  // 회원가입 폼
  const [regUsername, setRegUsername] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regPassword2, setRegPassword2] = useState("");

  const [message, setMessage] = useState<{ type: "ok" | "err" | "info"; text: string } | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const session = getSession();

  const showMsg = (type: "ok" | "err" | "info", text: string) => setMessage({ type, text });

  // ── 로그인 ──────────────────────────────────────────
  const onLogin = async () => {
    setMessage(null);
    setLoading(true);
    try {
      const next = await login(username, password);
      onSessionChange(next);
      showMsg("ok", `로그인 완료 — ${next.username} (${next.role})`);
    } catch (error) {
      showMsg("err", error instanceof Error ? error.message : "로그인 실패");
    } finally {
      setLoading(false);
    }
  };

  // ── 지갑 로그인 ────────────────────────────────────
  const onWalletLogin = async () => {
    setWalletBusy(true);
    setMessage(null);
    try {
      let addr = solanaAccount?.address;
      if (!addr) {
        await connect({ provider: "phantom" });
        addr = accounts?.find((a) => a.addressType === AddressType.solana)?.address;
      }
      if (!addr && typeof window !== "undefined") {
        addr = (window as { phantom?: { solana?: { publicKey?: { toString?: () => string } } } })
          .phantom?.solana?.publicKey?.toString?.();
      }
      if (!addr) {
        showMsg("info", "지갑 연결은 됐지만 주소를 아직 읽지 못했습니다. 잠시 후 다시 눌러 주세요.");
        return;
      }
      const next = await loginWithWallet(addr);
      onSessionChange(next);
      showMsg("ok", `지갑 로그인 완료 — ${next.username} (${next.role})`);
    } catch (error) {
      showMsg("err", error instanceof Error ? error.message : "지갑 로그인 실패");
    } finally {
      setWalletBusy(false);
    }
  };

  // ── 로그아웃 ───────────────────────────────────────
  const onLogout = async () => {
    await clearSession();
    onSessionChange(null);
    showMsg("info", "로그아웃 완료");
  };

  // ── 회원가입 ───────────────────────────────────────
  const onRegister = async () => {
    setMessage(null);
    if (regPassword !== regPassword2) {
      showMsg("err", "비밀번호 확인이 일치하지 않습니다.");
      return;
    }
    setLoading(true);
    try {
      const next = await register(regUsername, regPassword);
      onSessionChange(next);
      showMsg("ok", `가입 및 로그인 완료 — ${next.username} (viewer)`);
      setRegUsername("");
      setRegPassword("");
      setRegPassword2("");
    } catch (error) {
      showMsg("err", error instanceof Error ? error.message : "회원가입 실패");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="card auth-panel-card">
      {/* ── 현재 세션 배너 ── */}
      {session ? (
        <div className="auth-session-banner">
          <span>
            <strong>{session.username}</strong>
            <em className={`auth-role-badge auth-role-badge--${session.role}`}>{session.role}</em>
            으로 로그인됨
          </span>
          <button type="button" className="auth-logout-btn" onClick={() => void onLogout()}>
            로그아웃
          </button>
        </div>
      ) : (
        <p className="auth-no-session">현재 세션 없음</p>
      )}

      {/* ── 메인 탭: 로그인 | 회원가입 ── */}
      <div className="auth-main-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mainTab === "login"}
          className={mainTab === "login" ? "auth-tab active" : "auth-tab"}
          onClick={() => { setMainTab("login"); setMessage(null); }}
        >
          로그인
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mainTab === "signup"}
          className={mainTab === "signup" ? "auth-tab active" : "auth-tab"}
          onClick={() => { setMainTab("signup"); setMessage(null); }}
        >
          회원가입
        </button>
      </div>

      {/* ══════════ 로그인 탭 ══════════ */}
      {mainTab === "login" && (
        <div className="auth-tab-body">
          {/* 로그인 방식 서브 토글 */}
          <div className="auth-sub-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={loginMode === "id"}
              className={loginMode === "id" ? "auth-sub-tab active" : "auth-sub-tab"}
              onClick={() => { setLoginMode("id"); setMessage(null); }}
            >
              아이디
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={loginMode === "wallet"}
              className={loginMode === "wallet" ? "auth-sub-tab active" : "auth-sub-tab"}
              onClick={() => { setLoginMode("wallet"); setMessage(null); }}
            >
              지갑 (Phantom)
            </button>
          </div>

          {loginMode === "id" ? (
            <>
              <div className="auth-field-group">
                <label className="auth-label">
                  사용자명
                  <input
                    className="auth-input"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    onKeyDown={(e) => e.key === "Enter" && void onLogin()}
                  />
                </label>
                <label className="auth-label">
                  비밀번호
                  <input
                    className="auth-input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    onKeyDown={(e) => e.key === "Enter" && void onLogin()}
                  />
                </label>
              </div>
              <button
                type="button"
                className="auth-primary-btn"
                onClick={() => void onLogin()}
                disabled={loading}
              >
                {loading ? "로그인 중…" : "로그인"}
              </button>

              {/* 데모 계정 힌트 (접혀 있는 형태) */}
              <details className="auth-demo-hint">
                <summary>데모 계정 보기</summary>
                <div className="auth-demo-list">
                  {[
                    ["orchestrator_admin", "orchestrator123", "orchestrator"],
                    ["security_admin", "security123", "security"],
                    ["viewer_admin", "viewer123", "viewer"],
                  ].map(([u, p, r]) => (
                    <button
                      key={u}
                      type="button"
                      className="auth-demo-row"
                      onClick={() => { setUsername(u); setPassword(p); setMessage(null); }}
                    >
                      <code>{u}</code>
                      <span className={`auth-role-badge auth-role-badge--${r}`}>{r}</span>
                    </button>
                  ))}
                </div>
              </details>
            </>
          ) : (
            <div className="auth-wallet-box">
              <p className="auth-wallet-desc">
                Phantom 지갑을 연결하면 별도 아이디 없이 <em>viewer</em> 계정으로 예치 처리가 가능합니다.
              </p>
              <button
                type="button"
                className="auth-primary-btn"
                onClick={() => void onWalletLogin()}
                disabled={walletBusy}
              >
                {walletBusy ? "연결 중…" : "Phantom으로 로그인"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ══════════ 회원가입 탭 ══════════ */}
      {mainTab === "signup" && (
        <div className="auth-tab-body">
          <p className="auth-signup-hint">
            가입 시 <em>viewer</em> 계정이 생성됩니다. 예치·인출·실행 Job이 계정별로 분리 저장됩니다.
          </p>
          <div className="auth-field-group">
            <label className="auth-label">
              아이디 <span className="auth-field-note">(3~64자, 영문·숫자·._-)</span>
              <input
                className="auth-input"
                value={regUsername}
                onChange={(e) => setRegUsername(e.target.value)}
                autoComplete="username"
              />
            </label>
            <label className="auth-label">
              비밀번호 <span className="auth-field-note">(8자 이상)</span>
              <input
                className="auth-input"
                type="password"
                value={regPassword}
                onChange={(e) => setRegPassword(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <label className="auth-label">
              비밀번호 확인
              <input
                className="auth-input"
                type="password"
                value={regPassword2}
                onChange={(e) => setRegPassword2(e.target.value)}
                autoComplete="new-password"
                onKeyDown={(e) => e.key === "Enter" && void onRegister()}
              />
            </label>
          </div>
          <button
            type="button"
            className="auth-primary-btn"
            onClick={() => void onRegister()}
            disabled={loading}
          >
            {loading ? "가입 중…" : "가입 후 바로 로그인"}
          </button>
        </div>
      )}

      {/* ── 피드백 메시지 ── */}
      {message && (
        <p
          className={
            message.type === "ok"
              ? "auth-message auth-message--ok"
              : message.type === "err"
              ? "auth-message auth-message--err"
              : "auth-message auth-message--info"
          }
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
