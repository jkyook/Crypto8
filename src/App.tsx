import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ApprovalsDashboard } from "./components/ApprovalsDashboard";
import { AuthPanel } from "./components/AuthPanel";
import { SignupRegistrationsPanel } from "./components/SignupRegistrationsPanel";
import { DepositPlanner } from "./components/DepositPlanner";
import { MarketAprTimeSeriesChart } from "./components/MarketAprTimeSeriesChart";
import { PortfolioCommandCenter } from "./components/PortfolioCommandCenter";
import { ExecutionEventsDashboard } from "./components/ExecutionEventsDashboard";
import { UnifiedOperationsSearch } from "./components/UnifiedOperationsSearch";
import { OrchestratorBoard } from "./components/OrchestratorBoard";
import { WalletPanel, type WalletWithdrawLedgerLine } from "./components/WalletPanel";
import {
  AUTH_CLEARED_EVENT,
  cancelJob,
  fetchMarketAprSnapshot,
  fetchPoolApyHistoryFromCsv,
  fetchProtocolNews,
  type ProtocolNewsBundle,
  getSession,
  getWhitepaperPdfUrl,
  listDepositPositions,
  listExecutionEvents,
  listJobs,
  listWithdrawalLedger,
  login,
  withdrawProtocolExposureRemote,
  withdrawProductDepositRemote,
  withdrawDepositRemote,
  type AuthSession,
  type DepositPositionPayload,
  type ExecutionEvent,
  type Job,
  type MarketAprSnapshot,
  type MarketPoolAprHistoryPoint,
  type MarketPoolAprHistorySeries,
  type ProductNetwork,
  type ProductSubtype
} from "./lib/api";
import { aggregateChainUsdFromPositions, estimateAnnualYieldUsd } from "./lib/portfolioMetrics";
import { getNextQuarterStart } from "./lib/quarterSchedule";
import type { ExecutionPreviewRow } from "./lib/executionPreview";
import { OPTION_L2_STAR } from "./lib/strategyEngine";

const PORTFOLIO_DONUT_COLORS = ["#8b7bff", "#3bd4ff", "#47d9a8", "#ffb86b"];

type MenuKey =
  | "my"
  | "products"
  | "trade"
  | "portfolio"
  | "auth"
  | "wallet"
  | "execution"
  | "operationsLog"
  | "activity"
  | "consensus"
  | "consultant"
  | "signupHistory";
type UserRole = AuthSession["role"];
type MenuItem = {
  key: MenuKey;
  label: string;
  icon: string;
  group: "operation" | "strategy" | "governance";
  roles: UserRole[];
};
type YieldProduct = {
  id: string;
  name: string;
  networkGroup: "multi" | "arbitrum" | "base" | "solana" | "ethereum";
  /** 서버 어댑터 배분 비율 결정에 사용. api.ts ProductSubtype과 동일 값 사용. */
  subtype: ProductSubtype;
  targetApr: number;
  estFeeBps: number;
  lockDays: number;
  protocolMix: Array<{ name: string; weight: number; pool?: string }>;
  detail: string;
};
type DepositPosition = DepositPositionPayload;
type ProtocolDetailRow = {
  key: string;
  name: string;
  chain: string;
  pool: string;
  amount: number;
};

const PROTOCOL_SORT_ORDER = ["Aave", "Uniswap", "Orca"] as const;

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

function AgentConsensusPanel() {
  return (
    <section className="card consensus-card">
      <h2>에이전트 합의 개선안</h2>
      <div className="kpi-grid">
        <div className="kpi-item">
          <p className="kpi-label">디자인 에이전트</p>
          <p className="kpi-value">실행 버튼 단계 분리 + 상태 배지 강화</p>
        </div>
        <div className="kpi-item">
          <p className="kpi-label">보안 에이전트</p>
          <p className="kpi-value">실행 이벤트 추적 + 재실행 멱등성 강제</p>
        </div>
        <div className="kpi-item">
          <p className="kpi-label">운용 에이전트</p>
          <p className="kpi-value">실행 흐름 자동 모니터링(이벤트 대시보드)</p>
        </div>
        <div className="kpi-item">
          <p className="kpi-label">컨설턴트 에이전트</p>
          <p className="kpi-value">프로토콜 위험 점검 + 파라미터 조정 권고</p>
        </div>
      </div>
    </section>
  );
}

function ConsultantInsightsPanel() {
  const [selectedProtocol, setSelectedProtocol] = useState<string>("");
  const [newsBundle, setNewsBundle] = useState<ProtocolNewsBundle | null>(null);
  const [isNewsLoading, setIsNewsLoading] = useState(false);
  const [newsError, setNewsError] = useState("");
  const protocolCards = [
    {
      name: "Aave (Arbitrum/Base)",
      risk: "Low",
      note: "유동성 충분. 운영 우선순위: 유지",
      details: "수수료 안정적, 변동성 낮음, 재예치 자동화 적합"
    },
    {
      name: "Uniswap V3 (Arbitrum)",
      risk: "Medium",
      note: "틱 범위/슬리피지 상시 점검 필요",
      details: "최근 체결 빈도 높음, 수수료 수익 우수, 범위 이탈 모니터링 필수"
    },
    {
      name: "Orca (Solana)",
      risk: "Medium",
      note: "체인 혼잡/중단 시 fallback 계획 필요",
      details: "체인 상태 의존도 높음, 수수료 경쟁력 양호, 장애 대응 런북 필요"
    }
  ];

  const onSelectProtocol = async (protocolName: string) => {
    setSelectedProtocol(protocolName);
    setIsNewsLoading(true);
    setNewsError("");
    setNewsBundle(null);
    try {
      const bundle = await fetchProtocolNews(protocolName);
      setNewsBundle(bundle);
    } catch (error) {
      setNewsBundle(null);
      setNewsError(error instanceof Error ? error.message : "뉴스 조회 실패");
    } finally {
      setIsNewsLoading(false);
    }
  };

  return (
    <section className="card">
      <h2>컨설턴트 인사이트</h2>
      <p>핵심 프로토콜 점검 기준으로 현재 전략의 우선 조정 항목을 제시합니다.</p>
      <div className="kpi-grid protocol-grid">
        {protocolCards.map((card) => (
          <button key={card.name} className="kpi-item protocol-card" onClick={() => onSelectProtocol(card.name)}>
            <p className="kpi-label">{card.name}</p>
            <p className="kpi-value">리스크: {card.risk}</p>
            <p>{card.note}</p>
            <div className="protocol-hover-detail">{card.details}</div>
          </button>
        ))}
      </div>
      {selectedProtocol ? (
        <div className="card protocol-news-panel" style={{ marginTop: 12 }}>
          <h3>{selectedProtocol} — 최근 동향 요약</h3>
          <p className="protocol-news-lead">뉴스·거버넌스 RSS·GDELT·Reddit 등을 넓게 모은 뒤, 중복을 줄이고 요약합니다.</p>
          {isNewsLoading ? <p>뉴스 조회 중...</p> : null}
          {newsError ? <p>{newsError}</p> : null}
          {!isNewsLoading && !newsError && newsBundle ? (
            <>
              {newsBundle.digest ? (
                <div className="protocol-news-digest" role="region" aria-label="요약">
                  {newsBundle.digest}
                </div>
              ) : null}
              {newsBundle.scannedSources.length > 0 ? (
                <p className="protocol-news-sources">수집에 사용한 소스 태그: {newsBundle.scannedSources.join(" · ")}</p>
              ) : null}
              <h4 className="protocol-news-links-title">근거 링크</h4>
              <div className="recent-list">
                {newsBundle.items.map((item, idx) => (
                  <a key={`${item.url}-${idx}`} className="recent-item" href={item.url} target="_blank" rel="noreferrer">
                    <span className="recent-main">{item.title}</span>
                    <span className="recent-sub">
                      {item.source} · {item.publishedAt ? new Date(item.publishedAt).toLocaleString() : "시간 정보 없음"}
                    </span>
                  </a>
                ))}
                {newsBundle.items.length === 0 ? <p className="recent-empty">표시할 링크가 없습니다. 요약·참고 허브만 확인해 주세요.</p> : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ChainExposureDonut({
  positions,
  compact = false
}: {
  positions: DepositPosition[];
  compact?: boolean;
}) {
  const circumference = 2 * Math.PI * 46;
  const { useLiveChains, chainUsd, chartData, donutSegments } = useMemo(() => {
    const cUsd = aggregateChainUsdFromPositions(positions);
    const cTotal = Object.values(cUsd).reduce((a, b) => a + b, 0);
    const templateWeights = OPTION_L2_STAR.reduce<Record<string, number>>((acc, item) => {
      if (item.chain === "Multi") return acc;
      acc[item.chain] = (acc[item.chain] ?? 0) + item.targetWeight;
      return acc;
    }, {});
    const live = positions.length > 0 && cTotal > 0;
    const rawChart = live
      ? Object.entries(cUsd)
          .filter(([, usd]) => usd > 0)
          .map(([chain, usd]) => ({ chain, weight: usd / cTotal }))
          .sort((a, b) => b.weight - a.weight)
      : Object.entries(templateWeights).map(([chain, weight]) => ({ chain, weight }));
    const rawTotalWeight = rawChart.reduce((sum, item) => sum + item.weight, 0);
    const chart = rawTotalWeight > 0 ? rawChart.map((item) => ({ ...item, weight: item.weight / rawTotalWeight })) : rawChart;
    let acc = 0;
    const segments = chart.map((item, idx) => {
      const dash = circumference * item.weight;
      const offset = circumference * (1 - acc);
      acc += item.weight;
      return { chain: item.chain, dash, offset, color: PORTFOLIO_DONUT_COLORS[idx % PORTFOLIO_DONUT_COLORS.length] };
    });
    return { useLiveChains: live, chainUsd: cUsd, chartData: chart, donutSegments: segments };
  }, [positions, circumference]);

  return (
    <div className={compact ? "chain-exposure-card chain-exposure-card--compact" : "overview-card overview-card--donut"}>
      <p className="kpi-label">{useLiveChains ? "체인별 노출 (예치 기준)" : "체인 비중 (전략 템플릿)"}</p>
      {!useLiveChains ? <p className="portfolio-overview-footnote">예치 전 Option L2* 기본 배분입니다.</p> : null}
      <div className="donut-wrap">
        <svg viewBox="0 0 120 120" className="donut-chart">
          <circle cx="60" cy="60" r="46" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="12" />
          {donutSegments.map((seg) => (
            <circle
              key={seg.chain}
              cx="60"
              cy="60"
              r="46"
              fill="none"
              stroke={seg.color}
              strokeWidth="12"
              strokeDasharray={`${seg.dash} ${Math.max(circumference - seg.dash, 0)}`}
              strokeDashoffset={seg.offset}
              transform="rotate(-90 60 60)"
            />
          ))}
        </svg>
        <div className="legend-list">
          {chartData.map((item, idx) => (
            <p key={item.chain}>
              <span className="legend-dot" style={{ backgroundColor: PORTFOLIO_DONUT_COLORS[idx % PORTFOLIO_DONUT_COLORS.length] }} />
              {item.chain}: {(item.weight * 100).toFixed(1)}%
              {useLiveChains ? <span className="legend-usd"> (${(chainUsd[item.chain] ?? 0).toFixed(0)})</span> : null}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

function RecentActivityPanel({
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

function OperationsHistoryPanel({
  focusJobId,
  recentJobs = [],
  recentEvents = [],
  onOpenJob,
  onOpenEvent
}: {
  focusJobId?: string;
  recentJobs?: Job[];
  recentEvents?: ExecutionEvent[];
  onOpenJob?: (jobId: string) => void;
  onOpenEvent?: (jobId: string) => void;
}) {
  const [openSection, setOpenSection] = useState<"approvals" | "events" | "activity" | null>(focusJobId ? "events" : null);

  return (
    <section className="card">
      <h2>운영 이력</h2>
      <p>승인 로그와 실행 이벤트는 필요한 항목만 펼쳐 세부내역을 확인합니다.</p>
      <div className="operations-log-launcher">
        <button
          type="button"
          className={openSection === "approvals" ? "operations-log-card active" : "operations-log-card"}
          onClick={() => setOpenSection((prev) => (prev === "approvals" ? null : "approvals"))}
        >
          <span>Approval Trail</span>
          <strong>승인 로그 세부내역</strong>
          <em>{openSection === "approvals" ? "접기" : "열기"}</em>
        </button>
        <button
          type="button"
          className={openSection === "events" ? "operations-log-card active" : "operations-log-card"}
          onClick={() => setOpenSection((prev) => (prev === "events" ? null : "events"))}
        >
          <span>Execution Events</span>
          <strong>실행 이벤트 세부내역</strong>
          <em>{openSection === "events" ? "접기" : "열기"}</em>
        </button>
        <button
          type="button"
          className={openSection === "activity" ? "operations-log-card active" : "operations-log-card"}
          onClick={() => setOpenSection((prev) => (prev === "activity" ? null : "activity"))}
        >
          <span>Activity Feed</span>
          <strong>최근 활동 피드</strong>
          <em>{openSection === "activity" ? "접기" : "열기"}</em>
        </button>
      </div>
      {openSection === "approvals" ? <ApprovalsDashboard focusJobId={focusJobId} /> : null}
      {openSection === "events" ? <ExecutionEventsDashboard focusJobId={focusJobId} /> : null}
      {openSection === "activity" && onOpenJob && onOpenEvent ? (
        <RecentActivityPanel recentJobs={recentJobs} recentEvents={recentEvents} onOpenJob={onOpenJob} onOpenEvent={onOpenEvent} />
      ) : null}
    </section>
  );
}

function TradeControls({
  onDeposit,
  onWithdraw,
  disabled,
  size = "compact"
}: {
  onDeposit: () => void;
  onWithdraw: () => void;
  disabled?: boolean;
  size?: "compact" | "large";
}) {
  return (
    <div className={`inline-trade-controls inline-trade-controls--${size}`} aria-label="입금 인출">
      <button type="button" className="inline-trade-btn inline-trade-btn-plus" onClick={onDeposit} disabled={disabled} aria-label="입금">
        +
      </button>
      <button type="button" className="inline-trade-btn inline-trade-btn-minus" onClick={onWithdraw} disabled={disabled} aria-label="인출">
        -
      </button>
    </div>
  );
}

function applyLifoWithdraw(positions: DepositPosition[], amountUsd: number): DepositPosition[] {
  let remaining = Math.max(0, amountUsd);
  const sorted = [...positions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const kept: DepositPosition[] = [];
  for (const p of sorted) {
    if (remaining <= 0) {
      kept.push(p);
      continue;
    }
    if (p.amountUsd <= remaining) {
      remaining -= p.amountUsd;
    } else {
      kept.push({ ...p, amountUsd: p.amountUsd - remaining });
      remaining = 0;
    }
  }
  return kept;
}

function applyTargetedWithdraw(
  positions: DepositPosition[],
  amountUsd: number,
  target: Pick<ProtocolDetailRow, "name" | "chain" | "pool">
): DepositPosition[] {
  let remaining = amountUsd;
  const next: DepositPosition[] = [];
  const matchesTarget = (mix: { name: string; pool?: string }) =>
    mix.name.toLowerCase() === target.name.toLowerCase() &&
    inferProtocolChain(mix.name, mix.pool).toLowerCase() === target.chain.toLowerCase() &&
    (mix.pool ?? "").trim().toLowerCase() === target.pool.trim().toLowerCase();

  for (const position of positions) {
    if (remaining <= 0) {
      next.push(position);
      continue;
    }
    const absoluteMix = position.protocolMix.map((mix) => ({
      mix,
      amountUsd: position.amountUsd * mix.weight
    }));
    let withdrawnFromPosition = 0;
    for (const item of absoluteMix) {
      if (remaining <= 0) break;
      if (!matchesTarget(item.mix)) continue;
      const take = Math.min(item.amountUsd, remaining);
      item.amountUsd -= take;
      withdrawnFromPosition += take;
      remaining -= take;
    }
    if (withdrawnFromPosition <= 0) {
      next.push(position);
      continue;
    }
    const nextAmount = position.amountUsd - withdrawnFromPosition;
    if (nextAmount <= 0.000001) continue;
    next.push({
      ...position,
      amountUsd: nextAmount,
      protocolMix: absoluteMix
        .filter((item) => item.amountUsd > 0.000001)
        .map((item) => ({
          ...item.mix,
          weight: item.amountUsd / nextAmount
        }))
    });
  }
  return next;
}

function applyProductWithdraw(positions: DepositPosition[], amountUsd: number, productName: string): DepositPosition[] {
  let remaining = amountUsd;
  const kept: DepositPosition[] = [];
  for (const position of positions) {
    if (remaining <= 0 || position.productName !== productName) {
      kept.push(position);
      continue;
    }
    if (position.amountUsd <= remaining) {
      remaining -= position.amountUsd;
    } else {
      kept.push({ ...position, amountUsd: position.amountUsd - remaining });
      remaining = 0;
    }
  }
  return kept;
}

const APR_DAYS_PER_YEAR = 365;

/** UI의 networkGroup(소문자) → 서버 어댑터의 ProductNetwork(PascalCase) 변환 */
function networkGroupToProductNetwork(networkGroup: YieldProduct["networkGroup"]): ProductNetwork {
  const map: Record<YieldProduct["networkGroup"], ProductNetwork> = {
    multi: "Multi",
    arbitrum: "Arbitrum",
    base: "Base",
    solana: "Solana",
    ethereum: "Ethereum"
  };
  return map[networkGroup] ?? "Multi";
}

/** networkGroup → 기본 ProductSubtype (사용자 추가 상품 등 subtype 미지정 시 fallback) */
function networkGroupToDefaultSubtype(networkGroup: YieldProduct["networkGroup"]): ProductSubtype {
  const map: Record<YieldProduct["networkGroup"], ProductSubtype> = {
    multi: "multi-stable",
    arbitrum: "arb-stable",
    base: "base-stable",
    solana: "sol-stable",
    ethereum: "eth-stable"
  };
  return map[networkGroup] ?? "multi-stable";
}

const PRODUCT_NETWORK_GROUPS: Array<{
  key: YieldProduct["networkGroup"];
  label: string;
  description: string;
}> = [
  { key: "multi", label: "복수 네트워크", description: "Arbitrum · Base · Solana를 함께 쓰는 기존 분산형 상품" },
  { key: "arbitrum", label: "Arbitrum", description: "브릿지 없이 Arbitrum 안에서 Aave/Uniswap 풀로 분산" },
  { key: "base", label: "Base", description: "Base 네트워크 안에서 USDC 중심 공급/LP로 구성" },
  { key: "solana", label: "Solana", description: "Solana 안에서 Orca Whirlpool 기반 스테이블/LST 풀로 구성" },
  { key: "ethereum", label: "Ethereum", description: "Ethereum 메인넷에서 Aave/Curve/Uniswap 풀로 구성된 안정형 상품" }
];

const PRODUCT_NETWORK_LABELS = PRODUCT_NETWORK_GROUPS.reduce(
  (acc, group) => ({ ...acc, [group.key]: group.label }),
  {} as Record<YieldProduct["networkGroup"], string>
);

function buildDefaultProductMix(networkGroup: YieldProduct["networkGroup"]): YieldProduct["protocolMix"] {
  if (networkGroup === "arbitrum") {
    return [
      { name: "Aave", weight: 0.45, pool: "Aave v3 Arbitrum USDC eMode" },
      { name: "Uniswap", weight: 0.35, pool: "Uniswap v3 Arbitrum USDC-USDT 0.05%" },
      { name: "Uniswap", weight: 0.2, pool: "Uniswap v3 Arbitrum ETH-USDC 0.05% (±50%)" }
    ];
  }
  if (networkGroup === "base") {
    return [
      { name: "Aave", weight: 0.5, pool: "Aave v3 Base USDC eMode" },
      { name: "Uniswap", weight: 0.3, pool: "Uniswap v3 Base ETH-USDC 0.05%" },
      { name: "Uniswap", weight: 0.2, pool: "Uniswap v3 Base USDC-USDT 0.05%" }
    ];
  }
  if (networkGroup === "solana") {
    return [
      { name: "Orca", weight: 0.4, pool: "Orca Whirlpools USDC-USDT" },
      { name: "Orca", weight: 0.35, pool: "Orca Whirlpools SOL-USDC" },
      { name: "Orca", weight: 0.25, pool: "Orca Whirlpools mSOL-SOL" }
    ];
  }
  if (networkGroup === "ethereum") {
    return [
      { name: "Aave", weight: 0.4, pool: "Aave v3 Ethereum USDC" },
      { name: "Curve", weight: 0.35, pool: "Curve 3pool DAI-USDC-USDT" },
      { name: "Uniswap", weight: 0.25, pool: "Uniswap v3 Ethereum USDC-USDT 0.01%" }
    ];
  }
  return [
    { name: "Aave", weight: 0.34, pool: "Aave v3 Arbitrum USDC eMode" },
    { name: "Uniswap", weight: 0.33, pool: "Uniswap v3 Arbitrum USDC-USDT 0.05%" },
    { name: "Orca", weight: 0.33, pool: "Orca Whirlpools SOL-USDC" }
  ];
}

function mixItemAnnualAprDecimal(name: string, snapshot: MarketAprSnapshot): number {
  const key = name.toLowerCase();
  if (key.includes("aave")) return snapshot.aave;
  if (key.includes("uniswap")) return snapshot.uniswap;
  return snapshot.orca;
}

/** 연 APR(소수) → 단순 선형 근사 7일 수익률(퍼센트 포인트, 예 0.12 → 0.12%) */
function aprDecimalToSimpleWeekYieldPercentPoints(annualAprDecimal: number): number {
  return annualAprDecimal * (7 / APR_DAYS_PER_YEAR) * 100;
}

const DEFAULT_PRODUCTS: YieldProduct[] = [
  {
    id: "p-multi-stable-8",
    name: "Multi-network Stable 8%",
    networkGroup: "multi",
    subtype: "multi-stable",
    targetApr: 0.08,
    estFeeBps: 65,
    lockDays: 30,
    protocolMix: [
      { name: "Aave", weight: 0.45, pool: "Aave v3 Arbitrum USDC eMode" },
      { name: "Uniswap", weight: 0.35, pool: "Uniswap v3 Arbitrum USDC-USDT 0.05%" },
      { name: "Orca", weight: 0.2, pool: "Orca Whirlpools SOL-USDC" }
    ],
    detail: "초기 전략 문서 기반 기본 상품. Arbitrum, Base, Solana를 함께 쓰는 안정성 중심 분산 예치."
  },
  {
    id: "p-multi-balanced-72",
    name: "Multi-network Balanced 7.2%",
    networkGroup: "multi",
    subtype: "multi-balanced",
    targetApr: 0.072,
    estFeeBps: 58,
    lockDays: 21,
    protocolMix: [
      { name: "Aave", weight: 0.5, pool: "Aave v3 Base USDC eMode" },
      { name: "Uniswap", weight: 0.3, pool: "Uniswap v3 Arbitrum ETH-USDC 0.05% (±50%)" },
      { name: "Orca", weight: 0.2, pool: "Orca Whirlpools mSOL-SOL" }
    ],
    detail: "변동성 완화를 우선한 중립형 예치상품. 네트워크 간 분산 효과를 유지합니다."
  },
  {
    id: "p-arbitrum-stable-76",
    name: "Arbitrum Stable 7.6%",
    networkGroup: "arbitrum",
    subtype: "arb-stable",
    targetApr: 0.076,
    estFeeBps: 48,
    lockDays: 21,
    protocolMix: [
      { name: "Aave", weight: 0.45, pool: "Aave v3 Arbitrum USDC eMode" },
      { name: "Uniswap", weight: 0.35, pool: "Uniswap v3 Arbitrum USDC-USDT 0.05%" },
      { name: "Uniswap", weight: 0.2, pool: "Uniswap v3 Arbitrum ETH-USDC 0.05% (±50%)" }
    ],
    detail: "브릿지 없이 Arbitrum 내에서 USDC 공급과 스테이블/ETH-USDC LP를 조합한 상품."
  },
  {
    id: "p-base-usdc-70",
    name: "Base USDC Core 7.0%",
    networkGroup: "base",
    subtype: "base-stable",
    targetApr: 0.07,
    estFeeBps: 44,
    lockDays: 21,
    protocolMix: [
      { name: "Aave", weight: 0.5, pool: "Aave v3 Base USDC eMode" },
      { name: "Uniswap", weight: 0.3, pool: "Uniswap v3 Base ETH-USDC 0.05%" },
      { name: "Uniswap", weight: 0.2, pool: "Uniswap v3 Base USDC-USDT 0.05%" }
    ],
    detail: "Base 네트워크 안에서 Aave USDC 공급과 Uniswap Base LP를 묶어 네트워크 이동을 줄입니다."
  },
  {
    id: "p-solana-orca-74",
    name: "Solana Orca Blend 7.4%",
    networkGroup: "solana",
    subtype: "sol-stable",
    targetApr: 0.074,
    estFeeBps: 42,
    lockDays: 14,
    protocolMix: [
      { name: "Orca", weight: 0.4, pool: "Orca Whirlpools USDC-USDT" },
      { name: "Orca", weight: 0.35, pool: "Orca Whirlpools SOL-USDC" },
      { name: "Orca", weight: 0.25, pool: "Orca Whirlpools mSOL-SOL" }
    ],
    detail: "Solana 네트워크 안에서 Orca 스테이블·SOL·LST 풀을 나눠 담는 단일 네트워크 상품."
  },
  {
    id: "p-eth-stable-42",
    name: "Ethereum Stable 4.2%",
    networkGroup: "ethereum",
    subtype: "eth-stable",
    targetApr: 0.042,
    estFeeBps: 55,
    lockDays: 30,
    protocolMix: [
      { name: "Aave", weight: 0.4, pool: "Aave v3 Ethereum USDC" },
      { name: "Curve", weight: 0.35, pool: "Curve 3pool DAI-USDC-USDT" },
      { name: "Uniswap", weight: 0.25, pool: "Uniswap v3 Ethereum USDC-USDT 0.01%" }
    ],
    detail: "Ethereum 메인넷에서 Aave USDC 공급, Curve 3pool, Uniswap 스테이블 LP를 조합한 안정형 상품."
  },
  {
    id: "p-eth-bluechip-55",
    name: "Ethereum Blue-chip 5.5%",
    networkGroup: "ethereum",
    subtype: "eth-bluechip",
    targetApr: 0.055,
    estFeeBps: 58,
    lockDays: 30,
    protocolMix: [
      { name: "Aave", weight: 0.3, pool: "Aave v3 Ethereum WETH" },
      { name: "Curve", weight: 0.4, pool: "Curve stETH-ETH" },
      { name: "Uniswap", weight: 0.3, pool: "Uniswap v3 Ethereum ETH-USDC 0.05%" }
    ],
    detail: "Ethereum 메인넷 대표 자산(ETH/stETH) 중심의 Blue-chip 예치상품. Curve LSD 수익 포함."
  }
];

function ProductsPanel({
  positions,
  hasSession,
  canPersistToServer,
  onWithdraw,
  onWithdrawProduct,
  onActionNotice,
  onOpenOperationsWithJob,
  onExecutionComplete
}: {
  positions: DepositPosition[];
  hasSession: boolean;
  canPersistToServer: boolean;
  onWithdraw: (amountUsd: number) => void | Promise<void>;
  onWithdrawProduct?: (amountUsd: number, productName: string) => void | Promise<void>;
  onActionNotice?: (notice: { variant: "error" | "info"; text: string }) => void;
  onOpenOperationsWithJob?: (jobId: string) => void;
  onExecutionComplete?: () => void | Promise<void>;
}) {
  const [products, setProducts] = useState<YieldProduct[]>(DEFAULT_PRODUCTS);
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_PRODUCTS[0].id);
  const [productNetworkFilter, setProductNetworkFilter] = useState<YieldProduct["networkGroup"]>("multi");
  const [depositAmount, setDepositAmount] = useState(1000);
  const [newName, setNewName] = useState("");
  const [newApr, setNewApr] = useState("0.07");
  const [isAddFormOpen, setIsAddFormOpen] = useState(false);
  const [isExecutionOpen, setIsExecutionOpen] = useState(false);
  const [executionFlowKey, setExecutionFlowKey] = useState(0);
  const [productWithdrawDraft, setProductWithdrawDraft] = useState<YieldProduct | null>(null);
  const [productWithdrawAmount, setProductWithdrawAmount] = useState(0);
  const [productWithdrawPassword, setProductWithdrawPassword] = useState("");
  const [productWithdrawLoading, setProductWithdrawLoading] = useState(false);
  const [productWithdrawError, setProductWithdrawError] = useState("");
  const userDepositedUsd = positions.reduce((acc, p) => acc + p.amountUsd, 0);
  const [simulationDays, setSimulationDays] = useState(30);
  const [marketApr, setMarketApr] = useState<MarketAprSnapshot | null>(null);
  const [aprError, setAprError] = useState("");
  const [showStandardL2Allocation, setShowStandardL2Allocation] = useState(false);
  const [marketHistoryPoints, setMarketHistoryPoints] = useState<MarketPoolAprHistoryPoint[]>([]);
  const [marketHistorySeries, setMarketHistorySeries] = useState<MarketPoolAprHistorySeries[]>([]);
  const [historyCsvDays, setHistoryCsvDays] = useState(90);
  const historyGranularity: "day" = "day";
  const resolvePoolLabel = (name: string, pool?: string) => {
    if (pool && pool.trim().length > 0) return pool;
    const key = name.toLowerCase();
    if (key.includes("aave")) return "Aave v3 Arbitrum USDC eMode";
    if (key.includes("uniswap")) return "Uniswap v3 Arbitrum USDC-USDT 0.05%";
    if (key.includes("orca")) return "Orca Whirlpools SOL-USDC";
    return "기본 풀";
  };
  const tvlUsd = 241_979_511 + userDepositedUsd;
  const volume24hUsd = 298_259_130;
  const visibleProducts = useMemo(
    () => products.filter((product) => product.networkGroup === productNetworkFilter),
    [productNetworkFilter, products]
  );
  const selected = products.find((item) => item.id === selectedId) ?? visibleProducts[0] ?? products[0];
  const productWithdrawMaxUsd = useMemo(() => {
    if (!productWithdrawDraft) return 0;
    return positions
      .filter((position) => position.productName === productWithdrawDraft.name)
      .reduce((acc, position) => acc + position.amountUsd, 0);
  }, [positions, productWithdrawDraft]);
  const productWithdrawPreview = useMemo(() => {
    if (!productWithdrawDraft || productWithdrawAmount <= 0) return [];
    return productWithdrawDraft.protocolMix.map((item) => ({
      protocol: item.name,
      pool: resolvePoolLabel(item.name, item.pool),
      weight: item.weight,
      amountUsd: productWithdrawAmount * item.weight
    }));
  }, [productWithdrawAmount, productWithdrawDraft]);
  const selectedPoolLabels = useMemo(
    () => selected.protocolMix.map((item) => resolvePoolLabel(item.name, item.pool)),
    [selected]
  );
  const selectedPoolWeights = useMemo(() => {
    const weights: Record<string, number> = {};
    selected.protocolMix.forEach((item, idx) => {
      const key = selectedPoolLabels[idx]?.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 42);
      if (key) weights[key] = (weights[key] ?? 0) + item.weight;
    });
    return weights;
  }, [selected.protocolMix, selectedPoolLabels]);
  const estYield = depositAmount * selected.targetApr;
  const estFee = (depositAmount * selected.estFeeBps) / 10_000;
  const dailyRate = marketApr
    ? selected.protocolMix.reduce((acc, item) => {
        const key = item.name.toLowerCase();
        const protocolApr = key.includes("aave") ? marketApr.aave : key.includes("uniswap") ? marketApr.uniswap : marketApr.orca;
        return acc + protocolApr * item.weight;
      }, 0) / 365
    : selected.targetApr / 365;
  const periodYield = depositAmount * dailyRate * simulationDays;

  const blendedAnnualAprDecimal = useMemo(() => {
    if (!marketApr) return null;
    const sel = products.find((item) => item.id === selectedId) ?? products[0];
    return sel.protocolMix.reduce((acc, item) => acc + mixItemAnnualAprDecimal(item.name, marketApr) * item.weight, 0);
  }, [marketApr, products, selectedId]);

  const blendedWeekYieldPercentPoints =
    blendedAnnualAprDecimal != null ? aprDecimalToSimpleWeekYieldPercentPoints(blendedAnnualAprDecimal) : null;
  const blendedWeekUsdEstimate =
    blendedWeekYieldPercentPoints != null ? (depositAmount * blendedWeekYieldPercentPoints) / 100 : null;

  useEffect(() => {
    if (visibleProducts.length === 0) return;
    if (!visibleProducts.some((product) => product.id === selectedId)) {
      setSelectedId(visibleProducts[0].id);
      setIsExecutionOpen(false);
    }
  }, [selectedId, visibleProducts]);

  useEffect(() => {
    let cancelled = false;
    const loadAprAndHistory = async () => {
      try {
        setAprError("");
        const snapshot = await fetchMarketAprSnapshot();
        if (!cancelled) setMarketApr(snapshot);
      } catch (error) {
        if (!cancelled) {
          setAprError(error instanceof Error ? error.message : "실시간 이율 조회 실패");
          setMarketApr(null);
        }
      }
      try {
        const hist = await fetchPoolApyHistoryFromCsv({ days: historyCsvDays, pools: selectedPoolLabels });
        if (!cancelled) {
          setMarketHistoryPoints(hist.points);
          setMarketHistorySeries(hist.series);
        }
      } catch {
        if (!cancelled) {
          setMarketHistoryPoints([]);
          setMarketHistorySeries([]);
        }
      }
    };
    void loadAprAndHistory();
    const timer = window.setInterval(() => void loadAprAndHistory(), 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [historyCsvDays, selectedPoolLabels]);

  const openProductDepositFlow = (product: YieldProduct, amountUsd = depositAmount) => {
    setSelectedId(product.id);
    setDepositAmount(amountUsd);
    setIsExecutionOpen(true);
  };

  const adjustSelectedProductAmount = (product: YieldProduct, delta: number) => {
    setSelectedId(product.id);
    setDepositAmount((prev) => Math.max(0, (Number.isFinite(prev) ? prev : 0) + delta));
    setIsExecutionOpen(false);
  };

  const openProductWithdrawFlow = (product: YieldProduct) => {
    setSelectedId(product.id);
    if (!Number.isFinite(depositAmount) || depositAmount <= 0) {
      onActionNotice?.({ variant: "error", text: "0보다 큰 인출 금액을 입력해 주세요." });
      return;
    }
    const maxUsd = positions
      .filter((position) => position.productName === product.name)
      .reduce((acc, position) => acc + position.amountUsd, 0);
    if (maxUsd <= 0) {
      onActionNotice?.({ variant: "info", text: "선택 상품으로 예치된 잔액이 없습니다." });
      return;
    }
    setProductWithdrawDraft(product);
    setProductWithdrawAmount(Math.min(depositAmount, maxUsd));
    setProductWithdrawPassword("");
    setProductWithdrawError("");
  };

  const confirmProductWithdraw = async () => {
    if (!productWithdrawDraft || productWithdrawAmount <= 0) return;
    if (canPersistToServer && !productWithdrawPassword) {
      setProductWithdrawError("비밀번호를 입력하세요.");
      return;
    }
    setProductWithdrawLoading(true);
    setProductWithdrawError("");
    try {
      if (canPersistToServer) {
        const session = getSession();
        if (!session) throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
        await login(session.username, productWithdrawPassword);
      }
      await (onWithdrawProduct
        ? onWithdrawProduct(productWithdrawAmount, productWithdrawDraft.name)
        : onWithdraw(productWithdrawAmount));
      setProductWithdrawDraft(null);
      setProductWithdrawPassword("");
      onActionNotice?.({ variant: "info", text: `${productWithdrawDraft.name} $${productWithdrawAmount.toFixed(2)} 인출 처리 완료` });
    } catch (error) {
      setProductWithdrawError(error instanceof Error ? error.message : "상품 인출 확인 실패");
    } finally {
      setProductWithdrawLoading(false);
    }
  };

  const onQuickDepositProduct = (product: YieldProduct, amount: number) => {
    if (!Number.isFinite(amount) || amount <= 0) {
      onActionNotice?.({ variant: "error", text: "0보다 큰 입금 금액을 입력해 주세요." });
      return;
    }
    setExecutionFlowKey((prev) => prev + 1);
    openProductDepositFlow(product, amount);
  };

  const marketHistorySeriesWithWeights = useMemo(
    () =>
      marketHistorySeries.map((series) => ({
        ...series,
        weight: selectedPoolWeights[series.key] ?? 0
      })),
    [marketHistorySeries, selectedPoolWeights]
  );

  const productPreviewRows = useMemo<ExecutionPreviewRow[]>(() => {
    if (!Number.isFinite(depositAmount) || depositAmount <= 0) return [];
    return selected.protocolMix.map((item) => {
      const pool = resolvePoolLabel(item.name, item.pool);
      return {
        protocol: item.name,
        chain: inferProtocolChain(item.name, pool),
        action: pool.replace(/^Aave v3\s+/i, "").replace(/^Uniswap v3\s+/i, "").replace(/^Orca Whirlpools\s+/i, ""),
        allocationUsd: Number((depositAmount * item.weight).toFixed(2))
      };
    });
  }, [depositAmount, selected]);

  return (
    <section className="card">
      {!hasSession ? (
        <p className="product-session-hint">로그인하면 예치 내역이 서버에 저장되어 새로고침 후에도 포트폴리오에 유지됩니다.</p>
      ) : !canPersistToServer ? (
        <p className="product-session-hint">
          서버에 예치·인출을 남기려면 <strong>로그인</strong>하세요. 비로그인 시에는 이 기기에서만 임시로 반영됩니다.
        </p>
      ) : null}
      <div className="products-header-row">
        <div className="products-market-stats">
          <div className="products-market-stat">
            <p className="products-market-label">TVL</p>
            <p className="products-market-value">${tvlUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
          </div>
          <div className="products-market-stat">
            <p className="products-market-label">24H Volume</p>
            <p className="products-market-value">${volume24hUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
          </div>
        </div>
        <button className="add-product-icon-btn" onClick={() => setIsAddFormOpen((prev) => !prev)} aria-label="배분안 추가 열기">
          +
        </button>
      </div>
      {isAddFormOpen ? (
        <div className="product-add-form">
          <h3>배분안 추가 (운영자/이용자)</h3>
          <input placeholder="상품명" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input placeholder="목표 APR (예: 0.07)" value={newApr} onChange={(e) => setNewApr(e.target.value)} />
          <div className="button-row">
            <button
              onClick={() => {
                const apr = Number(newApr);
                if (!newName || Number.isNaN(apr) || apr <= 0) return;
                const id = `p-${Date.now()}`;
                setProducts((prev) => [
                  ...prev,
                  {
                    id,
                    name: newName,
                    targetApr: apr,
                    estFeeBps: 75,
                    lockDays: 30,
                    networkGroup: productNetworkFilter,
                    subtype: networkGroupToDefaultSubtype(productNetworkFilter),
                    protocolMix: buildDefaultProductMix(productNetworkFilter),
                    detail: `${PRODUCT_NETWORK_LABELS[productNetworkFilter]} 사용자 정의 예치상품`
                  }
                ]);
                setSelectedId(id);
                setNewName("");
                setNewApr("0.07");
                setIsAddFormOpen(false);
              }}
            >
              상품 추가
            </button>
          </div>
        </div>
      ) : null}
      <div className="product-network-tabs" role="tablist" aria-label="Pools 네트워크 선택">
        {PRODUCT_NETWORK_GROUPS.map((group) => {
          const count = products.filter((product) => product.networkGroup === group.key).length;
          return (
            <button
              key={group.key}
              type="button"
              role="tab"
              aria-selected={productNetworkFilter === group.key}
              className={
                productNetworkFilter === group.key
                  ? `product-network-tab product-network-tab--${group.key} active`
                  : `product-network-tab product-network-tab--${group.key}`
              }
              title={group.description}
              onClick={() => setProductNetworkFilter(group.key)}
            >
              <span>{group.label}</span>
              <strong>{count}</strong>
            </button>
          );
        })}
      </div>
      <div className="kpi-grid product-list-grid">
        {visibleProducts.map((product) => (
          <div
            key={product.id}
            className={selectedId === product.id ? "kpi-item product-card product-card--selected" : "kpi-item product-card"}
          >
            <div className="pool-card-action-cluster">
              <button
                type="button"
                className="pool-card-minus-btn"
                aria-label={`${product.name} 입금 금액 줄이기`}
                title="선택 상품의 입금 예정 금액을 100 USD 줄입니다."
                onClick={(event) => {
                  event.stopPropagation();
                  adjustSelectedProductAmount(product, -100);
                }}
              >
                -
              </button>
              <button
                type="button"
                className="pool-card-plus-btn"
                aria-label={`${product.name} 입금 금액 올리기`}
                title="선택 상품의 입금 예정 금액을 100 USD 올립니다."
                onClick={(event) => {
                  event.stopPropagation();
                  adjustSelectedProductAmount(product, 100);
                }}
              >
                +
              </button>
            </div>
            <button
              className={selectedId === product.id ? "nav-item active" : "nav-item"}
              onClick={() => {
                setSelectedId(product.id);
                setIsExecutionOpen(false);
              }}
              title="상품을 선택하면 아래 입금 패널과 예치풀 상세가 이 상품 기준으로 바뀝니다."
            >
              <span className={`product-network-badge product-network-badge--${product.networkGroup}`}>
                {PRODUCT_NETWORK_LABELS[product.networkGroup]}
              </span>
              <p className="kpi-label">{product.name}</p>
              <p className="kpi-value">목표 연수익 {(product.targetApr * 100).toFixed(1)}%</p>
              <p className="product-inline-metrics">
                수수료 {(product.estFeeBps / 100).toFixed(2)}% · 만기 {product.lockDays}일 · 프로토콜 {product.protocolMix.length}개
              </p>
            </button>
            {selectedId === product.id ? (
              <div className="product-subdetail">
                <p>{product.detail}</p>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="product-actions">
        <div className="selected-product-ticket">
          <span>선택 상품</span>
          <strong>{selected.name}</strong>
          <em>+ / - 버튼 또는 입력칸으로 입금 예정 금액을 조정합니다.</em>
        </div>
        <div className="product-action-row">
          <span className="product-action-label">금액</span>
          <input
            type="number"
            value={depositAmount}
            min={100}
            step={100}
            onChange={(e) => {
              setDepositAmount(Number(e.target.value));
              setIsExecutionOpen(false);
            }}
            title="입금 예정 금액을 직접 입력합니다."
          />
          <div className="button-row product-action-buttons">
            <button
              type="button"
              className="product-action-btn btn-primary"
              onClick={() => onQuickDepositProduct(selected, depositAmount)}
              title="입금 처리 화면을 열고 내 입금 작업 생성, 리스크 검토, 실행 요청을 진행합니다."
            >
              입금
            </button>
            <button type="button" className="product-action-btn" onClick={() => openProductWithdrawFlow(selected)}>
              인출
            </button>
          </div>
        </div>
        <p className="product-estimate-line">
          수익 ${estYield.toFixed(2)} · 수수료 ${estFee.toFixed(2)}
        </p>
        <div className="product-pool-panel">
          <p className="product-pool-title">프로토콜 예치풀 세부내역</p>
          <div className="product-pool-list">
            <div className="product-pool-item product-pool-item--header">
              <span>프로토콜</span>
              <span>풀</span>
              <span>비중</span>
              <span>배분(USD)</span>
              <span>1주 이율</span>
            </div>
            {selected.protocolMix.map((item, mixIdx) => {
              const poolAmount = depositAmount * item.weight;
              const rowAprDec = marketApr ? mixItemAnnualAprDecimal(item.name, marketApr) : null;
              const weekPct = rowAprDec != null ? aprDecimalToSimpleWeekYieldPercentPoints(rowAprDec) : null;
              return (
                <div key={`${item.name}-${mixIdx}`} className="product-pool-item">
                  <span>{item.name}</span>
                  <span className="product-pool-pool-label">{resolvePoolLabel(item.name, item.pool)}</span>
                  <span>{(item.weight * 100).toFixed(0)}%</span>
                  <span>${poolAmount.toFixed(2)}</span>
                  <span className="product-pool-week-cell">{weekPct != null ? `${weekPct.toFixed(3)}%` : "—"}</span>
                </div>
              );
            })}
          </div>
          {blendedWeekYieldPercentPoints != null ? (
            <p className="product-pool-weighted-weekly">
              배분 가중 합계 1주 이율{" "}
              <strong>
                {blendedWeekYieldPercentPoints.toFixed(3)}%{blendedWeekUsdEstimate != null ? ` (≈ $${blendedWeekUsdEstimate.toFixed(2)})` : ""}
              </strong>
            </p>
          ) : !aprError ? (
            <p className="product-pool-weighted-weekly product-pool-weighted-weekly--pending">시장 이율을 불러오는 중입니다…</p>
          ) : null}
          <div className="market-apr-ts-toolbar">
            <span className="market-apr-ts-toolbar-label">일별 구간</span>
            <select
              className="market-apr-ts-toolbar-select"
              value={historyCsvDays}
              onChange={(e) => setHistoryCsvDays(Number(e.target.value))}
              aria-label="apy_history CSV 일수"
            >
              <option value={14}>14일</option>
              <option value={30}>30일</option>
              <option value={90}>90일</option>
              <option value={180}>180일</option>
            </select>
          </div>
          <MarketAprTimeSeriesChart
            points={marketHistoryPoints}
            granularity={historyGranularity}
            series={marketHistorySeriesWithWeights}
          />
          <p>
            기간{" "}
            <select value={simulationDays} onChange={(event) => setSimulationDays(Number(event.target.value))}>
              <option value={7}>7일</option>
              <option value={30}>30일</option>
              <option value={90}>90일</option>
              <option value={180}>180일</option>
            </select>{" "}
            · 현재 이율 기준 예상 수익 ${periodYield.toFixed(2)}
          </p>
          <p>
            현재 이율(Aave/Uniswap/Orca):{" "}
            {marketApr
              ? `${(marketApr.aave * 100).toFixed(2)}% / ${(marketApr.uniswap * 100).toFixed(2)}% / ${(marketApr.orca * 100).toFixed(2)}%`
              : "조회 중..."}
          </p>
          {aprError ? <p>{aprError}</p> : null}
        </div>
        <div className="standard-l2-toggle-row">
          <button
            type="button"
            className="standard-l2-chip"
            onClick={() => setShowStandardL2Allocation((prev) => !prev)}
            aria-expanded={showStandardL2Allocation}
          >
            표준배분안{showStandardL2Allocation ? " · 접기" : ""}
          </button>
        </div>
      </div>
      {showStandardL2Allocation ? (
        <div className="deposit-l2-collapsible-footer">
          <DepositPlanner
            variant="embedded"
            embeddedCompact
            depositUsd={depositAmount}
            onDepositUsdChange={setDepositAmount}
          />
        </div>
      ) : null}
      {isExecutionOpen ? (
        <div className="modal-backdrop modal-backdrop--execution" role="dialog" aria-modal="true" aria-label="입금 처리 팝업">
          <div className="modal-card execution-modal-card deposit-execution-modal">
            <button type="button" className="modal-close-icon" aria-label="닫기" onClick={() => setIsExecutionOpen(false)}>
              x
            </button>
            <div className="inline-execution-panel-head">
              <div>
                <p className="section-eyebrow">Deposit Flow</p>
                <h3>선택 상품 입금 처리</h3>
              </div>
            </div>
            <OrchestratorBoard
              key={`${selected.id}-${executionFlowKey}`}
              initialDepositUsd={depositAmount}
              initialProductName={selected.name}
              initialEstYieldUsd={estYield}
              initialEstFeeUsd={estFee}
              initialProductNetwork={networkGroupToProductNetwork(selected.networkGroup)}
              initialProductSubtype={selected.subtype}
              allowJobExecution={canPersistToServer}
              previewRowsOverride={productPreviewRows}
              onActionNotice={onActionNotice}
              onOpenOperationsWithJob={onOpenOperationsWithJob}
              onExecutionComplete={onExecutionComplete}
            />
          </div>
        </div>
      ) : null}
      {productWithdrawDraft ? (
        <div className="modal-backdrop modal-backdrop--execution" role="dialog" aria-modal="true" aria-label="상품 인출 확인">
          <div className="modal-card execution-modal-card product-withdraw-modal">
            <button
              type="button"
              className="modal-close-icon"
              aria-label="닫기"
              onClick={() => {
                setProductWithdrawDraft(null);
                setProductWithdrawPassword("");
                setProductWithdrawError("");
              }}
              disabled={productWithdrawLoading}
            >
              x
            </button>
            <div className="inline-execution-panel-head">
              <div>
                <p className="section-eyebrow">Pool Withdraw</p>
                <h3>{productWithdrawDraft.name} 인출</h3>
                <p className="product-withdraw-desc">슬라이더 금액을 선택하면 상품을 구성하는 각 풀이 비중대로 함께 감소합니다.</p>
              </div>
            </div>
            <div className="protocol-withdraw-slider-row product-withdraw-slider-row">
              <span className="protocol-withdraw-slider-label">$0</span>
              <input
                type="range"
                min={0}
                max={productWithdrawMaxUsd}
                step={Math.max(1, Math.round(productWithdrawMaxUsd / 100))}
                value={productWithdrawAmount}
                onChange={(event) => setProductWithdrawAmount(Number(event.target.value))}
                className="protocol-withdraw-slider"
                aria-label="상품 인출 금액"
                disabled={productWithdrawLoading}
              />
              <span className="protocol-withdraw-slider-label">${productWithdrawMaxUsd.toFixed(0)}</span>
              <strong className="protocol-withdraw-amount-badge">
                ${productWithdrawAmount.toFixed(2)}
                {productWithdrawMaxUsd > 0 ? <em>({((productWithdrawAmount / productWithdrawMaxUsd) * 100).toFixed(0)}%)</em> : null}
              </strong>
            </div>
            <div className="product-withdraw-preview">
              <div className="product-withdraw-preview-row product-withdraw-preview-row--head">
                <span>프로토콜</span>
                <span>풀</span>
                <span>비중</span>
                <span>감소액</span>
              </div>
              {productWithdrawPreview.map((item, idx) => (
                <div key={`${item.pool}-${idx}`} className="product-withdraw-preview-row">
                  <span>{item.protocol}</span>
                  <span>{item.pool}</span>
                  <span>{(item.weight * 100).toFixed(0)}%</span>
                  <strong>${item.amountUsd.toFixed(2)}</strong>
                </div>
              ))}
            </div>
            {canPersistToServer ? (
              <label className="exec-verify-label">
                비밀번호 확인
                <input
                  type="password"
                  className="exec-verify-input"
                  value={productWithdrawPassword}
                  onChange={(event) => setProductWithdrawPassword(event.target.value)}
                  disabled={productWithdrawLoading}
                  autoFocus
                  autoComplete="current-password"
                  onKeyDown={(event) => event.key === "Enter" && void confirmProductWithdraw()}
                />
              </label>
            ) : null}
            {productWithdrawError ? <p className="exec-verify-error">{productWithdrawError}</p> : null}
            <div className="exec-verify-actions">
              <button
                type="button"
                className="auth-primary-btn protocol-withdraw-confirm-btn"
                onClick={() => void confirmProductWithdraw()}
                disabled={productWithdrawLoading || productWithdrawAmount <= 0 || (canPersistToServer && !productWithdrawPassword)}
              >
                {productWithdrawLoading ? "처리 중…" : `$${productWithdrawAmount.toFixed(2)} 인출 확인`}
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  setProductWithdrawDraft(null);
                  setProductWithdrawPassword("");
                  setProductWithdrawError("");
                }}
                disabled={productWithdrawLoading}
              >
                취소
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TradePanel() {
  return (
    <section className="card">
      <p>우선 외부 DeFi를 사용해 토큰 교환을 진행합니다.</p>
      <div className="button-row">
        <button onClick={() => window.open("https://www.orca.so/pools", "_blank", "noopener,noreferrer")}>Orca 열기</button>
        <button onClick={() => window.open("https://app.uniswap.org/", "_blank", "noopener,noreferrer")}>Uniswap 열기</button>
      </div>
    </section>
  );
}

/**
 * 체인명 추출.
 * pool 레이블이 "Arbitrum · USDC Supply" 형식이면 앞부분에서 체인명을 먼저 파싱하고,
 * 없으면 프로토콜명으로 폴백한다.
 */
function inferProtocolChain(protocolName: string, poolLabel?: string): string {
  if (poolLabel) {
    // "Arbitrum · USDC Supply" → "Arbitrum"
    const chainPart = poolLabel.split("·")[0].trim().split("/")[0].trim();
    const lc = chainPart.toLowerCase();
    if (lc === "arbitrum" || lc.includes("arbitrum")) return "Arbitrum";
    if (lc === "base" || lc.includes("base")) return "Base";
    if (lc === "solana" || lc.includes("solana")) return "Solana";
    if (lc === "ethereum" || lc.includes("ethereum")) return "Ethereum";
    if (lc === "sol") return "Solana";
    if (lc === "eth") return "Ethereum";
  }
  // 프로토콜명 기반 폴백
  const key = protocolName.toLowerCase();
  if (key.includes("orca")) return "Solana";
  if (key.includes("aave")) return "Arbitrum";
  if (key.includes("uniswap")) return "Arbitrum";
  return "Multi";
}

function getProtocolSortRank(protocolName: string): number {
  const key = protocolName.toLowerCase();
  const rank = PROTOCOL_SORT_ORDER.findIndex((name) => key.includes(name.toLowerCase()));
  return rank === -1 ? PROTOCOL_SORT_ORDER.length : rank;
}

function PortfolioPanel({
  positions,
  onExecutionComplete,
  onWithdraw,
  onWithdrawTarget,
  canPersistToServer
}: {
  positions: DepositPosition[];
  onExecutionComplete?: () => void | Promise<void>;
  onWithdraw?: (amountUsd: number) => Promise<void>;
  onWithdrawTarget?: (amountUsd: number, target: Pick<ProtocolDetailRow, "name" | "chain" | "pool">) => Promise<void>;
  canPersistToServer?: boolean;
}) {
  const [protocolAmounts, setProtocolAmounts] = useState<Record<string, number>>({});
  const [protocolDepositDraft, setProtocolDepositDraft] = useState<ProtocolDetailRow | null>(null);
  const [protocolDepositKey, setProtocolDepositKey] = useState(0);
  const [showPositionDetails, setShowPositionDetails] = useState(false);

  // ── 인출 상태 ──────────────────────────────────────────────
  const [withdrawDraft, setWithdrawDraft] = useState<{ row: ProtocolDetailRow; maxUsd: number } | null>(null);
  /** 슬라이더 값 = 인출할 USD 금액 (0 ~ maxUsd) */
  const [withdrawAmtUsd, setWithdrawAmtUsd] = useState(0);
  const [withdrawVerifyPwd, setWithdrawVerifyPwd] = useState("");
  const [withdrawVerifyLoading, setWithdrawVerifyLoading] = useState(false);
  const [withdrawVerifyError, setWithdrawVerifyError] = useState("");
  const [withdrawDoneMsg, setWithdrawDoneMsg] = useState("");

  /** 슬라이더 값 그대로 사용 — 서버로 보내는 금액과 일치 */
  const withdrawAmount = Number(withdrawAmtUsd.toFixed(2));

  const onOpenWithdraw = (row: ProtocolDetailRow) => {
    const inputAmt = protocolAmounts[row.key] ?? 0;
    // 입력칸 금액이 유효하면 사용, 없으면 잔액 전체를 기본값으로
    const initAmt = inputAmt > 0 && inputAmt <= row.amount
      ? inputAmt
      : row.amount;
    setWithdrawDraft({ row, maxUsd: row.amount });
    setWithdrawAmtUsd(Number(initAmt.toFixed(2)));
    setWithdrawVerifyPwd("");
    setWithdrawVerifyError("");
    setWithdrawDoneMsg("");
  };

  const onConfirmWithdraw = async () => {
    if (!withdrawDraft || withdrawAmount <= 0) return;
    const session = getSession();
    if (!session) {
      setWithdrawVerifyError("세션이 만료되었습니다. 다시 로그인해 주세요.");
      return;
    }
    if (!withdrawVerifyPwd) {
      setWithdrawVerifyError("비밀번호를 입력하세요.");
      return;
    }
    setWithdrawVerifyLoading(true);
    setWithdrawVerifyError("");
    try {
      await login(session.username, withdrawVerifyPwd);
      await (onWithdrawTarget
        ? onWithdrawTarget(withdrawAmount, {
            name: withdrawDraft.row.name,
            chain: withdrawDraft.row.chain,
            pool: withdrawDraft.row.pool
          })
        : onWithdraw?.(withdrawAmount));
      const doneMsg = `$${withdrawAmount.toFixed(2)} 인출 처리 완료`;
      setWithdrawDraft(null);
      setWithdrawVerifyPwd("");
      setWithdrawDoneMsg(doneMsg);
      window.setTimeout(() => setWithdrawDoneMsg(""), 5000);
    } catch (error) {
      setWithdrawVerifyError(error instanceof Error ? error.message : "인출 확인 실패");
    } finally {
      setWithdrawVerifyLoading(false);
    }
  };
  const totalDeposited = positions.reduce((acc, item) => acc + item.amountUsd, 0);
  const protocolTotals = positions.reduce<Record<string, ProtocolDetailRow>>((acc, item) => {
    item.protocolMix.forEach((mix) => {
      const chain = inferProtocolChain(mix.name, mix.pool);
      const pool = mix.pool ?? `${chain} · ${mix.name}`;
      const key = `${mix.name}__${chain}__${pool}`;
      const prev = acc[key];
      acc[key] = {
        key,
        name: mix.name,
        chain,
        pool,
        amount: (prev?.amount ?? 0) + item.amountUsd * mix.weight
      };
    });
    return acc;
  }, {});
  const protocolRows = Object.values(protocolTotals).sort((a, b) => {
    const byProtocolRank = getProtocolSortRank(a.name) - getProtocolSortRank(b.name);
    if (byProtocolRank !== 0) return byProtocolRank;
    const byName = a.name.localeCompare(b.name, "ko-KR", { sensitivity: "base" });
    if (byName !== 0) return byName;
    const byChain = a.chain.localeCompare(b.chain, "ko-KR", { sensitivity: "base" });
    if (byChain !== 0) return byChain;
    return a.pool.localeCompare(b.pool, "ko-KR", { sensitivity: "base" });
  });
  const annualYield = estimateAnnualYieldUsd(positions);

  return (
    <section className="card portfolio-panel-card">
      <div className="portfolio-overview-hero">
        <div>
          <p className="section-eyebrow">Positions Overview</p>
          <h2>${totalDeposited.toLocaleString(undefined, { maximumFractionDigits: 2 })}</h2>
          <p>입금된 상품과 프로토콜 노출을 기준으로 운영 상태를 크게 보여줍니다.</p>
        </div>
        <div className="portfolio-overview-metrics">
          <div>
            <span>예치 건수</span>
            <strong>{positions.length}건</strong>
          </div>
          <div>
            <span>프로토콜 수</span>
            <strong>{new Set(protocolRows.map((row) => row.name)).size}개</strong>
          </div>
          <div>
            <span>추정 연 수익</span>
            <strong>${Math.round(annualYield).toLocaleString()}</strong>
          </div>
        </div>
        <ChainExposureDonut positions={positions} compact />
      </div>
      <h3>프로토콜별 예치 상세</h3>
      <table className="protocol-detail-table">
        <thead>
          <tr>
            <th>프로토콜</th>
            <th>체인</th>
            <th>풀</th>
            <th>예치 금액 (USD)</th>
            <th>비중</th>
            <th>입출금</th>
          </tr>
        </thead>
        <tbody>
          {protocolRows.map((row) => (
            <tr key={row.key}>
              <td>{row.name}</td>
              <td>{row.chain}</td>
              <td className="product-pool-pool-label">{row.pool}</td>
              <td>${row.amount.toFixed(2)}</td>
              <td>
                <span className="protocol-weight-cell">{totalDeposited > 0 ? ((row.amount / totalDeposited) * 100).toFixed(1) : "0.0"}%</span>
              </td>
              <td>
                <div className="protocol-inline-transfer">
                  <input
                    type="number"
                    min={1}
                    step={100}
                    value={protocolAmounts[row.key] ?? Math.max(100, Math.round(row.amount || 100))}
                    onChange={(event) =>
                      setProtocolAmounts((prev) => ({
                        ...prev,
                        [row.key]: Number(event.target.value)
                      }))
                    }
                    aria-label={`${row.name} ${row.chain} 입출금 금액`}
                  />
                  <TradeControls
                    onDeposit={() => {
                      const input = protocolAmounts[row.key] ?? Math.max(100, Math.round(row.amount || 100));
                      if (!Number.isFinite(input) || input <= 0) return;
                      setProtocolAmounts((prev) => ({ ...prev, [row.key]: input + 100 }));
                    }}
                    onWithdraw={() => {
                      const input = protocolAmounts[row.key] ?? Math.max(100, Math.round(row.amount || 100));
                      if (!Number.isFinite(input) || input <= 0) return;
                      setProtocolAmounts((prev) => ({ ...prev, [row.key]: Math.max(0, input - 100) }));
                    }}
                  />
                  <button
                    type="button"
                    className="protocol-deposit-action"
                    onClick={() => {
                      const input = protocolAmounts[row.key] ?? Math.max(100, Math.round(row.amount || 100));
                      if (!Number.isFinite(input) || input <= 0) return;
                      setProtocolDepositDraft({ ...row, amount: input });
                      setProtocolDepositKey((prev) => prev + 1);
                    }}
                    title="조정한 금액으로 입금 처리 팝업을 엽니다. 포지션은 내 계정 기준으로 기록됩니다."
                  >
                    입금
                  </button>
                  <button
                    type="button"
                    className="protocol-withdraw-action"
                    onClick={() => onOpenWithdraw(row)}
                    title="이 프로토콜에서 인출합니다."
                    disabled={!canPersistToServer || row.amount <= 0}
                  >
                    인출
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {protocolRows.length === 0 ? (
            <tr>
              <td colSpan={6}>아직 예치 내역이 없습니다.</td>
            </tr>
          ) : (
            <tr className="protocol-total-row">
              <td>합계</td>
              <td>—</td>
              <td>—</td>
              <td>${totalDeposited.toFixed(2)}</td>
              <td>
                <span className="protocol-weight-cell">{totalDeposited > 0 ? "100.0" : "0.0"}%</span>
              </td>
              <td>—</td>
            </tr>
          )}
        </tbody>
      </table>
      {/* ── 인출 확인 패널 ── */}
      {withdrawDraft ? (
        <div className="protocol-withdraw-confirm" role="dialog" aria-label="인출 확인">
          <p className="protocol-withdraw-confirm-title">
            💸 {withdrawDraft.row.name} · {withdrawDraft.row.chain} 인출
          </p>
          <p className="protocol-withdraw-confirm-desc">
            {withdrawDraft.row.pool} 현재 잔액 <strong>${withdrawDraft.maxUsd.toFixed(2)}</strong> — 슬라이더로 인출 금액을 조절하세요.
          </p>
          <div className="protocol-withdraw-slider-row">
            <span className="protocol-withdraw-slider-label">$0</span>
            <input
              type="range"
              min={0}
              max={withdrawDraft.maxUsd}
              step={Math.max(1, Math.round(withdrawDraft.maxUsd / 100))}
              value={withdrawAmtUsd}
              onChange={(e) => setWithdrawAmtUsd(Number(e.target.value))}
              className="protocol-withdraw-slider"
              aria-label="인출 금액"
              disabled={withdrawVerifyLoading}
            />
            <span className="protocol-withdraw-slider-label">${withdrawDraft.maxUsd.toFixed(0)}</span>
            <strong className="protocol-withdraw-amount-badge">
              ${withdrawAmount.toFixed(2)}
              {withdrawDraft.maxUsd > 0
                ? <em>({((withdrawAmount / withdrawDraft.maxUsd) * 100).toFixed(0)}%)</em>
                : null}
            </strong>
          </div>
          <label className="exec-verify-label">
            비밀번호 확인
            <input
              type="password"
              className="exec-verify-input"
              value={withdrawVerifyPwd}
              onChange={(e) => setWithdrawVerifyPwd(e.target.value)}
              disabled={withdrawVerifyLoading}
              autoFocus
              autoComplete="current-password"
              onKeyDown={(e) => e.key === "Enter" && void onConfirmWithdraw()}
            />
          </label>
          {withdrawVerifyError ? (
            <p className="exec-verify-error">{withdrawVerifyError}</p>
          ) : null}
          <div className="exec-verify-actions">
            <button
              type="button"
              className="auth-primary-btn protocol-withdraw-confirm-btn"
              onClick={() => void onConfirmWithdraw()}
              disabled={withdrawVerifyLoading || !withdrawVerifyPwd || withdrawAmount <= 0}
            >
              {withdrawVerifyLoading ? "처리 중…" : `$${withdrawAmount.toFixed(2)} 인출 확인`}
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setWithdrawDraft(null);
                setWithdrawVerifyPwd("");
                setWithdrawVerifyError("");
              }}
              disabled={withdrawVerifyLoading}
            >
              취소
            </button>
          </div>
        </div>
      ) : null}
      {withdrawDoneMsg ? (
        <p className="auth-message auth-message--ok protocol-withdraw-done">{withdrawDoneMsg}</p>
      ) : null}

      {protocolDepositDraft ? (
        <div className="modal-backdrop modal-backdrop--execution" role="dialog" aria-modal="true" aria-label="프로토콜 입금 처리 팝업">
          <div className="modal-card execution-modal-card deposit-execution-modal">
            <button type="button" className="modal-close-icon" aria-label="닫기" onClick={() => setProtocolDepositDraft(null)}>
              x
            </button>
            <div className="inline-execution-panel-head">
              <div>
                <p className="section-eyebrow">Protocol Deposit</p>
                <h3>
                  {protocolDepositDraft.name} · {protocolDepositDraft.chain} 입금 처리
                </h3>
              </div>
            </div>
            <OrchestratorBoard
              key={`${protocolDepositDraft.name}-${protocolDepositKey}`}
              initialDepositUsd={protocolDepositDraft.amount}
              initialProductName={`${protocolDepositDraft.name} ${protocolDepositDraft.chain} direct pool`}
              initialEstYieldUsd={protocolDepositDraft.amount * 0.08}
              initialEstFeeUsd={0}
              previewRowsOverride={[
                {
                  protocol: protocolDepositDraft.name,
                  chain: protocolDepositDraft.chain,
                  action: protocolDepositDraft.pool.replace(`${protocolDepositDraft.chain} · `, ""),
                  allocationUsd: protocolDepositDraft.amount
                }
              ]}
              onExecutionComplete={onExecutionComplete}
            />
          </div>
        </div>
      ) : null}
      <div className="position-detail-toggle-row">
        <button type="button" className="ghost-btn" onClick={() => setShowPositionDetails((prev) => !prev)} aria-expanded={showPositionDetails}>
          예치 건별 상세내역 {showPositionDetails ? "닫기" : "보기"}
        </button>
      </div>
      {showPositionDetails ? (
        <table>
          <thead>
            <tr>
              <th>상품</th>
              <th>예치 금액</th>
              <th>예상 APR</th>
              <th>프로토콜 믹스</th>
              <th>예치 시각</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => (
              <tr key={position.id}>
                <td>{position.productName}</td>
                <td>${position.amountUsd.toFixed(2)}</td>
                <td>{(position.expectedApr * 100).toFixed(2)}%</td>
                <td>{position.protocolMix.map((mix) => `${mix.name} ${(mix.weight * 100).toFixed(0)}%`).join(" / ")}</td>
                <td>{new Date(position.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {positions.length === 0 ? (
              <tr>
                <td colSpan={5}>아직 예치 내역이 없습니다.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function CommandCenterPage({
  positions,
  recentJobs,
  recentEvents,
  onGo,
  onOpenJob,
  onCancelJob
}: {
  positions: DepositPosition[];
  recentJobs: Job[];
  recentEvents: ExecutionEvent[];
  onGo: (menu: MenuKey) => void;
  onOpenJob: (jobId: string) => void;
  onCancelJob: (jobId: string) => void | Promise<void>;
}) {
  const [showPendingJobs, setShowPendingJobs] = useState(false);
  const pendingJobRows = recentJobs.filter((job) => job.status === "queued" || job.status === "blocked");
  const pendingJobs = pendingJobRows.length;
  const failedEvents = recentEvents.filter((event) => event.status === "failed").length;
  const executedJobs = recentJobs.filter((job) => job.status === "executed").length;

  return (
    <div className="page-shell command-page-shell">
      <section className="mission-hero card">
        <div>
          <p className="section-eyebrow">Dashboard</p>
          <h1>DeFi 자금 운용 상황판</h1>
          <p>
            예치, 리스크, 실행, 운영 로그를 한 화면에서 판단합니다. 상품 탐색보다 먼저 현재 포트폴리오가 안전한지와 오늘 조치할 항목을 보여줍니다.
          </p>
        </div>
        <div className="mission-action-stack">
          <button onClick={() => onGo("products")} title="Pools에서 상품을 선택하고 입금 금액을 조정합니다.">전략 검토</button>
          <button className="ghost-btn" onClick={() => onGo("execution")} title="입금 처리와 운영 이력을 확인합니다.">실행 보드</button>
        </div>
      </section>
      <div className="ops-status-rail">
        <button type="button" onClick={() => onGo("portfolio")} title="현재 포지션 상세 화면으로 이동합니다.">
          <span>Positions</span>
          <strong>{positions.length}</strong>
        </button>
        <button type="button" onClick={() => setShowPendingJobs((prev) => !prev)} title="대기 중인 Job 목록을 펼치고 필요 시 취소합니다.">
          <span>Pending Jobs</span>
          <strong>{pendingJobs}</strong>
        </button>
        <button type="button" onClick={() => onGo("operationsLog")} title="실패 이벤트 상세 운영 이력으로 이동합니다.">
          <span>Failures</span>
          <strong>{failedEvents}</strong>
        </button>
        <button type="button" onClick={() => onGo("execution")} title="실행 완료된 Job은 Execution 화면에서 운영 로그와 함께 확인합니다.">
          <span>Executed</span>
          <strong>{executedJobs}</strong>
        </button>
      </div>
      {showPendingJobs ? (
        <section className="card pending-jobs-panel">
          <div className="pending-jobs-head">
            <div>
              <p className="section-eyebrow">Pending Jobs</p>
              <h2>대기 중인 입금 작업</h2>
            </div>
            <button type="button" className="ghost-btn" onClick={() => onGo("execution")} title="Execution 화면에서 선택한 Job의 입금 처리를 이어갑니다.">
              실행 화면으로
            </button>
          </div>
          <div className="pending-jobs-list">
            {pendingJobRows.map((job) => (
              <div key={job.id} className="pending-job-row">
                <button type="button" onClick={() => onOpenJob(job.id)} title="이 Job을 Execution 화면에서 엽니다.">
                  <strong>Job {job.id.slice(-8)}</strong>
                  <span>{job.status} · ${job.input.depositUsd.toLocaleString()} · {job.riskLevel}</span>
                </button>
                <button type="button" className="ghost-btn pending-job-cancel" onClick={() => void onCancelJob(job.id)} title="아직 실행되지 않은 Job을 취소합니다.">
                  취소
                </button>
              </div>
            ))}
            {pendingJobRows.length === 0 ? <p className="recent-empty">대기 중인 Job이 없습니다.</p> : null}
          </div>
        </section>
      ) : null}
      <PortfolioCommandCenter positions={positions} onOpenExecution={() => onGo("execution")} />
    </div>
  );
}

function StrategiesPage({
  children,
  onOpenTrade,
  onOpenPortfolio
}: {
  children: ReactNode;
  onOpenTrade: () => void;
  onOpenPortfolio: () => void;
}) {
  return (
    <div className="page-shell strategy-page-shell">
      <section className="mission-hero mission-hero--strategy card">
        <div>
          <p className="section-eyebrow">Pools</p>
          <h1>수익 풀을 고르고, 실행 전 리스크를 비교합니다</h1>
          <p>
            Aave, Uniswap, Orca 배분을 상품 단위로 비교하고 APR, 수수료, 기간 수익, 표준 L2 배분안을 함께 검토합니다.
          </p>
        </div>
        <div className="mission-action-stack">
          <button onClick={onOpenPortfolio}>포지션 관제</button>
          <button className="ghost-btn" onClick={onOpenTrade}>외부 Swap</button>
        </div>
      </section>
      {children}
    </div>
  );
}

function PositionsPage({
  positions,
  onGo,
  onExecutionComplete,
  onWithdraw,
  onWithdrawTarget,
  canPersistToServer
}: {
  positions: DepositPosition[];
  onGo: (menu: MenuKey) => void;
  onExecutionComplete?: () => void | Promise<void>;
  onWithdraw?: (amountUsd: number) => Promise<void>;
  onWithdrawTarget?: (amountUsd: number, target: Pick<ProtocolDetailRow, "name" | "chain" | "pool">) => Promise<void>;
  canPersistToServer?: boolean;
}) {
  return (
    <div className="page-shell positions-page-shell">
      <section className="mission-hero mission-hero--positions card">
        <div>
          <p className="section-eyebrow">Positions</p>
          <h1>포지션 및 프로토콜별 노출을 관리합니다</h1>
          <p>
            체인·프로토콜별 노출과 예치 건별 상세를 확인합니다.
          </p>
        </div>
        <div className="mission-action-stack">
          <button onClick={() => onGo("products")}>추가 예치</button>
          <button className="ghost-btn" onClick={() => onGo("execution")}>리밸런싱 실행</button>
        </div>
      </section>
      <PortfolioPanel
        positions={positions}
        onExecutionComplete={onExecutionComplete}
        onWithdraw={onWithdraw}
        onWithdrawTarget={onWithdrawTarget}
        canPersistToServer={canPersistToServer}
      />
    </div>
  );
}

function ExecutionPage({
  hasSession,
  recentJobs,
  recentEvents,
  focusJobId,
  onOpenJob,
  onOpenEvent,
  onExecutionComplete
}: {
  hasSession: boolean;
  recentJobs: Job[];
  recentEvents: ExecutionEvent[];
  focusJobId?: string;
  onOpenJob: (jobId: string) => void;
  onOpenEvent: (jobId: string) => void;
  onExecutionComplete?: () => void | Promise<void>;
}) {
  return (
    <div className="page-shell execution-page-shell">
      <section className="mission-hero mission-hero--execution card">
        <div>
          <p className="section-eyebrow">Execution</p>
          <h1>내 입금 실행, 서명, dry-run, 감사 로그를 한 흐름으로 추적합니다</h1>
          <p>
            실행은 계획, 본인 확인, 서명, 제출, 확인, 기록으로 나뉩니다. 실패와 재실행은 운영 이력에서 추적합니다.
          </p>
        </div>
      </section>
      <div className="page-grid-two page-grid-two--execution execution-primary-grid">
        <OrchestratorBoard allowJobExecution={hasSession} onExecutionComplete={onExecutionComplete} />
      </div>
      <OperationsHistoryPanel
        focusJobId={focusJobId}
        recentJobs={recentJobs}
        recentEvents={recentEvents}
        onOpenJob={onOpenJob}
        onOpenEvent={onOpenEvent}
      />
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(getSession());
  const [theme, setTheme] = useState<"dark" | "light">("dark");
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

  const canPersistPortfolio = Boolean(session);
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
          <PositionsPage
            positions={positions}
            onGo={onSelectMenu}
            onWithdraw={handleWithdrawPosition}
            onWithdrawTarget={handleWithdrawProtocolExposure}
            canPersistToServer={canPersistPortfolio}
            onExecutionComplete={async () => {
              await refreshPositions();
              await refreshWithdrawLedgerFromServer();
            }}
          />
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
