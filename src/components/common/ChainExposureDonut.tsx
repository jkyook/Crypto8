import { useMemo } from "react";
import { aggregateChainUsdFromPositions } from "../../lib/portfolioMetrics";
import { OPTION_L2_STAR } from "../../lib/strategyEngine";
import { PORTFOLIO_DONUT_COLORS } from "../../lib/constants";
import type { DepositPosition } from "../../types/portfolio";

export function ChainExposureDonut({
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
