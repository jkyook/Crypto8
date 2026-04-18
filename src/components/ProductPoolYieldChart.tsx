import { useMemo } from "react";

export type PoolYieldChartRow = {
  key: string;
  label: string;
  /** 퍼센트 포인트(예 0.12 = 0.12%) */
  weekYieldPercentPoints: number | null;
};

const BAR_COLORS = ["#6b8cff", "#c084fc", "#47d9a8", "#ffb86b", "#5ce1e6"];

type ProductPoolYieldChartProps = {
  rows: PoolYieldChartRow[];
  /** 가중 합계 1주 이율(퍼센트 포인트) — 빨간 기준선 */
  blendedWeekPercentPoints: number | null;
};

const VB_W = 360;
const VB_H = 128;
const PAD_L = 36;
const PAD_R = 12;
const PAD_T = 14;
const PAD_B = 36;

export function ProductPoolYieldChart({ rows, blendedWeekPercentPoints }: ProductPoolYieldChartProps) {
  const layout = useMemo(() => {
    const numeric = rows.map((r) => r.weekYieldPercentPoints).filter((v): v is number => v != null);
    const maxVal = Math.max(...numeric, blendedWeekPercentPoints ?? 0, 0.0008) * 1.12;
    const innerW = VB_W - PAD_L - PAD_R;
    const innerH = VB_H - PAD_T - PAD_B;
    const n = Math.max(rows.length, 1);
    const slot = innerW / n;
    const barW = Math.max(10, slot * 0.52);

    const yFor = (v: number) => PAD_T + innerH - (v / maxVal) * innerH;

    const bars = rows.map((row, i) => {
      const v = row.weekYieldPercentPoints;
      const cx = PAD_L + i * slot + slot / 2;
      const x = cx - barW / 2;
      const h = v != null ? (v / maxVal) * innerH : 0;
      const y = PAD_T + innerH - h;
      return { ...row, x, y, w: barW, h, cx, v };
    });

    const blendY =
      blendedWeekPercentPoints != null && blendedWeekPercentPoints >= 0
        ? yFor(blendedWeekPercentPoints)
        : null;

    const fmtTick = (t: number) => {
      if (maxVal < 0.02) return `${t.toFixed(4)}%`;
      if (maxVal < 0.2) return `${t.toFixed(3)}%`;
      return `${t.toFixed(2)}%`;
    };
    const ticks = [maxVal * 0.5, maxVal].map((t, ti) => ({
      y: yFor(t),
      label: fmtTick(t),
      ti
    }));

    return { maxVal, innerW, innerH, bars, blendY, blendedWeekPercentPoints, ticks };
  }, [rows, blendedWeekPercentPoints]);

  const hasAnyBar = layout.bars.some((b) => b.v != null);
  const hasData = hasAnyBar || layout.blendedWeekPercentPoints != null;

  if (!hasData) {
    return (
      <div className="product-pool-chart product-pool-chart--empty" role="img" aria-label="이율 그래프">
        <p>시장 이율을 불러오면 그래프가 표시됩니다.</p>
      </div>
    );
  }

  return (
    <div className="product-pool-chart" role="img" aria-label="프로토콜별 1주 이율 막대와 가중 합계 기준선">
      <p className="product-pool-chart-title">1주 이율 (빨간 선 = 가중 합계)</p>
      <svg className="product-pool-chart-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="xMidYMid meet">
        <line x1={PAD_L} x2={PAD_L + layout.innerW} y1={PAD_T + layout.innerH} y2={PAD_T + layout.innerH} className="product-pool-chart-axis" />
        <line x1={PAD_L} x2={PAD_L} y1={PAD_T} y2={PAD_T + layout.innerH} className="product-pool-chart-axis" />
        <text x={PAD_L - 6} y={PAD_T + layout.innerH + 3} textAnchor="end" className="product-pool-chart-tick">
          0%
        </text>
        {layout.ticks.map((t) => (
          <g key={`tick-${t.ti}`}>
            <line
              x1={PAD_L - 4}
              x2={PAD_L + layout.innerW}
              y1={t.y}
              y2={t.y}
              className="product-pool-chart-grid"
            />
            <text x={PAD_L - 6} y={t.y + 3} textAnchor="end" className="product-pool-chart-tick">
              {t.label}
            </text>
          </g>
        ))}
        {layout.bars.map((b, i) =>
          b.v != null && b.h > 0 ? (
            <rect
              key={b.key}
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
              rx={3}
              className="product-pool-chart-bar"
              fill={BAR_COLORS[i % BAR_COLORS.length]}
            />
          ) : (
            <rect key={b.key} x={b.x} y={PAD_T + layout.innerH - 1} width={b.w} height={1} rx={0} fill="rgba(160,180,210,0.35)" />
          )
        )}
        {layout.bars.map((b) => (
          <text key={`${b.key}-lab`} x={b.cx} y={VB_H - 9} textAnchor="middle" className="product-pool-chart-xlabel">
            {b.label}
          </text>
        ))}
        {layout.blendY != null ? (
          <g>
            <line
              x1={PAD_L}
              x2={PAD_L + layout.innerW}
              y1={layout.blendY}
              y2={layout.blendY}
              className="product-pool-chart-blend-line"
            />
            <text
              x={PAD_L + layout.innerW - 2}
              y={Math.max(PAD_T + 10, layout.blendY - 6)}
              textAnchor="end"
              className="product-pool-chart-blend-label"
            >
              합계
            </text>
          </g>
        ) : null}
      </svg>
    </div>
  );
}
