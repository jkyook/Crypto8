import type { ReactNode } from "react";

export function StrategiesPage({
  children,
  onOpenTrade,
  onOpenPortfolio
}: {
  children: ReactNode;
  onOpenTrade: () => void;
  onOpenPortfolio: () => void;
}) {
  return (
    <div className="page-shell strategy-page-shell">
      <section className="mission-hero mission-hero--strategy card">
        <div>
          <p className="section-eyebrow">Pools</p>
          <h1>수익 풀을 고르고, 실행 전 리스크를 비교합니다</h1>
          <p>
            Aave, Uniswap, Orca 배분을 상품 단위로 비교하고 APR, 수수료, 기간 수익, 표준 L2 배분안을 함께 검토합니다.
          </p>
        </div>
        <div className="mission-action-stack">
          <button onClick={onOpenPortfolio}>포지션 관제</button>
          <button className="ghost-btn" onClick={onOpenTrade}>외부 Swap</button>
        </div>
      </section>
      {children}
    </div>
  );
}
