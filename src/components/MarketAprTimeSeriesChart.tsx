import { useMemo } from "react";
import { blendedAprDecimalFromMix } from "../lib/marketAprBlend";
import type { MarketAprHistoryPoint } from "../lib/api";

const VB_W = 520;
const VB_H = 188;
const PAD_L = 48;
const PAD_R = 18;
const PAD_T = 24;
const PAD_B = 46;

const COL_AAVE = "#6b8cff";
const COL_UNI = "#c084fc";
const COL_ORCA = "#47d9a8";
const COL_BLEND = "#ff5c5c";

type MarketAprTimeSeriesChartProps = {
  points: MarketAprHistoryPoint[];
  granularity: "hour" | "day";
  protocolMix: Array<{ name: string; weight: number }>;
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
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(p.t).toFixed(1)} ${yAt(p.yv).toFixed(1)}`);
  return d.join(" ");
}

export function MarketAprTimeSeriesChart({ points, granularity, protocolMix }: MarketAprTimeSeriesChartProps) {
  const layout = useMemo(() => {
    const innerW = VB_W - PAD_L - PAD_R;
    const innerH = VB_H - PAD_T - PAD_B;
    if (points.length === 0) {
      return { innerW, innerH, empty: true as const };
    }

    const parsed = points.map((p) => ({
      t: new Date(p.t).getTime(),
      aave: toAprPercent(p.aave),
      uni: toAprPercent(p.uniswap),
      orca: toAprPercent(p.orca),
      blend: toAprPercent(blendedAprDecimalFromMix(p, protocolMix))
    }));

    let t0 = parsed[0].t;
    let t1 = parsed[parsed.length - 1].t;
    if (parsed.length === 1) {
      const half = 12 * 3600 * 1000;
      t0 = parsed[0].t - half;
      t1 = parsed[0].t + half;
    }
    const tSpan = Math.max(t1 - t0, 60_000);

    const allY = parsed.flatMap((p) => [p.aave, p.uni, p.orca, p.blend]);
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

    const pathA =
      parsed.length >= 2
        ? buildPath(
            parsed.map((p) => ({ t: p.t, yv: p.aave })),
            xAt,
            yAt
          )
        : lineAcross(parsed[0].aave);
    const pathU =
      parsed.length >= 2
        ? buildPath(
            parsed.map((p) => ({ t: p.t, yv: p.uni })),
            xAt,
            yAt
          )
        : lineAcross(parsed[0].uni);
    const pathO =
      parsed.length >= 2
        ? buildPath(
            parsed.map((p) => ({ t: p.t, yv: p.orca })),
            xAt,
            yAt
          )
        : lineAcross(parsed[0].orca);
    const pathB =
      parsed.length >= 2
        ? buildPath(
            parsed.map((p) => ({ t: p.t, yv: p.blend })),
            xAt,
            yAt
          )
        : lineAcross(parsed[0].blend);
    const blendArea = parsed.length >= 2
      ? `${pathB} L ${xAt(parsed[parsed.length - 1].t).toFixed(1)} ${(PAD_T + innerH).toFixed(1)} L ${xAt(parsed[0].t).toFixed(1)} ${(PAD_T + innerH).toFixed(1)} Z`
      : "";
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
      const idx =
        parsed.length <= 1 ? 0 : Math.round((i * (parsed.length - 1)) / Math.max(xTickCount - 1, 1));
      const p = parsed[idx];
      const d = new Date(p.t);
      const label =
        granularity === "day"
          ? d.toLocaleString("ko-KR", { month: "numeric", day: "numeric" })
          : d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      xTicks.push({ x: xAt(p.t), label });
    }

    return {
      innerW,
      innerH,
      empty: false as const,
      yAt,
      pathA,
      pathU,
      pathO,
      pathB,
      blendArea,
      yTicks,
      xTicks,
      yMin,
      yMax,
      t0,
      t1,
      latest,
      delta,
      singlePoint: parsed.length === 1 ? { cx: xAt(parsed[0].t), pts: parsed[0] } : null
    };
  }, [points, protocolMix, granularity]);

  const granLabel = granularity === "day" ? "일" : "시간";

  if ("empty" in layout && layout.empty) {
    return (
      <div className="market-apr-ts-chart market-apr-ts-chart--empty" role="img" aria-label="이율 시계열">
        <p>아직 저장된 시계열이 없습니다. API가 주기적으로 조회될수록 그래프가 채워집니다(5분 간격 저장).</p>
      </div>
    );
  }

  if (!("pathA" in layout)) {
    return null;
  }

  const L = layout;

  return (
    <div className="market-apr-ts-chart" role="img" aria-label={`연 이율(%) ${granLabel} 변화`}>
      <div className="market-apr-ts-chart-head">
        <div>
          <span className="market-apr-ts-chart-title">
            {granularity === "day" ? "Market APY Trend" : `이율 변화 (${granLabel} 단위)`}
          </span>
          <p className="market-apr-ts-chart-sub">선택 상품의 프로토콜 APY와 배분 가중합을 한 그래프에서 비교합니다.</p>
        </div>
        <div className="market-apr-ts-stat-strip">
          <span>가중합 <strong>{L.latest.blend.toFixed(2)}%</strong></span>
          <span className={L.delta >= 0 ? "up" : "down"}>{L.delta >= 0 ? "+" : ""}{L.delta.toFixed(2)}p</span>
        </div>
        <span className="market-apr-ts-legend">
          <span style={{ color: COL_AAVE }}>Aave</span>
          <span style={{ color: COL_UNI }}>Uniswap</span>
          <span style={{ color: COL_ORCA }}>Orca</span>
          <span style={{ color: COL_BLEND }}>가중합</span>
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
        <line
          x1={PAD_L}
          x2={PAD_L + L.innerW}
          y1={PAD_T + L.innerH}
          y2={PAD_T + L.innerH}
          className="market-apr-ts-axis"
        />
        <line x1={PAD_L} x2={PAD_L} y1={PAD_T} y2={PAD_T + L.innerH} className="market-apr-ts-axis" />
        {L.yTicks.map((tk) => (
          <g key={tk.label}>
            <line
              x1={PAD_L}
              x2={PAD_L + L.innerW}
              y1={tk.y}
              y2={tk.y}
              className="market-apr-ts-grid"
            />
            <text x={PAD_L - 6} y={tk.y + 3} textAnchor="end" className="market-apr-ts-tick">
              {tk.label}
            </text>
          </g>
        ))}
        {L.blendArea ? <path d={L.blendArea} fill="url(#marketAprBlendFill)" className="market-apr-ts-area" /> : null}
        <path d={L.pathA} fill="none" stroke={COL_AAVE} strokeWidth={1.6} className="market-apr-ts-line market-apr-ts-line--muted" />
        <path d={L.pathU} fill="none" stroke={COL_UNI} strokeWidth={1.6} className="market-apr-ts-line market-apr-ts-line--muted" />
        <path d={L.pathO} fill="none" stroke={COL_ORCA} strokeWidth={1.6} className="market-apr-ts-line market-apr-ts-line--muted" />
        <path d={L.pathB} fill="none" stroke={COL_BLEND} strokeWidth={2.7} className="market-apr-ts-line market-apr-ts-line--blend" filter="url(#marketAprGlow)" />
        {L.singlePoint ? (
          <g>
            <circle cx={L.singlePoint.cx} cy={L.yAt(L.singlePoint.pts.aave)} r={2.5} fill={COL_AAVE} />
            <circle cx={L.singlePoint.cx} cy={L.yAt(L.singlePoint.pts.uni)} r={2.5} fill={COL_UNI} />
            <circle cx={L.singlePoint.cx} cy={L.yAt(L.singlePoint.pts.orca)} r={2.5} fill={COL_ORCA} />
            <circle cx={L.singlePoint.cx} cy={L.yAt(L.singlePoint.pts.blend)} r={3} fill={COL_BLEND} />
          </g>
        ) : null}
        {L.xTicks.map((xt) => (
          <text key={xt.label + xt.x} x={xt.x} y={VB_H - 11} textAnchor="middle" className="market-apr-ts-xtick">
            {xt.label}
          </text>
        ))}
      </svg>
      {points.length < 2 ? (
        <p className="market-apr-ts-chart-note">포인트가 늘어나면 추세선이 더 의미 있게 보입니다.</p>
      ) : null}
    </div>
  );
}
