import { useEffect, useMemo, useState } from "react";
import {
  fetchMarketAprSnapshot,
  fetchPoolApyHistoryFromCsv,
  getSession,
  login,
  type MarketAprSnapshot,
  type MarketPoolAprHistoryPoint,
  type MarketPoolAprHistorySeries
} from "../lib/api";
import type { ExecutionPreviewRow } from "../lib/executionPreview";
import {
  DEFAULT_PRODUCTS,
  PRODUCT_NETWORK_GROUPS,
  PRODUCT_NETWORK_LABELS,
  buildDefaultProductMix,
  displayProductName,
  mixItemAnnualAprDecimal,
  networkGroupToDefaultSubtype,
  networkGroupToProductNetwork,
  aprDecimalToSimpleWeekYieldPercentPoints,
  type YieldProduct
} from "../lib/productCatalog";
import { inferProtocolChain } from "../lib/protocolChain";
import { resolveOrcaPoolCandidatesForAction } from "../lib/orcaPools";
import { DepositPlanner } from "./DepositPlanner";
import { MarketAprTimeSeriesChart } from "./MarketAprTimeSeriesChart";
import { OrchestratorBoard } from "./OrchestratorBoard";
import type { DepositPosition, PoolLiveState } from "../types/portfolio";

export function ProductsPanel({
  positions,
  hasSession,
  canPersistToServer,
  isWalletConnected,
  onWithdraw,
  onWithdrawProduct,
  onActionNotice,
  onOpenOperationsWithJob,
  onExecutionComplete
}: {
  positions: DepositPosition[];
  hasSession: boolean;
  canPersistToServer: boolean;
  isWalletConnected?: boolean;
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
  const [poolLiveMap, setPoolLiveMap] = useState<Record<string, PoolLiveState>>({});
  const [productLiveMap, setProductLiveMap] = useState<Record<string, boolean>>({});
  const [visiblePoolAprByLabel, setVisiblePoolAprByLabel] = useState<Record<string, number>>({});
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
  const orcaActionFromPoolLabel = (poolLabel: string): string | null => {
    const normalized = poolLabel.replace(/^Orca Whirlpools\s*/i, "").trim().toLowerCase();
    if (normalized.includes("usdc-usdt")) return "USDC-USDT Whirlpool (0.01%)";
    if (normalized.includes("sol-usdc")) return "SOL-USDC Whirlpool";
    if (normalized.includes("msol-sol")) return "mSOL-SOL Whirlpool";
    return null;
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
  const latestPoolAprByLabel = useMemo(() => {
    const out: Record<string, number> = {};
    const keyByLabel = new Map(marketHistorySeries.map((series) => [series.poolLabel, series.key]));
    keyByLabel.forEach((key, poolLabel) => {
      for (let i = marketHistoryPoints.length - 1; i >= 0; i -= 1) {
        const point = marketHistoryPoints[i];
        const value = point?.pools?.[key];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          out[poolLabel] = value;
          break;
        }
      }
    });
    return out;
  }, [marketHistoryPoints, marketHistorySeries]);
  const selectedHistoryBlendAnnualAprDecimal = useMemo(() => {
    const latest = marketHistoryPoints[marketHistoryPoints.length - 1];
    if (!latest) return null;
    const activeSeries = marketHistorySeries.filter((series) => (selectedPoolWeights[series.key] ?? 0) > 0);
    if (activeSeries.length === 0) return null;
    return activeSeries.reduce((acc, series) => acc + ((latest.pools[series.key] ?? 0) * (selectedPoolWeights[series.key] ?? 0)), 0);
  }, [marketHistoryPoints, marketHistorySeries, selectedPoolWeights]);
  const selectedMixAprDecimals = useMemo(
    () =>
      selected.protocolMix.map((item, idx) => {
        const poolLabel = selectedPoolLabels[idx] ?? resolvePoolLabel(item.name, item.pool);
        const poolApr = latestPoolAprByLabel[poolLabel];
        if (typeof poolApr === "number" && Number.isFinite(poolApr) && poolApr > 0) {
          return poolApr;
        }
        if (!marketApr) return null;
        return mixItemAnnualAprDecimal(item.name, marketApr);
      }),
    [latestPoolAprByLabel, marketApr, selected.protocolMix, selectedPoolLabels]
  );
  const estYield = depositAmount * selected.targetApr;
  const estFee = (depositAmount * selected.estFeeBps) / 10_000;
  const blendedAnnualAprDecimal = useMemo(() => {
    if (selectedHistoryBlendAnnualAprDecimal != null) {
      return selectedHistoryBlendAnnualAprDecimal;
    }
    let weighted = 0;
    let hasAny = false;
    selected.protocolMix.forEach((item, idx) => {
      const aprDec = selectedMixAprDecimals[idx];
      if (aprDec == null) return;
      hasAny = true;
      weighted += aprDec * item.weight;
    });
    return hasAny ? weighted : null;
  }, [selected.protocolMix, selectedHistoryBlendAnnualAprDecimal, selectedMixAprDecimals]);
  const dailyRate = (blendedAnnualAprDecimal ?? selected.targetApr) / 365;
  const periodYield = depositAmount * dailyRate * simulationDays;

  const blendedWeekYieldPercentPoints =
    blendedAnnualAprDecimal != null ? aprDecimalToSimpleWeekYieldPercentPoints(blendedAnnualAprDecimal) : null;
  const blendedWeekUsdEstimate =
    blendedWeekYieldPercentPoints != null ? (depositAmount * blendedWeekYieldPercentPoints) / 100 : null;
  const resolveCurrentAnnualAprDecimal = (product: YieldProduct): number | null => {
    if (product.id === selected.id && blendedAnnualAprDecimal != null) {
      return blendedAnnualAprDecimal;
    }
    let weighted = 0;
    let hasAny = false;
    product.protocolMix.forEach((item) => {
      const poolLabel = resolvePoolLabel(item.name, item.pool);
      const poolApr = visiblePoolAprByLabel[poolLabel];
      if (typeof poolApr === "number" && Number.isFinite(poolApr) && poolApr > 0) {
        weighted += poolApr * item.weight;
        hasAny = true;
        return;
      }
      if (marketApr) {
        weighted += mixItemAnnualAprDecimal(item.name, marketApr) * item.weight;
        hasAny = true;
      }
    });
    return hasAny ? weighted : null;
  };

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

  useEffect(() => {
    if (visibleProducts.length === 0) {
      setPoolLiveMap({});
      setProductLiveMap({});
      setVisiblePoolAprByLabel({});
      return;
    }
    const productPools = visibleProducts.map((product) => ({
      productId: product.id,
      pools: product.protocolMix.map((item) => resolvePoolLabel(item.name, item.pool))
    }));
    const uniqueLabels = [...new Set(productPools.flatMap((item) => item.pools))];
    const checkingMap = uniqueLabels.reduce<Record<string, PoolLiveState>>(
      (acc, label) => ({ ...acc, [label]: "checking" }),
      {}
    );
    setPoolLiveMap(checkingMap);

    let cancelled = false;
    const checkPoolLiveness = async () => {
      const liveByLabel: Record<string, boolean> = {};
      let nextPoolAprByLabel: Record<string, number> = {};
      try {
        const poolSnapshot = await fetchPoolApyHistoryFromCsv({ days: 14, pools: uniqueLabels });
        const latestPoint = poolSnapshot.points[poolSnapshot.points.length - 1];
        if (latestPoint) {
          nextPoolAprByLabel = poolSnapshot.series.reduce<Record<string, number>>((acc, series) => {
            const value = latestPoint.pools[series.key];
            if (typeof value === "number" && Number.isFinite(value) && value > 0) {
              acc[series.poolLabel] = value;
            }
            return acc;
          }, {});
        }
        const matchedByLabel = new Map(poolSnapshot.series.map((series) => [series.poolLabel, Boolean(series.matchedLabel)]));
        uniqueLabels.forEach((label) => {
          liveByLabel[label] = matchedByLabel.get(label) ?? false;
        });
      } catch {
        uniqueLabels.forEach((label) => {
          liveByLabel[label] = false;
        });
      }

      const orcaLabels = uniqueLabels.filter((label) => /^Orca Whirlpools/i.test(label));
      await Promise.all(
        orcaLabels.map(async (label) => {
          const action = orcaActionFromPoolLabel(label);
          if (!action) return;
          try {
            const candidates = await resolveOrcaPoolCandidatesForAction(action, "mainnet");
            liveByLabel[label] = liveByLabel[label] || candidates.length > 0;
          } catch {
            liveByLabel[label] = false;
          }
        })
      );

      if (cancelled) return;
      setVisiblePoolAprByLabel(nextPoolAprByLabel);
      setPoolLiveMap(
        uniqueLabels.reduce<Record<string, PoolLiveState>>(
          (acc, label) => ({ ...acc, [label]: liveByLabel[label] ? "live" : "down" }),
          {}
        )
      );
      setProductLiveMap(
        productPools.reduce<Record<string, boolean>>(
          (acc, item) => ({ ...acc, [item.productId]: item.pools.every((pool) => liveByLabel[pool]) }),
          {}
        )
      );
    };
    void checkPoolLiveness();

    return () => {
      cancelled = true;
    };
  }, [visibleProducts]);

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
      ) : !isWalletConnected ? (
        <p className="product-session-hint">
          <strong>지갑 연결</strong> 후 입금·인출이 가능합니다. 조회는 현재 로그인 상태로 이용할 수 있습니다.
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
        {visibleProducts.map((product) => {
          const currentAnnualAprDecimal = resolveCurrentAnnualAprDecimal(product);
          return (
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
              <div className="product-badge-row">
                <span className={`product-network-badge product-network-badge--${product.networkGroup}`}>
                  {PRODUCT_NETWORK_LABELS[product.networkGroup]}
                </span>
                {productLiveMap[product.id] ? <span className="product-live-badge">LIVE</span> : null}
              </div>
              <p className="kpi-label">{displayProductName(product.name)}</p>
              <p className="kpi-value">
                목표 연수익 {(product.targetApr * 100).toFixed(1)}%
                <span className="product-current-apr">
                  현재 연수익 {currentAnnualAprDecimal != null ? `${(currentAnnualAprDecimal * 100).toFixed(2)}%` : "조회 중"}
                </span>
              </p>
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
          );
        })}
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
              <span>1년 이율</span>
              <span>상태</span>
            </div>
            {selected.protocolMix.map((item, mixIdx) => {
              const poolAmount = depositAmount * item.weight;
              const rowAprDec = selectedMixAprDecimals[mixIdx];
              const weekPct = rowAprDec != null ? aprDecimalToSimpleWeekYieldPercentPoints(rowAprDec) : null;
              const annualPct = rowAprDec != null ? rowAprDec * 100 : null;
              const poolLabel = resolvePoolLabel(item.name, item.pool);
              const liveState = poolLiveMap[poolLabel] ?? "checking";
              return (
                <div key={`${item.name}-${mixIdx}`} className="product-pool-item">
                  <span>{item.name}</span>
                  <span className="product-pool-pool-label">{poolLabel}</span>
                  <span>{(item.weight * 100).toFixed(0)}%</span>
                  <span>${poolAmount.toFixed(2)}</span>
                  <span className="product-pool-week-cell">{weekPct != null ? `${weekPct.toFixed(3)}%` : "—"}</span>
                  <span className="product-pool-annual-cell">{annualPct != null ? `${annualPct.toFixed(2)}%` : "—"}</span>
                  <span
                    className={
                      liveState === "live"
                        ? "product-pool-live product-pool-live--ok"
                        : liveState === "down"
                          ? "product-pool-live product-pool-live--down"
                          : "product-pool-live product-pool-live--checking"
                    }
                    title={liveState === "live" ? "활성 풀" : liveState === "down" ? "활성 상태 확인 필요" : "상태 점검 중"}
                  >
                    {liveState === "live" ? "✓" : liveState === "down" ? "!" : "…"}
                  </span>
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

