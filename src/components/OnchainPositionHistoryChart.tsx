import { useMemo } from "react";
import type { OnchainPositionHistoryPoint } from "../lib/api";

const VB_W = 560;
const VB_H = 220;
const PAD_L = 52;
const PAD_R = 18;
const PAD_T = 24;
const PAD_B = 42;

const SERIES = [
  { key: "currentValueUsd", label: "자산가치", color: "#6b8cff" },
  { key: "pnlUsd", label: "수익", color: "#47d9a8" },
  { key: "pendingYieldUsd", label: "미청구 수익", color: "#ffb86b" }
] as const;

type OnchainPositionHistoryChartProps = {
  points: OnchainPositionHistoryPoint[];
  title: string;
  subtitle?: string;
};

function buildPath(
  points: Array<{ t: number; y: number }>,
  xAt: (t: number) => number,
  yAt: (y: number) => number
): string {
  if (points.length === 0) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${xAt(point.t).toFixed(1)} ${yAt(point.y).toFixed(1)}`).join(" ");
}

function formatUsd(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function OnchainPositionHistoryChart({ points, title, subtitle }: OnchainPositionHistoryChartProps) {
  const layout = useMemo(() => {
    const innerW = VB_W - PAD_L - PAD_R;
    const innerH = VB_H - PAD_T - PAD_B;
    if (points.length === 0) {
      return { innerW, innerH, empty: true as const };
    }

    const parsed = points.map((point) => ({
      t: new Date(point.t).getTime(),
      values: SERIES.map((series) => ({
        key: series.key,
        y: point[series.key]
      }))
    }));

    let t0 = parsed[0].t;
    let t1 = parsed[parsed.length - 1].t;
    if (parsed.length === 1) {
      const half = 12 * 3600 * 1000;
      t0 = parsed[0].t - half;
      t1 = parsed[0].t + half;
    }
    const tSpan = Math.max(t1 - t0, 60_000);

    const yValues = parsed.flatMap((point) => point.values.map((entry) => entry.y));
    let yMin = Math.min(...yValues);
    let yMax = Math.max(...yValues);
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      yMin = 0;
      yMax = 1;
    }
    if (yMax - yMin < 0.01) {
      const mid = (yMin + yMax) / 2;
      yMin = mid - 0.05;
      yMax = mid + 0.05;
    }
    const pad = (yMax - yMin) * 0.12;
    yMin -= pad;
    yMax += pad;

    const xAt = (t: number) => PAD_L + ((t - t0) / tSpan) * innerW;
    const yAt = (value: number) => PAD_T + innerH - ((value - yMin) / (yMax - yMin)) * innerH;

    const yTicks = [yMin, (yMin + yMax) / 2, yMax].map((value) => ({
      y: yAt(value),
      label: formatUsd(value)
    }));
    const xTickCount = Math.min(5, Math.max(parsed.length, 1));
    const xTicks: Array<{ x: number; label: string }> = [];
    for (let i = 0; i < xTickCount; i += 1) {
      const idx = parsed.length <= 1 ? 0 : Math.round((i * (parsed.length - 1)) / Math.max(xTickCount - 1, 1));
      const point = parsed[idx];
      const d = new Date(point.t);
      xTicks.push({
        x: xAt(point.t),
        label: d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      });
    }

    const latest = parsed[parsed.length - 1];
    const lineSeries = SERIES.map((series) => ({
      ...series,
      path: buildPath(
        parsed.map((point) => ({
          t: point.t,
          y: point.values.find((entry) => entry.key === series.key)?.y ?? 0
        })),
        xAt,
        yAt
      ),
      latest: latest.values.find((entry) => entry.key === series.key)?.y ?? 0
    }));

    return {
      innerW,
      innerH,
      empty: false as const,
      yAt,
      yTicks,
      xTicks,
      lineSeries,
      latest,
      singlePoint:
        parsed.length === 1
          ? {
              cx: xAt(parsed[0].t),
              values: parsed[0].values
            }
          : null
    };
  }, [points]);

  if ("empty" in layout && layout.empty) {
    return (
      <div className="onchain-history-chart onchain-history-chart--empty">
        <p>이 풀의 저장된 조회 스냅샷이 아직 없습니다. 새로고침으로 조회하면 그래프가 쌓입니다.</p>
      </div>
    );
  }

  if (!("lineSeries" in layout)) {
    return null;
  }

  const L = layout;
  const singlePoint = L.singlePoint;

  return (
    <div className="onchain-history-chart">
      <div className="onchain-history-chart-head">
        <div>
          <p className="section-eyebrow">Historical Snapshots</p>
          <h4>{title}</h4>
          {subtitle ? <p className="kpi-label">{subtitle}</p> : null}
        </div>
        <div className="onchain-history-chart-stats">
          {SERIES.map((series) => {
            const latest = L.latest.values.find((entry) => entry.key === series.key)?.y ?? 0;
            return (
              <span key={series.key} style={{ color: series.color }}>
                {series.label} <strong>{formatUsd(latest)}</strong>
              </span>
            );
          })}
        </div>
      </div>
      <div className="onchain-history-chart-legend">
        {SERIES.map((series) => (
          <span key={series.key} style={{ color: series.color }}>
            {series.label}
          </span>
        ))}
      </div>
      <svg className="onchain-history-chart-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="onchainHistoryFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#6b8cff" stopOpacity="0.24" />
            <stop offset="100%" stopColor="#6b8cff" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1={PAD_L} x2={PAD_L + L.innerW} y1={PAD_T + L.innerH} y2={PAD_T + L.innerH} className="onchain-history-axis" />
        <line x1={PAD_L} x2={PAD_L} y1={PAD_T} y2={PAD_T + L.innerH} className="onchain-history-axis" />
        {L.yTicks.map((tick) => (
          <g key={tick.label}>
            <line x1={PAD_L} x2={PAD_L + L.innerW} y1={tick.y} y2={tick.y} className="onchain-history-grid" />
            <text x={PAD_L - 6} y={tick.y + 3} textAnchor="end" className="onchain-history-tick">
              {tick.label}
            </text>
          </g>
        ))}
        {L.lineSeries.map((series, index) => (
          <path
            key={series.key}
            d={series.path}
            fill="none"
            stroke={series.color}
            strokeWidth={index === 0 ? 2.8 : 2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="onchain-history-line"
          />
        ))}
        {singlePoint ? (
          <>
            {L.lineSeries.map((series) => {
              const point = singlePoint.values.find((entry) => entry.key === series.key);
              if (!point) return null;
              return (
                <circle key={series.key} cx={singlePoint.cx} cy={L.yAt(point.y)} r="3.5" fill={series.color} className="onchain-history-point" />
              );
            })}
          </>
        ) : null}
        {L.xTicks.map((tick) => (
          <text key={tick.label} x={tick.x} y={PAD_T + L.innerH + 24} textAnchor="middle" className="onchain-history-tick">
            {tick.label}
          </text>
        ))}
      </svg>
      <div className="onchain-history-footnote">
        <span>스냅샷 {points.length}개</span>
        <span>시간순 저장</span>
      </div>
    </div>
  );
}
