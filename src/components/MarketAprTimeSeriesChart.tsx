import { useMemo } from "react";
import type { MarketPoolAprHistoryPoint, MarketPoolAprHistorySeries } from "../lib/api";

const VB_W = 520;
const VB_H = 188;
const PAD_L = 48;
const PAD_R = 18;
const PAD_T = 24;
const PAD_B = 46;

const SERIES_COLORS = ["#6b8cff", "#c084fc", "#47d9a8", "#ffb86b", "#3bd4ff", "#f97316"];
const COL_BLEND = "#ff5c5c";

type WeightedPoolSeries = MarketPoolAprHistorySeries & {
  weight: number;
};

type MarketAprTimeSeriesChartProps = {
  points: MarketPoolAprHistoryPoint[];
  granularity: "day";
  series: WeightedPoolSeries[];
};

function toAprPercent(dec: number): number {
  return dec * 100;
}

function buildPath(
  pts: Array<{ t: number; yv: number }>,
  xAt: (t: number) => number,
  yAt: (v: number) => number
): string {
  if (pts.length === 0) return "";
  return pts.map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(p.t).toFixed(1)} ${yAt(p.yv).toFixed(1)}`).join(" ");
}

function buildAreaPath(
  pts: Array<{ t: number; yv: number }>,
  xAt: (t: number) => number,
  yAt: (v: number) => number,
  baselineY: number
): string {
  if (pts.length === 0) return "";
  const line = buildPath(pts, xAt, yAt);
  const first = pts[0];
  const last = pts[pts.length - 1];
  return `${line} L ${xAt(last.t).toFixed(1)} ${baselineY.toFixed(1)} L ${xAt(first.t).toFixed(1)} ${baselineY.toFixed(1)} Z`;
}

function compactLabel(label: string): string {
  return label
    .replace(/^Aave V3\s*/i, "Aave ")
    .replace(/^Uniswap V3\s*/i, "Uni ")
    .replace(/^Orca\s*/i, "Orca ")
    .replace(/\s*\(0\.05%\)/i, "")
    .replace(/\s*supply/i, "")
    .trim();
}

export function MarketAprTimeSeriesChart({ points, granularity, series }: MarketAprTimeSeriesChartProps) {
  const layout = useMemo(() => {
    const innerW = VB_W - PAD_L - PAD_R;
    const innerH = VB_H - PAD_T - PAD_B;
    const activeSeries = series.filter((item) => item.weight > 0);
    if (points.length === 0 || activeSeries.length === 0) {
      return { innerW, innerH, empty: true as const };
    }

    const parsed = points.map((p) => {
      const values = activeSeries.map((item) => ({
        key: item.key,
        yv: toAprPercent(p.pools[item.key] ?? 0)
      }));
      const blend = values.reduce((acc, value) => {
        const item = activeSeries.find((seriesItem) => seriesItem.key === value.key);
        return acc + (value.yv * (item?.weight ?? 0));
      }, 0);
      return {
        t: new Date(p.t).getTime(),
        values,
        blend
      };
    });

    let t0 = parsed[0].t;
    let t1 = parsed[parsed.length - 1].t;
    if (parsed.length === 1) {
      const half = 12 * 3600 * 1000;
      t0 = parsed[0].t - half;
      t1 = parsed[0].t + half;
    }
    const tSpan = Math.max(t1 - t0, 60_000);

    const allY = parsed.flatMap((p) => [...p.values.map((value) => value.yv), p.blend]);
    let yMin = Math.min(...allY);
    let yMax = Math.max(...allY);
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      yMin = 0;
      yMax = 1;
    }
    if (yMax - yMin < 0.02) {
      const mid = (yMin + yMax) / 2;
      yMin = mid - 0.05;
      yMax = mid + 0.05;
    }
    const pad = (yMax - yMin) * 0.08;
    yMin -= pad;
    yMax += pad;

    const xAt = (t: number) => PAD_L + ((t - t0) / tSpan) * innerW;
    const yAt = (yv: number) => PAD_T + innerH - ((yv - yMin) / (yMax - yMin)) * innerH;

    const lineAcross = (yv: number) => {
      const y = yAt(yv);
      return `M ${PAD_L} ${y.toFixed(1)} L ${(PAD_L + innerW).toFixed(1)} ${y.toFixed(1)}`;
    };

    const poolPaths = activeSeries.map((item, idx) => {
      const valuePoints = parsed.map((p) => ({
        t: p.t,
        yv: p.values.find((value) => value.key === item.key)?.yv ?? 0
      }));
      return {
        key: item.key,
        label: compactLabel(item.matchedLabel ?? item.label),
        weight: item.weight,
        color: SERIES_COLORS[idx % SERIES_COLORS.length],
        path: parsed.length >= 2 ? buildPath(valuePoints, xAt, yAt) : lineAcross(valuePoints[0].yv),
        points: valuePoints.map((point) => ({
          x: xAt(point.t),
          y: yAt(point.yv)
        })),
        latest: valuePoints[valuePoints.length - 1].yv
      };
    });

    const blendPoints = parsed.map((p) => ({ t: p.t, yv: p.blend }));
    const pathB = parsed.length >= 2 ? buildPath(blendPoints, xAt, yAt) : lineAcross(blendPoints[0].yv);
    const blendArea = parsed.length >= 2 ? buildAreaPath(blendPoints, xAt, yAt, PAD_T + innerH) : "";
    const latest = parsed[parsed.length - 1];
    const first = parsed[0];
    const delta = latest.blend - first.blend;

    const yTicks = [yMin, (yMin + yMax) / 2, yMax].map((yv) => ({
      y: yAt(yv),
      label: `${yv.toFixed(2)}%`
    }));

    const xTickCount = Math.min(5, Math.max(parsed.length, 1));
    const xTicks: Array<{ x: number; label: string }> = [];
    for (let i = 0; i < xTickCount; i += 1) {
      const idx = parsed.length <= 1 ? 0 : Math.round((i * (parsed.length - 1)) / Math.max(xTickCount - 1, 1));
      const p = parsed[idx];
      const d = new Date(p.t);
      xTicks.push({ x: xAt(p.t), label: d.toLocaleString("ko-KR", { month: "numeric", day: "numeric" }) });
    }

    return {
      innerW,
      innerH,
      empty: false as const,
      yAt,
      poolPaths,
      pathB,
      blendArea,
      yTicks,
      xTicks,
      latest,
      delta,
      singlePoint: parsed.length === 1 ? { cx: xAt(parsed[0].t), pts: parsed[0] } : null
    };
  }, [points, series]);

  if ("empty" in layout && layout.empty) {
    return (
      <div className="market-apr-ts-chart market-apr-ts-chart--empty" role="img" aria-label="풀별 APY 시계열">
        <p>선택 상품의 풀별 APY 이력을 불러오는 중입니다. API 서버가 실행 중인지 확인해 주세요.</p>
      </div>
    );
  }

  if (!("pathB" in layout)) {
    return null;
  }

  const L = layout;

  return (
    <div className="market-apr-ts-chart" role="img" aria-label={`선택 상품 풀별 연 이율 ${granularity} 변화`}>
      <div className="market-apr-ts-chart-head">
        <div>
          <span className="market-apr-ts-chart-title">Pool APY Trend</span>
          <p className="market-apr-ts-chart-sub">선택 상품을 구성하는 실제 풀 APY와 배분 가중 합성 APY입니다.</p>
        </div>
        <div className="market-apr-ts-stat-strip">
          <span className="market-apr-ts-stat-chip">
            <span className="market-apr-ts-stat-label">합성 APY</span>
            <strong>{L.latest.blend.toFixed(2)}%</strong>
          </span>
          <span className={`market-apr-ts-stat-chip ${L.delta >= 0 ? "up" : "down"}`}>
            <span className="market-apr-ts-stat-label">변화량</span>
            <strong>{L.delta >= 0 ? "+" : ""}{L.delta.toFixed(2)}p</strong>
          </span>
        </div>
        <span className="market-apr-ts-legend">
          {L.poolPaths.map((item) => (
            <span key={item.key} style={{ color: item.color }} title={`${item.label} · ${(item.weight * 100).toFixed(0)}%`}>
              {item.label}
            </span>
          ))}
          <span style={{ color: COL_BLEND }}>합성 APY</span>
        </span>
      </div>
      <svg className="market-apr-ts-chart-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="marketAprBlendFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={COL_BLEND} stopOpacity="0.22" />
            <stop offset="78%" stopColor={COL_BLEND} stopOpacity="0.02" />
          </linearGradient>
          <filter id="marketAprGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <line x1={PAD_L} x2={PAD_L + L.innerW} y1={PAD_T + L.innerH} y2={PAD_T + L.innerH} className="market-apr-ts-axis" />
        <line x1={PAD_L} x2={PAD_L} y1={PAD_T} y2={PAD_T + L.innerH} className="market-apr-ts-axis" />
        {L.yTicks.map((tk) => (
          <g key={tk.label}>
            <line x1={PAD_L} x2={PAD_L + L.innerW} y1={tk.y} y2={tk.y} className="market-apr-ts-grid" />
            <text x={PAD_L - 6} y={tk.y + 3} textAnchor="end" className="market-apr-ts-tick">
              {tk.label}
            </text>
          </g>
        ))}
        {L.blendArea ? <path d={L.blendArea} fill="url(#marketAprBlendFill)" className="market-apr-ts-area" /> : null}
        {L.poolPaths.map((item) => (
          <g key={item.key}>
            <path
              d={item.path}
              fill="none"
              stroke={item.color}
              strokeWidth={1.05}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="market-apr-ts-line market-apr-ts-line--muted"
            />
          </g>
        ))}
        <path d={L.pathB} fill="none" stroke={COL_BLEND} strokeWidth={1.3} className="market-apr-ts-line market-apr-ts-line--blend" filter="url(#marketAprGlow)" />
        {L.singlePoint ? (
          <g />
        ) : null}
        {L.xTicks.map((xt) => (
          <text key={xt.label + xt.x} x={xt.x} y={VB_H - 11} textAnchor="middle" className="market-apr-ts-xtick">
            {xt.label}
          </text>
        ))}
      </svg>
      {points.length < 2 ? <p className="market-apr-ts-chart-note">포인트가 늘어나면 추세선이 더 의미 있게 보입니다.</p> : null}
    </div>
  );
}
