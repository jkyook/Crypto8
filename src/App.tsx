import { useEffect, useMemo, useState } from "react";
import { usePhantom } from "@phantom/react-sdk";
import { AuthPanel } from "./components/AuthPanel";
import { SignupRegistrationsPanel } from "./components/SignupRegistrationsPanel";
import { UnifiedOperationsSearch } from "./components/UnifiedOperationsSearch";
import { WalletPanel, type WalletWithdrawLedgerLine } from "./components/WalletPanel";
import { ProductsPanel } from "./components/ProductsPanel";
import { PortfolioPanel } from "./components/PortfolioPanel";
import { AgentConsensusPanel } from "./components/insights/AgentConsensusPanel";
import { ConsultantInsightsPanel } from "./components/insights/ConsultantInsightsPanel";
import { RecentActivityPanel } from "./components/activity/RecentActivityPanel";
import { OperationsHistoryPanel } from "./components/activity/OperationsHistoryPanel";
import { TradePanel } from "./components/common/TradePanel";
import { CommandCenterPage } from "./pages/CommandCenterPage";
import { ExecutionPage } from "./pages/ExecutionPage";
import { StrategiesPage } from "./pages/StrategiesPage";
import { PositionsPage } from "./pages/PositionsPage";
import {
  AUTH_CLEARED_EVENT,
  cancelJob,
  getSession,
  getWhitepaperPdfUrl,
  listDepositPositions,
  listExecutionEvents,
  listJobs,
  listWithdrawalLedger,
  resetPortfolioLedgerRemote,
  withdrawProtocolExposureRemote,
  withdrawProductDepositRemote,
  withdrawDepositRemote,
  type AuthSession,
  type ExecutionEvent,
  type Job
} from "./lib/api";
import { getNextQuarterStart } from "./lib/quarterSchedule";
import { getMainnetLivePreference, setMainnetLivePreference } from "./lib/mainnetLivePreference";
import { setSolanaNetworkPreference } from "./lib/solanaNetworkPreference";
import { applyLifoWithdraw, applyTargetedWithdraw, applyProductWithdraw } from "./lib/withdrawStrategies";
import type { MenuKey, MenuItem } from "./lib/menu";
import type { DepositPosition, ProtocolDetailRow } from "./types/portfolio";


const GUEST_WITHDRAW_LEDGER_KEY = "crypto8_withdraw___guest__";

const PRIMARY_NAV_ORDER: MenuKey[] = ["my", "products", "portfolio", "execution"];
const PRIMARY_NAV_LABEL: Partial<Record<MenuKey, string>> = {
  my: "Dashboard",
  products: "Pools",
  portfolio: "Positions",
  execution: "Execution",
  trade: "Swap"
};

const MENU_ITEMS: MenuItem[] = [
  { key: "my", label: "내 현황", icon: "🙋", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "products", label: "예치상품", icon: "🧺", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "trade", label: "Trade", icon: "🔄", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "portfolio", label: "Portfolio", icon: "📊", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "wallet", label: "지갑/자산", icon: "👛", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "execution", label: "예치 실행", icon: "🧭", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "operationsLog", label: "수익/운영 이력", icon: "📜", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "activity", label: "활동 피드", icon: "🕘", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "consultant", label: "컨설턴트 인사이트", icon: "🧠", group: "governance", roles: ["orchestrator", "security"] },
  { key: "signupHistory", label: "회원가입 내역", icon: "📋", group: "governance", roles: ["orchestrator"] },
  { key: "auth", label: "로그인 · 계정", icon: "🔐", group: "governance", roles: ["orchestrator", "security", "viewer"] },
  { key: "consensus", label: "에이전트 합의", icon: "🤝", group: "governance", roles: ["orchestrator", "security", "viewer"] }
];
type TopNavGroupKey = "more";

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(getSession());
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [mainnetLiveEnabled, setMainnetLiveEnabled] = useState<boolean>(() => getMainnetLivePreference());
  const [activeMenu, setActiveMenu] = useState<MenuKey>("my");
  const [openTopMenu, setOpenTopMenu] = useState<TopNavGroupKey | null>(null);
  const [recentJobs, setRecentJobs] = useState<Job[]>([]);
  const [recentEvents, setRecentEvents] = useState<ExecutionEvent[]>([]);
  const [withdrawLedger, setWithdrawLedger] = useState<WalletWithdrawLedgerLine[]>([]);
  const [focusJobId, setFocusJobId] = useState<string | undefined>(undefined);
  const [operationsSearchOpen, setOperationsSearchOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [quarterAlertSeen, setQuarterAlertSeen] = useState(false);
  const [positions, setPositions] = useState<DepositPosition[]>([]);
  const [portfolioNotice, setPortfolioNotice] = useState<{ variant: "error" | "info"; text: string } | null>(null);
  const role = session?.role;

  /** 지갑 연결 여부 — 지갑이 연결된 경우에만 입금·인출·실행 권한 부여 */
  const { isConnected: isWalletConnected } = usePhantom();

  /**
   * canPersistPortfolio: 서버에 쓰기 작업(입금·인출·Job생성·실행)을 할 수 있는지 여부.
   * - 지갑 로그인(loginType === "wallet"): 서명으로 지갑 소유를 이미 증명했으므로 isWalletConnected 체크 불필요.
   * - 아이디/비밀번호 로그인: 읽기 조회는 가능하지만 자산 변동은 지갑 별도 연결 필요.
   */
  const canPersistPortfolio = Boolean(session) && (session?.loginType === "wallet" || isWalletConnected);
  /** hasSession: 세션 존재 여부(로그인 방식 무관) — 읽기 조회용 */
  const hasSession = Boolean(session);
  const portfolioTotalUsd = useMemo(() => positions.reduce((acc, p) => acc + p.amountUsd, 0), [positions]);

  const refreshWithdrawLedgerFromServer = async () => {
    if (!session) {
      return;
    }
    try {
      const rows = await listWithdrawalLedger();
      setWithdrawLedger(rows);
    } catch {
      setWithdrawLedger([]);
    }
  };

  const refreshPositions = async () => {
    if (!session) {
      return;
    }
    try {
      const rows = await listDepositPositions();
      setPositions(rows);
    } catch {
      setPositions([]);
    }
  };

  const handleWithdrawPosition = async (amountUsd: number) => {
    if (amountUsd <= 0) return;
    setPortfolioNotice(null);
    try {
      if (canPersistPortfolio) {
        const { withdrawnUsd } = await withdrawDepositRemote(amountUsd);
        await refreshPositions();
        await refreshWithdrawLedgerFromServer();
        if (withdrawnUsd <= 0 && amountUsd > 0) {
          setPortfolioNotice({ variant: "info", text: "인출할 예치 잔액이 없습니다." });
        } else if (withdrawnUsd < amountUsd) {
          setPortfolioNotice({
            variant: "info",
            text: `요청 ${amountUsd.toLocaleString("ko-KR")} USD 중 실제 반영 ${withdrawnUsd.toFixed(2)} USD입니다.`
          });
        }
      } else {
        setPositions((prev) => applyLifoWithdraw(prev, amountUsd));
        setWithdrawLedger((prev) => {
          const next = [{ id: `wd_${Date.now()}`, amountUsd, createdAt: new Date().toISOString() }, ...prev];
          try {
            localStorage.setItem(GUEST_WITHDRAW_LEDGER_KEY, JSON.stringify(next));
          } catch {
            /* 저장 실패 무시 */
          }
          return next;
        });
      }
    } catch (err) {
      setPortfolioNotice({
        variant: "error",
        text: err instanceof Error ? err.message : "인출에 실패했습니다."
      });
    }
  };

  const handleWithdrawProtocolExposure = async (
    amountUsd: number,
    target: Pick<ProtocolDetailRow, "name" | "chain" | "pool">
  ) => {
    if (amountUsd <= 0) return;
    setPortfolioNotice(null);
    try {
      if (canPersistPortfolio) {
        const { withdrawnUsd } = await withdrawProtocolExposureRemote({
          amountUsd,
          protocol: target.name,
          chain: target.chain,
          pool: target.pool
        });
        await refreshPositions();
        await refreshWithdrawLedgerFromServer();
        if (withdrawnUsd <= 0 && amountUsd > 0) {
          setPortfolioNotice({ variant: "info", text: "해당 풀에서 인출할 예치 잔액이 없습니다." });
        } else if (withdrawnUsd < amountUsd) {
          setPortfolioNotice({
            variant: "info",
            text: `요청 ${amountUsd.toLocaleString("ko-KR")} USD 중 해당 풀에서 실제 반영 ${withdrawnUsd.toFixed(2)} USD입니다.`
          });
        }
      } else {
        setPositions((prev) => applyTargetedWithdraw(prev, amountUsd, target));
        setWithdrawLedger((prev) => {
          const next = [{ id: `wd_${Date.now()}`, amountUsd, createdAt: new Date().toISOString() }, ...prev];
          try {
            localStorage.setItem(GUEST_WITHDRAW_LEDGER_KEY, JSON.stringify(next));
          } catch {
            /* 저장 실패 무시 */
          }
          return next;
        });
      }
    } catch (err) {
      setPortfolioNotice({
        variant: "error",
        text: err instanceof Error ? err.message : "풀별 인출에 실패했습니다."
      });
    }
  };

  const handleWithdrawProductDeposit = async (amountUsd: number, productName: string) => {
    if (amountUsd <= 0) return;
    setPortfolioNotice(null);
    try {
      if (canPersistPortfolio) {
        const { withdrawnUsd } = await withdrawProductDepositRemote({ amountUsd, productName });
        await refreshPositions();
        await refreshWithdrawLedgerFromServer();
        if (withdrawnUsd <= 0 && amountUsd > 0) {
          setPortfolioNotice({ variant: "info", text: "선택 상품으로 인출할 예치 잔액이 없습니다." });
        } else if (withdrawnUsd < amountUsd) {
          setPortfolioNotice({
            variant: "info",
            text: `요청 ${amountUsd.toLocaleString("ko-KR")} USD 중 ${productName}에서 실제 반영 ${withdrawnUsd.toFixed(2)} USD입니다.`
          });
        }
      } else {
        setPositions((prev) => applyProductWithdraw(prev, amountUsd, productName));
        setWithdrawLedger((prev) => {
          const next = [{ id: `wd_${Date.now()}`, amountUsd, createdAt: new Date().toISOString() }, ...prev];
          try {
            localStorage.setItem(GUEST_WITHDRAW_LEDGER_KEY, JSON.stringify(next));
          } catch {
            /* 저장 실패 무시 */
          }
          return next;
        });
      }
    } catch (err) {
      setPortfolioNotice({
        variant: "error",
        text: err instanceof Error ? err.message : "상품별 인출에 실패했습니다."
      });
    }
  };

  const handleResetPortfolioLedger = async () => {
    if (!session) {
      throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
    }
    const { deletedPositions, deletedWithdrawals } = await resetPortfolioLedgerRemote();
    await refreshPositions();
    await refreshWithdrawLedgerFromServer();
    setPortfolioNotice({
      variant: "info",
      text: `장부를 초기화했습니다. 예치 ${deletedPositions}건 / 인출 ${deletedWithdrawals}건을 삭제했고 실제 온체인 포지션은 유지했습니다.`
    });
  };

  const handleCancelJob = async (jobId: string) => {
    setPortfolioNotice(null);
    const before = recentJobs;
    setRecentJobs((prev) => prev.map((job) => (job.id === jobId ? { ...job, status: "cancelled" } : job)));
    try {
      const cancelled = await cancelJob(jobId);
      const jobs = await listJobs();
      setRecentJobs(jobs.length > 0 ? jobs.slice(0, 6) : before.map((job) => (job.id === jobId ? cancelled : job)));
      setPortfolioNotice({ variant: "info", text: `Job ${jobId.slice(-8)} 취소 완료` });
    } catch (error) {
      setRecentJobs(before);
      setPortfolioNotice({
        variant: "error",
        text: error instanceof Error ? error.message : "Job 취소에 실패했습니다."
      });
    }
  };

  /** 비로그인(GitHub Pages 등)에서도 예치·트레이드·포트폴리오 등 뷰어 권한 메뉴를 노출 (API는 로그인 후) */
  const availableMenus = useMemo(
    () =>
      MENU_ITEMS.filter((item) => {
        if (role) return item.roles.includes(role);
        return item.roles.includes("viewer");
      }),
    [role]
  );

  useEffect(() => {
    document.body.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    const sync = () => setMainnetLiveEnabled(getMainnetLivePreference());
    if (typeof window !== "undefined") {
      window.addEventListener("storage", sync);
    }
    sync();
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("storage", sync);
      }
    };
  }, []);

  useEffect(() => {
    const onAuthCleared = (): void => {
      setSession(null);
    };
    window.addEventListener(AUTH_CLEARED_EVENT, onAuthCleared);
    return () => window.removeEventListener(AUTH_CLEARED_EVENT, onAuthCleared);
  }, []);

  useEffect(() => {
    if (!portfolioNotice) {
      return;
    }
    const timer = window.setTimeout(() => setPortfolioNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [portfolioNotice]);

  useEffect(() => {
    const controller = new AbortController();
    const loadRecent = async () => {
      if (!session) {
        setRecentJobs([]);
        setRecentEvents([]);
        setPositions([]);
        try {
          const raw = localStorage.getItem(GUEST_WITHDRAW_LEDGER_KEY);
          setWithdrawLedger(raw ? (JSON.parse(raw) as WalletWithdrawLedgerLine[]) : []);
        } catch {
          setWithdrawLedger([]);
        }
        return;
      }
      const signal = controller.signal;
      const [jobsResult, eventsResult, depositRowsResult, wdRowsResult] = await Promise.allSettled([
        listJobs({ signal }),
        listExecutionEvents(undefined, { signal }),
        listDepositPositions({ signal }),
        listWithdrawalLedger({ signal })
      ]);
      if (signal.aborted) {
        return;
      }
      setRecentJobs(jobsResult.status === "fulfilled" ? jobsResult.value.slice(0, 6) : []);
      setRecentEvents(eventsResult.status === "fulfilled" ? eventsResult.value.slice(0, 6) : []);
      setPositions(depositRowsResult.status === "fulfilled" ? depositRowsResult.value : []);
      setWithdrawLedger(wdRowsResult.status === "fulfilled" ? wdRowsResult.value : []);
    };
    void loadRecent();
    return () => controller.abort();
  }, [session]);

  useEffect(() => {
    const allowed = availableMenus.some((item) => item.key === activeMenu);
    if (!allowed) {
      setActiveMenu(role ? "my" : "products");
    }
  }, [role, activeMenu, availableMenus]);

  const renderContent = () => {
      switch (activeMenu) {
      case "signupHistory":
        return <SignupRegistrationsPanel />;
      case "auth":
        return <AuthPanel />;
      case "my":
        return (
          <CommandCenterPage
            positions={positions}
            recentJobs={recentJobs}
            recentEvents={recentEvents}
            onGo={onSelectMenu}
            onOpenJob={(jobId) => {
              setFocusJobId(jobId);
              setActiveMenu("execution");
            }}
            onCancelJob={handleCancelJob}
          />
        );
      case "products":
        return (
          <StrategiesPage onOpenTrade={() => onSelectMenu("trade")} onOpenPortfolio={() => onSelectMenu("portfolio")}>
            <ProductsPanel
              positions={positions}
              hasSession={Boolean(session)}
              canPersistToServer={canPersistPortfolio}
              isWalletConnected={isWalletConnected}
              onWithdraw={handleWithdrawPosition}
              onWithdrawProduct={handleWithdrawProductDeposit}
              onActionNotice={setPortfolioNotice}
              onOpenOperationsWithJob={(jobId) => {
                setFocusJobId(jobId);
                setActiveMenu("execution");
                setOpenTopMenu(null);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              onExecutionComplete={async () => {
                await refreshPositions();
                await refreshWithdrawLedgerFromServer();
              }}
            />
          </StrategiesPage>
        );
      case "trade":
        return <TradePanel />;
      case "portfolio":
        return (
          <PositionsPage onGo={onSelectMenu}>
            <PortfolioPanel
              positions={positions}
              onWithdraw={handleWithdrawPosition}
              onWithdrawTarget={handleWithdrawProtocolExposure}
              canPersistToServer={canPersistPortfolio}
              hasSession={hasSession}
              onResetLedger={handleResetPortfolioLedger}
              hasLedgerEntries={withdrawLedger.length > 0}
              onExecutionComplete={async () => {
                await refreshPositions();
                await refreshWithdrawLedgerFromServer();
              }}
            />
          </PositionsPage>
        );
      case "wallet":
        return (
          <WalletPanel
            positions={positions}
            withdrawLedger={withdrawLedger}
            portfolioUsd={portfolioTotalUsd}
            onSessionChange={setSession}
            onOpenAuth={() => onSelectMenu("auth")}
            onOpenMyOverview={() => onSelectMenu("my")}
            onOpenPortfolio={() => onSelectMenu("portfolio")}
            onOpenActivity={() => onSelectMenu("activity")}
          />
        );
      case "execution":
        return (
          <ExecutionPage
            hasSession={Boolean(session)}
            recentJobs={recentJobs}
            recentEvents={recentEvents}
            focusJobId={focusJobId}
            onOpenJob={(jobId) => {
              setFocusJobId(jobId);
            }}
            onOpenEvent={(jobId) => {
              setFocusJobId(jobId);
            }}
            onExecutionComplete={async () => {
              await refreshPositions();
              await refreshWithdrawLedgerFromServer();
            }}
          />
        );
      case "operationsLog":
        return <OperationsHistoryPanel focusJobId={focusJobId} />;
      case "activity":
        return (
          <RecentActivityPanel
            recentJobs={recentJobs}
            recentEvents={recentEvents}
            onOpenJob={(jobId) => {
              setFocusJobId(jobId);
              setActiveMenu("execution");
            }}
            onOpenEvent={(jobId) => {
              setFocusJobId(jobId);
              setActiveMenu("operationsLog");
            }}
          />
        );
      case "consensus":
        return <AgentConsensusPanel />;
      case "consultant":
        return <ConsultantInsightsPanel />;
      default:
        return (
          <CommandCenterPage
            positions={positions}
            recentJobs={recentJobs}
            recentEvents={recentEvents}
            onGo={onSelectMenu}
            onOpenJob={(jobId) => setFocusJobId(jobId)}
            onCancelJob={handleCancelJob}
          />
        );
    }
  };

  const onSelectMenu = (menu: MenuKey) => {
    setActiveMenu(menu);
    setOpenTopMenu(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /** 상단 주요 메뉴: Dashboard · Pools · Positions · Execution (역할에 없는 항목은 숨김) */
  const mainMenuKeys: MenuKey[] = [...PRIMARY_NAV_ORDER];
  const operatorMenuKeys: MenuKey[] = ["signupHistory", "consultant", "consensus"];
  const historyMenuKeys: MenuKey[] = ["activity", "trade"];
  /** More에 넣지 않음: 지갑·운영 이력은 다른 진입점(헤더/검색/딥링크)으로도 이동 가능 */
  const hiddenFromMoreKeys: MenuKey[] = ["wallet", "operationsLog", "auth"];
  const operatorMenus = availableMenus.filter((item) => operatorMenuKeys.includes(item.key));
  const moreMenus = availableMenus.filter(
    (item) =>
      !mainMenuKeys.includes(item.key) &&
      !operatorMenuKeys.includes(item.key) &&
      !historyMenuKeys.includes(item.key) &&
      !hiddenFromMoreKeys.includes(item.key)
  );

  const nextQuarter = getNextQuarterStart();
  const nextQuarterLabel = nextQuarter.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
  const hasQuarterAlert = Boolean(session);
  const hasUnreadAlerts = hasQuarterAlert && !quarterAlertSeen;

  const primaryNavKeys = PRIMARY_NAV_ORDER.filter((k) => availableMenus.some((m) => m.key === k));

  return (
    <main className="container">
      <header className="top-header card">
        <div className="brand-block">
          <div className="brand-title">Crypto8</div>
          <div className="brand-subtitle">Yield Console</div>
        </div>
        <nav className="top-nav">
          {primaryNavKeys.map((key) => (
            <button
              key={key}
              type="button"
              className={activeMenu === key ? "top-nav-trigger nav-item active" : "top-nav-trigger nav-item"}
              onClick={() => onSelectMenu(key)}
            >
              {PRIMARY_NAV_LABEL[key] ?? key}
            </button>
          ))}
          <div className="top-nav-group">
            <button className="top-nav-trigger" onClick={() => setOpenTopMenu((prev) => (prev === "more" ? null : "more"))}>
              More ▾
            </button>
            {openTopMenu === "more" ? (
              <div className="top-nav-dropdown">
                {moreMenus.map((item) => (
                  <button key={item.key} className={activeMenu === item.key ? "nav-item active" : "nav-item"} onClick={() => onSelectMenu(item.key)}>
                    <span>{item.icon}</span> {item.label}
                  </button>
                ))}
                {operatorMenus.length > 0 ? <p className="top-nav-subtitle">운영자 메뉴</p> : null}
                {operatorMenus.map((item) => (
                  <button key={item.key} className={activeMenu === item.key ? "nav-item active" : "nav-item"} onClick={() => onSelectMenu(item.key)}>
                    <span>{item.icon}</span> {item.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="nav-item"
                  onClick={() => {
                    setOpenTopMenu(null);
                    window.open(getWhitepaperPdfUrl(), "_blank", "noopener,noreferrer");
                  }}
                >
                  <span aria-hidden>📄</span> 백서
                </button>
              </div>
            ) : null}
          </div>
        </nav>
        <div className="header-tools" aria-label="빠른 도구">
          <button
            type="button"
            role="switch"
            aria-checked={mainnetLiveEnabled}
            className={mainnetLiveEnabled ? "mainnet-live-toggle mainnet-live-toggle--on" : "mainnet-live-toggle"}
            onClick={() => {
              const next = !mainnetLiveEnabled;
              setMainnetLivePreference(next);
              if (next) {
                setSolanaNetworkPreference("mainnet");
                setPortfolioNotice({
                  variant: "info",
                  text: "Mainnet LIVE 모드가 활성화되었습니다. Execution 화면 기본값이 REAL-RUN + 메인넷으로 동작합니다."
                });
              } else {
                setPortfolioNotice({
                  variant: "info",
                  text: "Mainnet LIVE 모드가 비활성화되었습니다. Execution 화면 기본값이 dry-run으로 돌아갑니다."
                });
              }
            }}
            title={mainnetLiveEnabled ? "Mainnet LIVE 비활성화" : "Mainnet LIVE 활성화"}
          >
            <span className="mainnet-live-toggle-track" aria-hidden>
              <span className="mainnet-live-toggle-thumb" />
            </span>
            <span className="mainnet-live-toggle-text">Mainnet LIVE</span>
          </button>
          <WalletPanel
            compact
            positions={positions}
            withdrawLedger={withdrawLedger}
            portfolioUsd={portfolioTotalUsd}
            onSessionChange={setSession}
            onOpenAuth={() => onSelectMenu("auth")}
            onOpenMyOverview={() => onSelectMenu("my")}
            onOpenWallet={() => onSelectMenu("wallet")}
            onOpenPortfolio={() => onSelectMenu("portfolio")}
            onOpenActivity={() => onSelectMenu("activity")}
          />
          <button
            type="button"
            className="corner-icon header-search-trigger"
            onClick={() => setOperationsSearchOpen(true)}
            aria-label="운영 통합 검색"
            title="운영 통합 검색"
          >
            🔎
          </button>
          {hasQuarterAlert ? (
            <div className="header-alert-group">
              <button
                type="button"
                className="corner-icon header-alert-trigger"
                onClick={() => {
                  setAlertsOpen((prev) => !prev);
                  setQuarterAlertSeen(true);
                }}
                aria-label="알림"
                aria-expanded={alertsOpen}
                title="알림"
              >
                🔔
                {hasUnreadAlerts ? <span className="alert-unread-badge">!</span> : null}
              </button>
              {alertsOpen ? (
                <div className="header-alert-dropdown" role="status">
                  <p className="header-alert-title">분기 점검</p>
                  <p>
                    리밸런싱·가드레일 점검 제안일: <strong>{nextQuarterLabel}</strong>
                  </p>
                  <small>전략 문서 기준 분기 1회</small>
                </div>
              ) : null}
            </div>
          ) : null}
          <button type="button" className="corner-icon" onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))} aria-label="테마 전환">
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </div>
      </header>
      {operationsSearchOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="unified-ops-search-heading"
          onClick={() => setOperationsSearchOpen(false)}
        >
          <div className="modal-card modal-card--operations-search" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="corner-icon modal-close-icon" aria-label="닫기" onClick={() => setOperationsSearchOpen(false)}>
              ✕
            </button>
            <UnifiedOperationsSearch
              focusJobId={focusJobId}
              onFocusJob={(jobId) => {
                setFocusJobId(jobId);
                setActiveMenu("operationsLog");
                setOperationsSearchOpen(false);
                setOpenTopMenu(null);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            />
          </div>
        </div>
      ) : null}
      {portfolioNotice ? (
        <div
          className={`portfolio-notice ${portfolioNotice.variant === "error" ? "portfolio-notice-error" : "portfolio-notice-info"}`}
          role={portfolioNotice.variant === "error" ? "alert" : "status"}
        >
          <span className="portfolio-notice-text">{portfolioNotice.text}</span>
          <button type="button" className="portfolio-notice-dismiss" onClick={() => setPortfolioNotice(null)} aria-label="알림 닫기">
            닫기
          </button>
        </div>
      ) : null}
      <div className="app-layout app-layout-top-nav">
        <section className="content-pane content-center-pane">{renderContent()}</section>
      </div>
    </main>
  );
}
