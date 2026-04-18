import { useEffect, useMemo, useState } from "react";
import { ApprovalsDashboard } from "./components/ApprovalsDashboard";
import { AuthPanel } from "./components/AuthPanel";
import { SignupRegistrationsPanel } from "./components/SignupRegistrationsPanel";
import { DepositPlanner } from "./components/DepositPlanner";
import { MarketAprTimeSeriesChart } from "./components/MarketAprTimeSeriesChart";
import { PortfolioCommandCenter } from "./components/PortfolioCommandCenter";
import { ProductPoolYieldChart } from "./components/ProductPoolYieldChart";
import { ExecutionEventsDashboard } from "./components/ExecutionEventsDashboard";
import { UnifiedOperationsSearch } from "./components/UnifiedOperationsSearch";
import { OrchestratorBoard } from "./components/OrchestratorBoard";
import { WalletPanel, type WalletWithdrawLedgerLine } from "./components/WalletPanel";
import {
  AUTH_CLEARED_EVENT,
  createDepositPositionRemote,
  fetchDailyApyHistoryFromCsv,
  fetchMarketAprSnapshot,
  fetchProtocolNews,
  type ProtocolNewsBundle,
  getSession,
  getWhitepaperPdfUrl,
  listDepositPositions,
  listExecutionEvents,
  listJobs,
  listWithdrawalLedger,
  withdrawDepositRemote,
  type AuthSession,
  type DepositPositionPayload,
  type ExecutionEvent,
  type Job,
  type MarketAprHistoryPoint,
  type MarketAprSnapshot
} from "./lib/api";
import { aggregateChainUsdFromPositions, estimateAnnualYieldUsd } from "./lib/portfolioMetrics";
import { getNextQuarterStart } from "./lib/quarterSchedule";
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
  targetApr: number;
  estFeeBps: number;
  lockDays: number;
  protocolMix: Array<{ name: string; weight: number; pool?: string }>;
  detail: string;
};
type DepositPosition = DepositPositionPayload;

const GUEST_WITHDRAW_LEDGER_KEY = "crypto8_withdraw___guest__";

const PRIMARY_NAV_ORDER: MenuKey[] = ["products", "trade", "portfolio"];
const PRIMARY_NAV_LABEL: Partial<Record<MenuKey, string>> = {
  products: "예치",
  trade: "트레이드",
  portfolio: "포트폴리오"
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

function PortfolioOverviewPanel({ positions }: { positions: DepositPosition[] }) {
  const circumference = 2 * Math.PI * 46;
  const { totalUsd, annualEst, useLiveChains, chainUsd, chartData, donutSegments } = useMemo(() => {
    const total = positions.reduce((acc, p) => acc + p.amountUsd, 0);
    const est = estimateAnnualYieldUsd(positions);
    const cUsd = aggregateChainUsdFromPositions(positions);
    const cTotal = Object.values(cUsd).reduce((a, b) => a + b, 0);
    const templateWeights = OPTION_L2_STAR.reduce<Record<string, number>>((acc, item) => {
      if (item.chain === "Multi") return acc;
      acc[item.chain] = (acc[item.chain] ?? 0) + item.targetWeight;
      return acc;
    }, {});
    const live = positions.length > 0 && cTotal > 0;
    const chart = live
      ? Object.entries(cUsd)
          .filter(([, usd]) => usd > 0)
          .map(([chain, usd]) => ({ chain, weight: usd / cTotal }))
          .sort((a, b) => b.weight - a.weight)
      : Object.entries(templateWeights).map(([chain, weight]) => ({ chain, weight }));
    let acc = 0;
    const c = circumference;
    const segments = chart.map((item, idx) => {
      const dash = c * item.weight;
      const offset = c * (1 - acc);
      acc += item.weight;
      return { chain: item.chain, dash, offset, color: PORTFOLIO_DONUT_COLORS[idx % PORTFOLIO_DONUT_COLORS.length] };
    });
    return { totalUsd: total, annualEst: est, useLiveChains: live, chainUsd: cUsd, chartData: chart, donutSegments: segments };
  }, [positions]);

  return (
    <section className="card">
      <h2>Portfolio Overview</h2>
      <div className="overview-grid">
        <div className="overview-card">
          {positions.length > 0 ? (
            <>
              <p className="kpi-label">총 예치 (명목)</p>
              <p className="kpi-value">${totalUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
              <p className="kpi-label">추정 연 수익 (상품 목표 APR 기준)</p>
              <p className="kpi-value">${annualEst.toFixed(2)}</p>
              <p className="portfolio-overview-footnote">실현 손익·수수료는 온체인 정산·거래소 데이터 연동 후 표시 예정입니다.</p>
            </>
          ) : (
            <>
              <p className="kpi-label">예치 내역</p>
              <p className="kpi-value">없음</p>
              <p className="portfolio-overview-footnote">예치상품에서 입금하면 이곳에 총액·추정 연 수익이 집계됩니다.</p>
            </>
          )}
        </div>
        <div className="overview-card overview-card--donut">
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
                  strokeDasharray={`${seg.dash} ${circumference}`}
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
      </div>
    </section>
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

function OperationsHistoryPanel({ focusJobId }: { focusJobId?: string }) {
  return (
    <section className="card">
      <h2>운영 이력</h2>
      <p>승인 로그와 실행 이벤트를 한 화면에서 연속으로 확인합니다.</p>
      <ApprovalsDashboard focusJobId={focusJobId} />
      <ExecutionEventsDashboard focusJobId={focusJobId} />
    </section>
  );
}

function MyOverviewPanel({
  recentJobs,
  recentEvents,
  onGo
}: {
  recentJobs: Job[];
  recentEvents: ExecutionEvent[];
  onGo: (menu: MenuKey) => void;
}) {
  const [tab, setTab] = useState<"asset" | "deposit" | "yield" | "withdraw">("asset");
  const executed = recentJobs.filter((job) => job.status === "executed").length;
  const pending = recentJobs.filter((job) => job.status !== "executed").length;
  const failed = recentEvents.filter((event) => event.status === "failed").length;

  return (
    <section className="card">
      <h2>내 현황</h2>
      <div className="my-tabs">
        <button className={tab === "asset" ? "nav-item active" : "nav-item"} onClick={() => setTab("asset")}>
          내 자산
        </button>
        <button className={tab === "deposit" ? "nav-item active" : "nav-item"} onClick={() => setTab("deposit")}>
          내 예치
        </button>
        <button className={tab === "yield" ? "nav-item active" : "nav-item"} onClick={() => setTab("yield")}>
          내 수익
        </button>
        <button className={tab === "withdraw" ? "nav-item active" : "nav-item"} onClick={() => setTab("withdraw")}>
          내 인출
        </button>
      </div>
      {tab === "asset" ? (
        <div className="kpi-grid">
          <div className="kpi-item">
            <p className="kpi-label">연결 자산 개요</p>
            <p className="kpi-value">지갑 위젯에서 SOL/USDC 확인</p>
            <button onClick={() => onGo("wallet")}>지갑/자산 보기</button>
          </div>
          <div className="kpi-item">
            <p className="kpi-label">내 작업 상태</p>
            <p className="kpi-value">완료 {executed} / 대기 {pending} / 실패 {failed}</p>
          </div>
        </div>
      ) : null}
      {tab === "deposit" ? (
        <div className="kpi-grid">
          <div className="kpi-item">
            <p className="kpi-label">예치 전 점검</p>
            <p className="kpi-value">예상 수익/수수료/배분 확인</p>
            <button onClick={() => onGo("products")}>예치상품에서 확인</button>
          </div>
          <div className="kpi-item">
            <p className="kpi-label">예치 실행</p>
            <p className="kpi-value">승인 후 예치 실행 진행</p>
            <button onClick={() => onGo("execution")}>예치 실행으로 이동</button>
          </div>
        </div>
      ) : null}
      {tab === "yield" ? (
        <div className="kpi-grid">
          <div className="kpi-item">
            <p className="kpi-label">수익/운영 이력</p>
            <p className="kpi-value">승인 로그 + 실행 이벤트 통합</p>
            <button onClick={() => onGo("operationsLog")}>수익/운영 이력 보기</button>
          </div>
        </div>
      ) : null}
      {tab === "withdraw" ? (
        <div className="kpi-grid">
          <div className="kpi-item">
            <p className="kpi-label">인출 준비</p>
            <p className="kpi-value">인출 수수료/수령액 시뮬레이션</p>
            <button onClick={() => onGo("execution")}>인출 시뮬레이션으로 이동</button>
          </div>
        </div>
      ) : null}
    </section>
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

const APR_DAYS_PER_YEAR = 365;

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
    id: "p-8",
    name: "Stable Yield 8%",
    targetApr: 0.08,
    estFeeBps: 65,
    lockDays: 30,
    protocolMix: [
      { name: "Aave", weight: 0.45, pool: "Aave v3 Arbitrum USDC eMode" },
      { name: "Uniswap", weight: 0.35, pool: "Uniswap v3 Arbitrum USDC-USDT 0.05%" },
      { name: "Orca", weight: 0.2, pool: "Orca Whirlpools SOL-USDC" }
    ],
    detail: "초기 전략 문서 기반 기본 상품. 안정성 중심 분산 예치."
  },
  {
    id: "p-72",
    name: "Balanced Yield 7.2%",
    targetApr: 0.072,
    estFeeBps: 58,
    lockDays: 21,
    protocolMix: [
      { name: "Aave", weight: 0.5, pool: "Aave v3 Base USDC eMode" },
      { name: "Uniswap", weight: 0.3, pool: "Uniswap v3 Arbitrum ETH-USDC 0.05% (±50%)" },
      { name: "Orca", weight: 0.2, pool: "Orca Whirlpools mSOL-SOL" }
    ],
    detail: "변동성 완화를 우선한 중립형 예치상품."
  }
];

function ProductsPanel({
  positions,
  hasSession,
  canPersistToServer,
  onDepositRecorded,
  onWithdraw,
  onActionNotice,
  onOpenOperationsWithJob
}: {
  positions: DepositPosition[];
  hasSession: boolean;
  canPersistToServer: boolean;
  onDepositRecorded: (position: DepositPosition) => Promise<DepositPosition>;
  onWithdraw: (amountUsd: number) => void | Promise<void>;
  onActionNotice?: (notice: { variant: "error" | "info"; text: string }) => void;
  onOpenOperationsWithJob?: (jobId: string) => void;
}) {
  const [products, setProducts] = useState<YieldProduct[]>(DEFAULT_PRODUCTS);
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_PRODUCTS[0].id);
  const [depositAmount, setDepositAmount] = useState(1000);
  const [newName, setNewName] = useState("");
  const [newApr, setNewApr] = useState("0.07");
  const [isAddFormOpen, setIsAddFormOpen] = useState(false);
  const [isExecutionOpen, setIsExecutionOpen] = useState(false);
  const userDepositedUsd = positions.reduce((acc, p) => acc + p.amountUsd, 0);
  const [simulationDays, setSimulationDays] = useState(30);
  const [marketApr, setMarketApr] = useState<MarketAprSnapshot | null>(null);
  const [aprError, setAprError] = useState("");
  const [linkedPositionId, setLinkedPositionId] = useState<string | null>(null);
  const [showStandardL2Allocation, setShowStandardL2Allocation] = useState(false);
  const [marketHistoryPoints, setMarketHistoryPoints] = useState<MarketAprHistoryPoint[]>([]);
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
  const selected = products.find((item) => item.id === selectedId) ?? products[0];
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

  const poolChartRows = useMemo(
    () =>
      selected.protocolMix.map((item, mixIdx) => ({
        key: `${item.name}-${mixIdx}`,
        label: item.name,
        weekYieldPercentPoints:
          marketApr != null
            ? aprDecimalToSimpleWeekYieldPercentPoints(mixItemAnnualAprDecimal(item.name, marketApr))
            : null
      })),
    [marketApr, selected.protocolMix]
  );

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
        const hist = await fetchDailyApyHistoryFromCsv({ days: historyCsvDays });
        if (!cancelled) {
          setMarketHistoryPoints(hist.points);
        }
      } catch {
        if (!cancelled) setMarketHistoryPoints([]);
      }
    };
    void loadAprAndHistory();
    const timer = window.setInterval(() => void loadAprAndHistory(), 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [historyCsvDays]);

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
                    protocolMix: [
                      { name: "Aave", weight: 0.34, pool: "Aave v3 Arbitrum USDC eMode" },
                      { name: "Uniswap", weight: 0.33, pool: "Uniswap v3 Arbitrum USDC-USDT 0.05%" },
                      { name: "Orca", weight: 0.33, pool: "Orca Whirlpools SOL-USDC" }
                    ],
                    detail: "사용자 정의 예치상품"
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
      <div className="kpi-grid product-list-grid">
        {products.map((product) => (
          <div
            key={product.id}
            className={selectedId === product.id ? "kpi-item product-card product-card--selected" : "kpi-item product-card"}
          >
            <button className={selectedId === product.id ? "nav-item active" : "nav-item"} onClick={() => setSelectedId(product.id)}>
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
        <div className="product-action-row">
          <span className="product-action-label">금액</span>
          <input type="number" value={depositAmount} min={100} step={100} onChange={(e) => setDepositAmount(Number(e.target.value))} />
          <div className="button-row product-action-buttons">
            <button
              type="button"
              className="product-action-btn btn-primary"
              onClick={() => {
                void (async () => {
                  const draft: DepositPosition = {
                    id: `dep_${Date.now()}`,
                    productName: selected.name,
                    amountUsd: depositAmount,
                    expectedApr: selected.targetApr,
                    protocolMix: selected.protocolMix,
                    createdAt: new Date().toISOString()
                  };
                  try {
                    const recorded = await onDepositRecorded(draft);
                    setLinkedPositionId(recorded.id);
                    setIsExecutionOpen(true);
                  } catch {
                    /* onDepositRecorded에서 알림 처리 */
                  }
                })();
              }}
            >
              입금
            </button>
            <button type="button" className="product-action-btn" onClick={() => void onWithdraw(depositAmount)}>
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
          <ProductPoolYieldChart rows={poolChartRows} blendedWeekPercentPoints={blendedWeekYieldPercentPoints} />
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
            protocolMix={selected.protocolMix}
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
        <div className="modal-backdrop modal-backdrop--execution" role="dialog" aria-modal="true">
          <div className="modal-card execution-modal-card">
            <button
              className="modal-close-icon"
              aria-label="닫기"
              onClick={() => {
                setIsExecutionOpen(false);
                setLinkedPositionId(null);
              }}
            >
              ✕
            </button>
            <OrchestratorBoard
              initialDepositUsd={depositAmount}
              initialProductName={selected.name}
              initialEstYieldUsd={estYield}
              initialEstFeeUsd={estFee}
              allowJobExecution={canPersistToServer}
              linkedPositionId={linkedPositionId ?? undefined}
              onActionNotice={onActionNotice}
              onOpenOperationsWithJob={onOpenOperationsWithJob}
            />
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

function PortfolioPanel({ positions }: { positions: DepositPosition[] }) {
  const totalDeposited = positions.reduce((acc, item) => acc + item.amountUsd, 0);
  const protocolTotals = positions.reduce<Record<string, number>>((acc, item) => {
    item.protocolMix.forEach((mix) => {
      acc[mix.name] = (acc[mix.name] ?? 0) + item.amountUsd * mix.weight;
    });
    return acc;
  }, {});

  return (
    <section className="card">
      <div className="kpi-grid">
        <div className="kpi-item">
          <p className="kpi-label">총 예치 금액</p>
          <p className="kpi-value">${totalDeposited.toFixed(2)}</p>
        </div>
        <div className="kpi-item">
          <p className="kpi-label">예치 건수</p>
          <p className="kpi-value">{positions.length}건</p>
        </div>
        <div className="kpi-item">
          <p className="kpi-label">프로토콜 수</p>
          <p className="kpi-value">{Object.keys(protocolTotals).length}개</p>
        </div>
      </div>
      <h3>프로토콜별 예치 상세</h3>
      <table>
        <thead>
          <tr>
            <th>프로토콜</th>
            <th>예치 금액 (USD)</th>
            <th>비중</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(protocolTotals).map(([name, amount]) => (
            <tr key={name}>
              <td>{name}</td>
              <td>${amount.toFixed(2)}</td>
              <td>{totalDeposited > 0 ? ((amount / totalDeposited) * 100).toFixed(1) : "0.0"}%</td>
            </tr>
          ))}
          {Object.keys(protocolTotals).length === 0 ? (
            <tr>
              <td colSpan={3}>아직 예치 내역이 없습니다.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <h3>예치 건별 상세</h3>
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
    </section>
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

  const handleDepositPosition = async (position: DepositPosition): Promise<DepositPosition> => {
    setPortfolioNotice(null);
    try {
      if (canPersistPortfolio) {
        const saved = await createDepositPositionRemote({
          productName: position.productName,
          amountUsd: position.amountUsd,
          expectedApr: position.expectedApr,
          protocolMix: position.protocolMix
        });
        await refreshPositions();
        return saved;
      }
      setPositions((prev) => [position, ...prev]);
      return position;
    } catch (err) {
      setPortfolioNotice({
        variant: "error",
        text: err instanceof Error ? err.message : "예치 저장에 실패했습니다."
      });
      throw err;
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
      try {
        const [jobs, events, depositRows, wdRows] = await Promise.all([
          listJobs(),
          listExecutionEvents(),
          listDepositPositions(),
          listWithdrawalLedger().catch(() => [] as WalletWithdrawLedgerLine[])
        ]);
        setRecentJobs(jobs.slice(0, 6));
        setRecentEvents(events.slice(0, 6));
        setPositions(depositRows);
        setWithdrawLedger(wdRows);
      } catch (_error) {
        setRecentJobs([]);
        setRecentEvents([]);
        setPositions([]);
        setWithdrawLedger([]);
      }
    };
    void loadRecent();
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
        return <AuthPanel onSessionChange={setSession} />;
      case "my":
        return <MyOverviewPanel recentJobs={recentJobs} recentEvents={recentEvents} onGo={onSelectMenu} />;
      case "products":
        return (
          <ProductsPanel
            positions={positions}
            hasSession={Boolean(session)}
            canPersistToServer={canPersistPortfolio}
            onDepositRecorded={handleDepositPosition}
            onWithdraw={handleWithdrawPosition}
            onActionNotice={setPortfolioNotice}
            onOpenOperationsWithJob={(jobId) => {
              setFocusJobId(jobId);
              setActiveMenu("operationsLog");
              setOpenTopMenu(null);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          />
        );
      case "trade":
        return <TradePanel />;
      case "portfolio":
        return (
          <>
            <PortfolioCommandCenter positions={positions} onOpenExecution={() => onSelectMenu("execution")} />
            <PortfolioOverviewPanel positions={positions} />
            <PortfolioPanel positions={positions} />
          </>
        );
      case "wallet":
        return (
          <WalletPanel
            positions={positions}
            withdrawLedger={withdrawLedger}
            portfolioUsd={portfolioTotalUsd}
            onOpenMyOverview={() => onSelectMenu("my")}
            onOpenPortfolio={() => onSelectMenu("portfolio")}
            onOpenActivity={() => onSelectMenu("activity")}
          />
        );
      case "execution":
        return <OrchestratorBoard allowJobExecution={Boolean(session)} />;
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
        return <MyOverviewPanel recentJobs={recentJobs} recentEvents={recentEvents} onGo={onSelectMenu} />;
    }
  };

  const onSelectMenu = (menu: MenuKey) => {
    setActiveMenu(menu);
    setOpenTopMenu(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /** 상단 주요 메뉴: 예치 · 트레이드 · 포트폴리오 (역할에 없는 항목은 숨김) */
  const mainMenuKeys: MenuKey[] = [...PRIMARY_NAV_ORDER];
  const operatorMenuKeys: MenuKey[] = ["signupHistory", "auth", "consultant", "consensus"];
  const historyMenuKeys: MenuKey[] = ["activity"];
  /** More에 넣지 않음: 지갑·내 현황·예치 실행·운영 이력은 다른 진입점(헤더/검색/딥링크)으로만 이동 */
  const hiddenFromMoreKeys: MenuKey[] = ["wallet", "my", "execution", "operationsLog"];
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
      {session ? (
        <div className="quarter-banner" role="status">
          <span className="quarter-banner-label">분기 점검</span>
          <span className="quarter-banner-text">
            리밸런싱·가드레일 점검 제안일: <strong>{nextQuarterLabel}</strong> (전략 문서 기준 분기 1회)
          </span>
        </div>
      ) : null}
      <div className="app-layout app-layout-top-nav">
        <section className="content-pane content-center-pane">{renderContent()}</section>
      </div>
    </main>
  );
}
