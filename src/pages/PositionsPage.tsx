import type { ReactNode } from "react";
import type { MenuKey } from "../lib/menu";

export function PositionsPage({
  children,
  onGo
}: {
  children: ReactNode;
  onGo: (menu: MenuKey) => void;
}) {
  return (
    <div className="page-shell positions-page-shell">
      <section className="mission-hero mission-hero--positions card">
        <div>
          <p className="section-eyebrow">Positions</p>
          <h1>포지션 및 프로토콜별 노출을 관리합니다</h1>
          <p>
            체인·프로토콜별 노출과 예치 건별 상세를 확인합니다.
          </p>
        </div>
        <div className="mission-action-stack">
          <button onClick={() => onGo("products")}>추가 예치</button>
          <button className="ghost-btn" onClick={() => onGo("execution")}>리밸런싱 실행</button>
        </div>
      </section>
      {children}
    </div>
  );
}
