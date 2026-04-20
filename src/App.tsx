import { useEffect, useMemo, useState } from "react";
import { AuthPanel } from "./components/AuthPanel";
import { SignupRegistrationsPanel } from "./components/SignupRegistrationsPanel";
import { DepositPlanner } from "./components/DepositPlanner";
import { MarketAprTimeSeriesChart } from "./components/MarketAprTimeSeriesChart";
import { UnifiedOperationsSearch } from "./components/UnifiedOperationsSearch";
import { OrchestratorBoard } from "./components/OrchestratorBoard";
import { WalletPanel, type WalletWithdrawLedgerLine } from "./components/WalletPanel";
import { AgentConsensusPanel } from "./components/insights/AgentConsensusPanel";
import { ConsultantInsightsPanel } from "./components/insights/ConsultantInsightsPanel";
import { ChainExposureDonut } from "./components/common/ChainExposureDonut";
import { TradeControls } from "./components/common/TradeControls";
import { TradePanel } from "./components/common/TradePanel";
import { RecentActivityPanel } from "./components/activity/RecentActivityPanel";
import { OperationsHistoryPanel } from "./components/activity/OperationsHistoryPanel";
import { CommandCenterPage } from "./pages/CommandCenterPage";
import { StrategiesPage } from "./pages/StrategiesPage";
import { PositionsPage } from "./pages/PositionsPage";
import { ExecutionPage } from "./pages/ExecutionPage";
import {
  AUTH_CLEARED_EVENT,
  cancelJob,
  fetchMarketAprSnapshot,
  fetchPoolApyHistoryFromCsv,
  getSession,
  getWhitepaperPdfUrl,
  listExecutionEvents,
  listJobs,
  login,
  type AuthSession,
  type ExecutionEvent,
  type Job,
  type MarketAprSnapshot,
  type MarketPoolAprHistoryPoint,
  type MarketPoolAprHistorySeries
} from "./lib/api";
import { estimateAnnualYieldUsd } from "./lib/portfolioMetrics";
import { getNextQuarterStart } from "./lib/quarterSchedule";
import type { ExecutionPreviewRow } from "./lib/executionPreview";
import {
  DEFAULT_PRODUCTS,
  PRODUCT_NETWORK_GROUPS,
  PRODUCT_NETWORK_LABELS,
  aprDecimalToSimpleWeekYieldPercentPoints,
  buildDefaultProductMix,
  mixItemAnnualAprDecimal,
  networkGroupToDefaultSubtype,
  networkGroupToProductNetwork,
  type YieldProduct
} from "./lib/productCatalog";
import { getProtocolSortRank, inferProtocolChain } from "./lib/protocolChain";
import {
  GUEST_WITHDRAW_LEDGER_KEY,
  MARKET_APR_REFRESH_MS,
  WITHDRAW_DONE_TOAST_MS
} from "./lib/constants";
import {
  MENU_ITEMS,
  PRIMARY_NAV_LABEL,
  PRIMARY_NAV_ORDER,
  type MenuKey,
  type TopNavGroupKey
} from "./lib/menu";
import type { DepositPosition, ProtocolDetailRow } from "./types/portfolio";
import { usePortfolio, type PortfolioNotice } from "./hooks/usePortfolio";

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
  onActionNotice?: (notice: PortfolioNotice) => void;
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
    const timer = window.setInterval(() => void loadAprAndHistory(), MARKET_APR_REFRESH_MS);
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

  const [withdrawDraft, setWithdrawDraft] = useState<{ row: ProtocolDetailRow; maxUsd: number } | null>(null);
  const [withdrawAmtUsd, setWithdrawAmtUsd] = useState(0);
  const [withdrawVerifyPwd, setWithdrawVerifyPwd] = useState("");
  const [withdrawVerifyLoading, setWithdrawVerifyLoading] = useState(false);
  const [withdrawVerifyError, setWithdrawVerifyError] = useState("");
  const [withdrawDoneMsg, setWithdrawDoneMsg] = useState("");

  const withdrawAmount = Number(withdrawAmtUsd.toFixed(2));

  const onOpenWithdraw = (row: ProtocolDetailRow) => {
    const inputAmt = protocolAmounts[row.key] ?? 0;
    const initAmt = inputAmt > 0 && inputAmt <= row.amount ? inputAmt : row.amount;
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
      window.setTimeout(() => setWithdrawDoneMsg(""), WITHDRAW_DONE_TOAST_MS);
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

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(getSession());
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

  const {
    positions,
    setPositions,
    withdrawLedger,
    setWithdrawLedger,
    portfolioNotice,
    setPortfolioNotice,
    canPersistPortfolio,
    portfolioTotalUsd,
    refreshPositions,
    refreshWithdrawLedgerFromServer,
    handleWithdrawPosition,
    handleWithdrawProtocolExposure,
    handleWithdrawProductDeposit
  } = usePortfolio(session);

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
      await Promise.all([refreshPositions(), refreshWithdrawLedgerFromServer()]);
    };
    void loadRecent();
    return () => controller.abort();
  }, [session, refreshPositions, refreshWithdrawLedgerFromServer, setPositions, setWithdrawLedger]);

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
        return <AuthPanel onSessionChange={setSession} />;
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
          <PositionsPage onGo={onSelectMenu}>
            <PortfolioPanel
              positions={positions}
              onWithdraw={handleWithdrawPosition}
              onWithdrawTarget={handleWithdrawProtocolExposure}
              canPersistToServer={canPersistPortfolio}
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
