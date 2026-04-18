import { useMemo, useState } from "react";
import { buildPlan } from "../lib/strategyEngine";

export type DepositPlannerProps = {
  /** 부모와 동기화할 때 금액 + 변경 핸들러를 함께 넘깁니다. */
  depositUsd?: number;
  onDepositUsdChange?: (value: number) => void;
  /** `embedded`: 예치상품 등 부모 카드 안에서 표시(금액 입력은 부모에 위임). */
  variant?: "standalone" | "embedded";
  /** `embedded` 전용: 하단 보조 영역용 작은 타이포·여백. */
  embeddedCompact?: boolean;
};

export function DepositPlanner({
  depositUsd: controlledUsd,
  onDepositUsdChange,
  variant = "standalone",
  embeddedCompact = false
}: DepositPlannerProps) {
  const [internalUsd, setInternalUsd] = useState(1000);
  const isControlled = controlledUsd !== undefined && onDepositUsdChange !== undefined;
  const depositUsd = isControlled ? controlledUsd : internalUsd;
  const setDepositUsd = isControlled ? onDepositUsdChange : setInternalUsd;
  const plan = useMemo(() => buildPlan(depositUsd), [depositUsd]);

  const showAmountInput = !isControlled || variant === "standalone";
  const kpiAndTable = (
    <>
      <div className="result">
        <div className="kpi-grid">
          <div className="kpi-item">
            <p className="kpi-label">총 예치금</p>
            <p className="kpi-value">${plan.totalDepositUsd.toLocaleString()}</p>
          </div>
          <div className="kpi-item">
            <p className="kpi-label">예상 연 수익</p>
            <p className="kpi-value">${plan.expectedAnnualYieldUsd.toFixed(2)}</p>
          </div>
        </div>
      </div>

      <table className="deposit-planner-table">
        <thead>
          <tr>
            <th>자산</th>
            <th>체인</th>
            <th>비중</th>
            <th>배분 금액</th>
            <th>기대 APR</th>
          </tr>
        </thead>
        <tbody>
          {plan.items.map((item) => (
            <tr key={item.key}>
              <td>{item.label}</td>
              <td>{item.chain}</td>
              <td>{(item.targetWeight * 100).toFixed(1)}%</td>
              <td>${item.allocationUsd.toFixed(2)}</td>
              <td>{(item.expectedApr * 100).toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );

  if (variant === "embedded") {
    return (
      <div className={embeddedCompact ? "deposit-planner-embedded deposit-planner-embedded--compact" : "deposit-planner-embedded"}>
        <p className={embeddedCompact ? "deposit-l2-foot-title" : "product-pool-title"}>Option L2* 전략 배분 (자산·체인)</p>
        {kpiAndTable}
      </div>
    );
  }

  return (
    <section className="card">
      <h2>예치 계획 생성</h2>
      {showAmountInput ? (
        <>
          <label htmlFor="deposit-planner-amount">예치 금액 (USD)</label>
          <input
            id="deposit-planner-amount"
            type="number"
            min={100}
            step={100}
            value={depositUsd}
            onChange={(event) => setDepositUsd(Number(event.target.value))}
          />
        </>
      ) : null}
      {kpiAndTable}
    </section>
  );
}
