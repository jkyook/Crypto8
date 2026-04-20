import { useMemo } from "react";
import type { DepositPositionPayload, OnchainPositionPayload } from "../lib/api";
import { assessPortfolioRisk, describePositionChainMix, getTargetChainWeight } from "../lib/portfolioRisk";

type Props = {
  positions: DepositPositionPayload[];
  onchainPositions?: OnchainPositionPayload[];
  onOpenExecution?: () => void;
};

type AccountingSummary = {
  totalPrincipalUsd: number;
  totalCurrentValueUsd: number;
  totalUnrealizedPnlUsd: number;
  totalRealizedPnlUsd: number;
  totalFeesPaidUsd: number;
  weightedNetApy: number | null;
  hasData: boolean;
};

function computeAccountingSummary(positions: OnchainPositionPayload[]): AccountingSummary {
  const active = positions.filter(p => p.status === "active");
  if (active.length === 0) return {
    totalPrincipalUsd: 0, totalCurrentValueUsd: 0, totalUnrealizedPnlUsd: 0,
    totalRealizedPnlUsd: 0, totalFeesPaidUsd: 0, weightedNetApy: null, hasData: false
  };

  let totalPrincipalUsd = 0;
  let totalCurrentValueUsd = 0;
  let totalUnrealizedPnlUsd = 0;
  let totalRealizedPnlUsd = 0;
  let totalFeesPaidUsd = 0;
  let apyWeightSum = 0;
  let apyValueSum = 0;

  for (const p of active) {
    const principal = p.principalUsd ?? p.amountUsd;
    const current = p.currentValueUsd ?? p.amountUsd;
    totalPrincipalUsd += principal;
    totalCurrentValueUsd += current;
    totalUnrealizedPnlUsd += p.unrealizedPnlUsd ?? (current - principal);
    totalRealizedPnlUsd += p.realizedPnlUsd ?? 0;
    totalFeesPaidUsd += p.feesPaidUsd ?? 0;
    if (p.netApy !== null) {
      apyValueSum += p.netApy * principal;
      apyWeightSum += principal;
    }
  }

  // 닫힌 포지션의 실현 손익도 합산
  const closed = positions.filter(p => p.status === "closed");
  for (const p of closed) {
    totalRealizedPnlUsd += p.realizedPnlUsd ?? 0;
  }

  return {
    totalPrincipalUsd,
    totalCurrentValueUsd,
    totalUnrealizedPnlUsd,
    totalRealizedPnlUsd,
    totalFeesPaidUsd,
    weightedNetApy: apyWeightSum > 0 ? apyValueSum / apyWeightSum : null,
    hasData: true
  };
}

function pnlClass(value: number): string {
  if (value > 0) return "pnl-positive";
  if (value < 0) return "pnl-negative";
  return "pnl-neutral";
}

function formatPnl(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function riskBadgeClass(level: string): string {
  const key = level.toLowerCase();
  if (key === "critical") return "badge badge-critical";
  if (key === "high") return "badge badge-high";
  if (key === "medium") return "badge badge-medium";
  return "badge badge-low";
}

function controlStatusLabel(status: "ok" | "watch" | "action"): string {
  if (status === "action") return "조치";
  if (status === "watch") return "관찰";
  return "정상";
}

export function PortfolioCommandCenter({ positions, onchainPositions = [], onOpenExecution }: Props) {
  const assessment = useMemo(() => assessPortfolioRisk(positions), [positions]);
  const accounting = useMemo(() => computeAccountingSummary(onchainPositions), [onchainPositions]);
  const latestPosition = positions[0];

  return (
    <section className="card command-center-card">
      <div className="command-center-hero">
        <div>
          <p className="section-eyebrow">DeFi Operating Console</p>
          <h2>포트폴리오 운영 현황</h2>
          <p className="command-center-lead">{assessment.primaryAction}</p>
        </div>
        <div className="risk-orb" aria-label={`리스크 점수 ${assessment.riskScore}`}>
          <span className="risk-orb-score">{assessment.riskScore}</span>
          <span className="risk-orb-label">Risk</span>
        </div>
      </div>

      <div className="command-kpi-grid">
        <div className="command-kpi">
          <span className="kpi-label">위험 등급</span>
          <strong>
            <span className={riskBadgeClass(assessment.riskLevel)}>{assessment.riskLevel}</span>
          </strong>
        </div>
        <div className="command-kpi">
          <span className="kpi-label">총 예치</span>
          <strong>${assessment.totalUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
        </div>
        <div className="command-kpi">
          <span className="kpi-label">명목 APY</span>
          <strong>{(assessment.estimatedApy * 100).toFixed(2)}%</strong>
        </div>
        <div className="command-kpi">
          <span className="kpi-label">연 추정 수익</span>
          <strong>${Math.round(assessment.estimatedAnnualYieldUsd).toLocaleString()}</strong>
        </div>
      </div>

      {/* ── 포지션 회계 패널 (P1 데이터가 있을 때만 렌더) ── */}
      {accounting.hasData && (
        <div className="accounting-panel card-inner">
          <h3>포지션 회계 요약</h3>
          <div className="accounting-kpi-grid">
            <div className="accounting-kpi">
              <span className="kpi-label">원금 합계</span>
              <strong>${accounting.totalPrincipalUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
            </div>
            <div className="accounting-kpi">
              <span className="kpi-label">평가금액</span>
              <strong>${accounting.totalCurrentValueUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
            </div>
            <div className={`accounting-kpi ${pnlClass(accounting.totalUnrealizedPnlUsd)}`}>
              <span className="kpi-label">미실현 손익</span>
              <strong>{formatPnl(accounting.totalUnrealizedPnlUsd)}</strong>
            </div>
            <div className={`accounting-kpi ${pnlClass(accounting.totalRealizedPnlUsd)}`}>
              <span className="kpi-label">실현 손익</span>
              <strong>{formatPnl(accounting.totalRealizedPnlUsd)}</strong>
            </div>
            <div className="accounting-kpi">
              <span className="kpi-label">누적 수수료</span>
              <strong>${accounting.totalFeesPaidUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
            </div>
            {accounting.weightedNetApy !== null && (
              <div className="accounting-kpi">
                <span className="kpi-label">실현 APY</span>
                <strong>{(accounting.weightedNetApy * 100).toFixed(2)}%</strong>
              </div>
            )}
          </div>
          {/* 포지션별 PnL 목록 */}
          {onchainPositions.filter(p => p.principalUsd !== null).length > 0 && (
            <div className="position-pnl-list">
              <p className="kpi-label" style={{ marginBottom: "0.5rem" }}>포지션별 손익</p>
              {onchainPositions
                .filter(p => p.principalUsd !== null)
                .map(p => {
                  const pnl = p.unrealizedPnlUsd ?? ((p.currentValueUsd ?? p.amountUsd) - (p.principalUsd ?? p.amountUsd));
                  return (
                    <div key={p.id} className="position-pnl-row">
                      <span className="position-pnl-id">{p.protocol} · {p.chain} · {p.asset}</span>
                      <span className="position-pnl-principal">${(p.principalUsd ?? p.amountUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                      <span className={`position-pnl-value ${pnlClass(pnl)}`}>{formatPnl(pnl)}</span>
                      {p.netApy !== null && (
                        <span className="position-pnl-apy">{(p.netApy * 100).toFixed(2)}% APY</span>
                      )}
                      <span className={`badge ${p.status === "active" ? "badge-low" : "badge-medium"}`}>{p.status}</span>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}

      <div className="command-grid">
        <div className="command-panel">
          <h3>노출 집중도</h3>
          <div className="exposure-list">
            {assessment.protocolExposure.slice(0, 4).map((item) => (
              <div key={item.name} className="exposure-row">
                <div>
                  <strong>{item.name}</strong>
                  <span>${item.amountUsd.toFixed(2)}</span>
                </div>
                <div className="exposure-bar" aria-label={`${item.name} ${(item.weight * 100).toFixed(1)}%`}>
                  <span style={{ width: `${Math.min(item.weight * 100, 100)}%` }} />
                </div>
                <b>{(item.weight * 100).toFixed(1)}%</b>
              </div>
            ))}
            {assessment.protocolExposure.length === 0 ? <p className="muted-copy">예치 후 프로토콜 노출이 표시됩니다.</p> : null}
          </div>
        </div>

        <div className="command-panel">
          <h3>체인 가드레일</h3>
          <div className="chain-grid">
            {assessment.chainExposure.map((item) => {
              const target = getTargetChainWeight(item.chain);
              const drift = target > 0 ? item.weight - target : item.weight;
              return (
                <div key={item.chain} className="chain-tile">
                  <span className="kpi-label">{item.chain}</span>
                  <strong>{(item.weight * 100).toFixed(1)}%</strong>
                  <small>목표 대비 {target > 0 ? `${(drift * 100).toFixed(1)}%p` : "별도 검토"}</small>
                </div>
              );
            })}
            {assessment.chainExposure.length === 0 ? <p className="muted-copy">예치 후 체인 노출이 표시됩니다.</p> : null}
          </div>
        </div>
      </div>

      <div className="command-grid">
        <div className="command-panel command-panel-accent">
          <h3>다음 조치</h3>
          {assessment.rebalanceHints.length > 0 ? (
            <div className="rebalance-list">
              {assessment.rebalanceHints.map((hint) => (
                <article key={`${hint.from}-${hint.to}-${hint.reason}`} className={`rebalance-card rebalance-${hint.priority}`}>
                  <div>
                    <span className="kpi-label">{hint.priority.toUpperCase()}</span>
                    <strong>
                      {hint.from} → {hint.to}
                    </strong>
                  </div>
                  <p>{hint.reason}</p>
                  <small>검토 금액 ${hint.amountUsd.toFixed(2)}</small>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-copy">현재는 즉시 리밸런싱 후보가 없습니다. APR·유동성 데이터 갱신 후 재점검하세요.</p>
          )}
          {onOpenExecution ? (
            <button type="button" className="command-primary-btn" onClick={onOpenExecution}>
              실행 보드에서 dry-run 확인
            </button>
          ) : null}
        </div>

        <div className="command-panel">
          <h3>보안 체크</h3>
          <div className="control-list">
            {assessment.controls.map((control) => (
              <div key={control.label} className={`control-item control-${control.status}`}>
                <span>{control.label}</span>
                <strong>{controlStatusLabel(control.status)}</strong>
                <small>{control.detail}</small>
              </div>
            ))}
          </div>
        </div>
      </div>

      {latestPosition ? (
        <div className="latest-position-strip">
          <span>최근 포지션</span>
          <strong>{latestPosition.productName}</strong>
          <span>${latestPosition.amountUsd.toFixed(2)}</span>
          <span>{describePositionChainMix(latestPosition)}</span>
        </div>
      ) : null}

      <div className="reason-list" aria-label="리스크 산정 근거">
        {assessment.reasons.map((reason) => (
          <span key={reason}>{reason}</span>
        ))}
      </div>
    </section>
  );
}
