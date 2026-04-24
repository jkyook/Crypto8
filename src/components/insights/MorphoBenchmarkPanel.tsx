import { useEffect, useMemo, useState } from "react";
import {
  fetchMorphoBenchmark,
  fetchMorphoMarkets,
  fetchMorphoVaults,
  type MorphoBenchmarkSummary,
  type MorphoMarketSummary,
  type MorphoVaultSummary
} from "../../lib/api";

const CHAIN_OPTIONS = [
  { id: 42161, label: "Arbitrum" },
  { id: 8453, label: "Base" },
  { id: 1, label: "Ethereum" }
] as const;

function asPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}%`;
}

export function MorphoBenchmarkPanel() {
  const [chainId, setChainId] = useState<number>(42161);
  const [benchmark, setBenchmark] = useState<MorphoBenchmarkSummary | null>(null);
  const [markets, setMarkets] = useState<MorphoMarketSummary[]>([]);
  const [vaults, setVaults] = useState<MorphoVaultSummary[]>([]);
  const [selectedView, setSelectedView] = useState<"market" | "vault" | "compare">("market");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError("");
      const [benchmarkResult, marketsResult, vaultsResult] = await Promise.allSettled([
        fetchMorphoBenchmark(chainId),
        fetchMorphoMarkets(chainId),
        fetchMorphoVaults(chainId)
      ]);

      if (cancelled) {
        return;
      }

      if (benchmarkResult.status === "fulfilled") {
        setBenchmark(benchmarkResult.value);
      } else {
        setBenchmark(null);
      }

      if (marketsResult.status === "fulfilled") {
        setMarkets(marketsResult.value);
      } else {
        setMarkets([]);
      }

      if (vaultsResult.status === "fulfilled") {
        setVaults(vaultsResult.value);
      } else {
        setVaults([]);
      }

      const failures = [benchmarkResult, marketsResult, vaultsResult].filter((result) => result.status === "rejected") as PromiseRejectedResult[];
      if (failures.length > 0 && benchmarkResult.status === "rejected") {
        const first = failures[0];
        setError(first.reason instanceof Error ? first.reason.message : "Morpho 벤치마크를 불러오지 못했습니다.");
      }
      setLoading(false);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [chainId]);

  const bestMarket = useMemo(() => markets[0] ?? null, [markets]);
  const bestVault = useMemo(() => benchmark?.topVaults[0] ?? null, [benchmark]);
  const spreadPct = useMemo(() => {
    if (!benchmark || !bestVault) return null;
    return bestVault.netApy - benchmark.bestMarketApy;
  }, [benchmark, bestVault]);

  const selectedTitle = selectedView === "market"
    ? "직접 마켓 상세"
    : selectedView === "vault"
      ? "자동 운용 Vault 상세"
      : "직접 마켓 vs Vault 비교";
  const selectedDescription = selectedView === "market"
    ? "직접 마켓에 넣는 경우의 후보들입니다."
    : "직접 마켓과 Vault를 함께 비교해 보는 영역입니다.";

  return (
    <section className="card">
      <div className="command-center-hero" style={{ marginBottom: 16 }}>
        <div>
          <p className="section-eyebrow">Morpho</p>
          <h2>벤치마크 패널</h2>
          <p className="command-center-lead">
            직접 마켓 수익률과 자동 운용 Vault 수익률을 함께 보여주고, 너무 작은 Vault는 제외한 뒤 현재 체인에서 어느 쪽이 더 유리한지 빠르게 비교합니다.
          </p>
        </div>
        <div className="mission-action-stack">
          <label className="kpi-label" htmlFor="morpho-chain-select">체인 선택</label>
          <select
            id="morpho-chain-select"
            value={chainId}
            onChange={(event) => setChainId(Number(event.target.value))}
            aria-label="Morpho 조회 체인"
          >
            {CHAIN_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="command-kpi-grid">
        <button
          type="button"
          className="command-kpi"
          data-active={selectedView === "market"}
          onClick={() => setSelectedView("market")}
          style={{ textAlign: "left", width: "100%" }}
        >
          <span className="kpi-label">직접 마켓 최고 APY</span>
          <strong>{benchmark ? asPct(benchmark.bestMarketApy) : "—"}</strong>
          <span className="muted-copy" style={{ display: "block", marginTop: 8 }}>눌러서 직접 마켓 후보 보기</span>
        </button>
        <button
          type="button"
          className="command-kpi"
          data-active={selectedView === "vault"}
          onClick={() => setSelectedView("vault")}
          style={{ textAlign: "left", width: "100%" }}
        >
          <span className="kpi-label">자동 운용 Vault 최고 순수익 APY</span>
          <strong>{bestVault ? asPct(bestVault.netApy) : "—"}</strong>
          <span className="muted-copy" style={{ display: "block", marginTop: 8 }}>눌러서 Vault 후보와 gross/net APY 보기</span>
        </button>
        <button
          type="button"
          className="command-kpi"
          data-active={selectedView === "compare"}
          onClick={() => setSelectedView("compare")}
          style={{ textAlign: "left", width: "100%" }}
        >
          <span className="kpi-label">Vault - 마켓 차이</span>
          <strong>{spreadPct == null ? "—" : `${spreadPct >= 0 ? "+" : ""}${spreadPct.toFixed(2)}p`}</strong>
          <span className="muted-copy" style={{ display: "block", marginTop: 8 }}>눌러서 비교 요약 보기</span>
        </button>
        <button
          type="button"
          className="command-kpi"
          data-active={selectedView === "compare"}
          onClick={() => setSelectedView("compare")}
          style={{ textAlign: "left", width: "100%" }}
        >
          <span className="kpi-label">Vault 수</span>
          <strong>{vaults.length.toLocaleString()}</strong>
          <span className="muted-copy" style={{ display: "block", marginTop: 8 }}>눌러서 전체 비교 보기</span>
        </button>
      </div>

      {loading ? <p className="muted-copy" style={{ marginTop: 12 }}>Morpho 데이터를 불러오는 중입니다...</p> : null}
      {error ? <p className="muted-copy" style={{ marginTop: 12 }}>{error}</p> : null}

      <div style={{ marginTop: 16 }}>
        <div className="command-panel" style={{ width: "100%" }}>
          <h3>{selectedTitle}</h3>
          <p className="muted-copy" style={{ marginTop: 0 }}>
            {selectedDescription}
          </p>
          {selectedView === "market" ? (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Supply APY</th>
                    <th>Borrow APY</th>
                    <th>Liquidity</th>
                    <th>LLTV</th>
                    <th>Utilization</th>
                  </tr>
                </thead>
                <tbody>
                  {markets.slice(0, 3).map((market) => (
                    <tr key={market.uniqueKey}>
                      <td>{market.collateralAsset}/{market.loanAsset}</td>
                      <td>{market.supplyApyPct}</td>
                      <td>{market.borrowApyPct}</td>
                      <td>{market.liquidityUsdM}</td>
                      <td>{market.lltv}</td>
                      <td>{market.utilization}</td>
                    </tr>
                  ))}
                  {markets.length === 0 && !loading ? (
                    <tr>
                      <td colSpan={6} className="recent-empty">표시할 Morpho 시장이 없습니다.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}

          {selectedView === "vault" ? (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vault</th>
                    <th>Curator</th>
                    <th>Gross APY</th>
                    <th>Net APY</th>
                    <th>Fee</th>
                    <th>TVL</th>
                  </tr>
                </thead>
                <tbody>
                  {vaults.slice(0, 3).map((vault) => (
                    <tr key={vault.address}>
                      <td>{vault.symbol} · {vault.name}</td>
                      <td>{vault.curator}</td>
                      <td>{vault.apyPct}</td>
                      <td>{vault.netApyPct}</td>
                      <td>{vault.feePct}</td>
                      <td>{vault.tvlUsdM}</td>
                    </tr>
                  ))}
                  {vaults.length === 0 && !loading ? (
                    <tr>
                      <td colSpan={6} className="recent-empty">표시할 Morpho Vault가 없습니다.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}

          {selectedView === "compare" ? (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Name</th>
                    <th>Gross APY</th>
                    <th>Net APY</th>
                    <th>Fee</th>
                    <th>Delta</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Direct Market</td>
                    <td>{bestMarket ? `${bestMarket.collateralAsset}/${bestMarket.loanAsset}` : "—"}</td>
                    <td>{benchmark ? asPct(benchmark.bestMarketApy) : "—"}</td>
                    <td>—</td>
                    <td>—</td>
                    <td>—</td>
                  </tr>
                  <tr>
                    <td>Vault</td>
                    <td>{bestVault ? bestVault.name : "—"}</td>
                    <td>{bestVault ? asPct(bestVault.grossApy) : "—"}</td>
                    <td>{bestVault ? asPct(bestVault.netApy) : "—"}</td>
                    <td>{bestVault ? `${bestVault.feePct.toFixed(2)}%` : "—"}</td>
                    <td>{spreadPct == null ? "—" : `${spreadPct >= 0 ? "+" : ""}${spreadPct.toFixed(2)}p`}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>

      <div className="command-panel" style={{ marginTop: 16 }}>
        <h3>요약</h3>
        <p className="muted-copy" style={{ marginBottom: 0 }}>
          {benchmark
            ? `${CHAIN_OPTIONS.find((option) => option.id === chainId)?.label ?? chainId} 기준 직접 마켓 최고 APY는 ${asPct(benchmark.bestMarketApy)}입니다.`
            : "Morpho 벤치마크를 불러오지 못했습니다."}
        </p>
        {bestMarket ? (
          <p className="muted-copy" style={{ marginTop: 8, marginBottom: 0 }}>
            현재 최고 직접 마켓은 {bestMarket.collateralAsset}/{bestMarket.loanAsset} 이고 공급 유동성은 {bestMarket.liquidityUsdM}입니다.
          </p>
        ) : null}
      </div>
    </section>
  );
}
