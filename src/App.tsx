import { useEffect, useMemo, useState } from "react";
import { AuthPanel } from "./components/AuthPanel";
import { SignupRegistrationsPanel } from "./components/SignupRegistrationsPanel";
import { UnifiedOperationsSearch } from "./components/UnifiedOperationsSearch";
import { WalletPanel, type WalletWithdrawLedgerLine } from "./components/WalletPanel";
import { AgentConsensusPanel } from "./components/insights/AgentConsensusPanel";
import { ConsultantInsightsPanel } from "./components/insights/ConsultantInsightsPanel";
import { TradePanel } from "./components/common/TradePanel";
import { RecentActivityPanel } from "./components/activity/RecentActivityPanel";
import { OperationsHistoryPanel } from "./components/activity/OperationsHistoryPanel";
import { ProductsPanel } from "./components/products/ProductsPanel";
import { PortfolioPanel } from "./components/portfolio/PortfolioPanel";
import { CommandCenterPage } from "./pages/CommandCenterPage";
import { StrategiesPage } from "./pages/StrategiesPage";
import { PositionsPage } from "./pages/PositionsPage";
import { ExecutionPage } from "./pages/ExecutionPage";
import {
  AUTH_CLEARED_EVENT,
  cancelJob,
  getWhitepaperPdfUrl,
  listExecutionEvents,
  listJobs,
  type ExecutionEvent,
  type Job
} from "./lib/api";
import { getNextQuarterStart } from "./lib/quarterSchedule";
import { GUEST_WITHDRAW_LEDGER_KEY } from "./lib/constants";
import {
  MENU_ITEMS,
  PRIMARY_NAV_LABEL,
  PRIMARY_NAV_ORDER,
  type MenuKey,
  type TopNavGroupKey
} from "./lib/menu";
import { SessionProvider, useSessionContext } from "./contexts/SessionContext";
import { PortfolioProvider, usePortfolioContext } from "./contexts/PortfolioContext";

function AppShell() {
  const { session, setSession } = useSessionContext();
  const {
    positions,
    setPositions,
    withdrawLedger,
    setWithdrawLedger,
    portfolioNotice,
    setPortfolioNotice,
    portfolioTotalUsd,
    refreshOnchainPositions,
    refreshPositions,
    refreshWithdrawLedgerFromServer
  } = usePortfolioContext();
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [activeMenu, setActiveMenu] = useState<MenuKey>("my");
  const [openTopMenu, setOpenTopMenu] = useState<TopNavGroupKey | null>(null);
  const [recentJobs, setRecentJobs] = useState<Job[]>([]);
  const [recentEvents, setRecentEvents] = useState<ExecutionEvent[]>([]);
  const [focusJobId, setFocusJobId] = useState<string | undefined>(undefined);
  const [operationsSearchOpen, setOperationsSearchOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [quarterAlertSeen, setQuarterAlertSeen] = useState(false);

  const role = session?.role;

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
    const onAuthCleared = (): void => {
      setSession(null);
    };
    window.addEventListener(AUTH_CLEARED_EVENT, onAuthCleared);
    return () => window.removeEventListener(AUTH_CLEARED_EVENT, onAuthCleared);
  }, []);

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
      const [jobsResult, eventsResult] = await Promise.allSettled([
        listJobs({ signal }),
        listExecutionEvents(undefined, { signal })
      ]);
      if (signal.aborted) return;
      setRecentJobs(jobsResult.status === "fulfilled" ? jobsResult.value.slice(0, 6) : []);
      setRecentEvents(eventsResult.status === "fulfilled" ? eventsResult.value.slice(0, 6) : []);
      await Promise.all([refreshPositions(), refreshOnchainPositions(), refreshWithdrawLedgerFromServer()]);
    };
    void loadRecent();
    return () => controller.abort();
  }, [session, refreshOnchainPositions, refreshPositions, refreshWithdrawLedgerFromServer, setPositions, setWithdrawLedger]);

  useEffect(() => {
    const allowed = availableMenus.some((item) => item.key === activeMenu);
    if (!allowed) {
      setActiveMenu(role ? "my" : "products");
    }
  }, [role, activeMenu, availableMenus]);

  const onSelectMenu = (menu: MenuKey) => {
    setActiveMenu(menu);
    setOpenTopMenu(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

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
              onOpenOperationsWithJob={(jobId) => {
                setFocusJobId(jobId);
                setActiveMenu("execution");
                setOpenTopMenu(null);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            />
          </StrategiesPage>
        );
      case "trade":
        return <TradePanel />;
      case "portfolio":
        return (
          <PositionsPage onGo={onSelectMenu}>
            <PortfolioPanel />
          </PositionsPage>
        );
      case "wallet":
        return (
          <WalletPanel
            positions={positions}
            withdrawLedger={withdrawLedger}
            portfolioUsd={portfolioTotalUsd}
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
              await refreshOnchainPositions();
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
          <WalletPanel
            compact
            positions={positions}
            withdrawLedger={withdrawLedger}
            portfolioUsd={portfolioTotalUsd}
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

export default function App() {
  return (
    <SessionProvider>
      <PortfolioProvider>
        <AppShell />
      </PortfolioProvider>
    </SessionProvider>
  );
}
