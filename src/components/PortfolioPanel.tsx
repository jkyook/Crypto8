import { useMemo, useState } from "react";
import { getSession, login } from "../lib/api";
import { aggregateChainUsdFromPositions, estimateAnnualYieldUsd } from "../lib/portfolioMetrics";
import { OPTION_L2_STAR } from "../lib/strategyEngine";
import { OrchestratorBoard } from "./OrchestratorBoard";
import type { DepositPosition, ProtocolDetailRow } from "../types";

const PORTFOLIO_DONUT_COLORS = ["#8b7bff", "#3bd4ff", "#47d9a8", "#ffb86b"];
const PROTOCOL_SORT_ORDER = ["Aave", "Uniswap", "Orca"] as const;

function inferProtocolChain(protocolName: string, poolLabel?: string): string {
  if (poolLabel) {
    const chainPart = poolLabel.split("·")[0].trim().split("/")[0].trim();
    const lc = chainPart.toLowerCase();
    if (lc === "arbitrum" || lc.includes("arbitrum")) return "Arbitrum";
    if (lc === "base" || lc.includes("base")) return "Base";
    if (lc === "solana" || lc.includes("solana")) return "Solana";
    if (lc === "ethereum" || lc.includes("ethereum")) return "Ethereum";
    if (lc === "sol") return "Solana";
    if (lc === "eth") return "Ethereum";
  }
  const key = protocolName.toLowerCase();
  if (key.includes("orca")) return "Solana";
  if (key.includes("aave")) return "Arbitrum";
  if (key.includes("uniswap")) return "Arbitrum";
  return "Multi";
}

function getProtocolSortRank(protocolName: string): number {
  const key = protocolName.toLowerCase();
  const rank = PROTOCOL_SORT_ORDER.findIndex((name) => key.includes(name.toLowerCase()));
  return rank === -1 ? PROTOCOL_SORT_ORDER.length : rank;
}

function ChainExposureDonut({
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

function TradeControls({
  onDeposit,
  onWithdraw,
  disabled,
  size = "compact"
}: {
  onDeposit: () => void;
  onWithdraw: () => void;
  disabled?: boolean;
  size?: "compact" | "large";
}) {
  return (
    <div className={`inline-trade-controls inline-trade-controls--${size}`} aria-label="입금 인출">
      <button type="button" className="inline-trade-btn inline-trade-btn-plus" onClick={onDeposit} disabled={disabled} aria-label="입금">
        +
      </button>
      <button type="button" className="inline-trade-btn inline-trade-btn-minus" onClick={onWithdraw} disabled={disabled} aria-label="인출">
        -
      </button>
    </div>
  );
}

export function PortfolioPanel({
  positions,
  onExecutionComplete,
  onWithdraw,
  onWithdrawTarget,
  canPersistToServer
}: {
  positions: DepositPosition[];
  onExecutionComplete?: () => void | Promise<void>;
  onWithdraw?: (amountUsd: number) => Promise<void>;
  onWithdrawTarget?: (amountUsd: number, target: Pick<ProtocolDetailRow, "name" | "chain" | "pool">) => Promise<void>;
  canPersistToServer?: boolean;
}) {
  const [protocolAmounts, setProtocolAmounts] = useState<Record<string, number>>({});
  const [protocolDepositDraft, setProtocolDepositDraft] = useState<ProtocolDetailRow | null>(null);
  const [protocolDepositKey, setProtocolDepositKey] = useState(0);
  const [showPositionDetails, setShowPositionDetails] = useState(false);

  // ── 인출 상태 ──────────────────────────────────────────────
  const [withdrawDraft, setWithdrawDraft] = useState<{ row: ProtocolDetailRow; maxUsd: number } | null>(null);
  const [withdrawAmtUsd, setWithdrawAmtUsd] = useState(0);
  const [withdrawVerifyPwd, setWithdrawVerifyPwd] = useState("");
  const [withdrawVerifyLoading, setWithdrawVerifyLoading] = useState(false);
  const [withdrawVerifyError, setWithdrawVerifyError] = useState("");
  const [withdrawDoneMsg, setWithdrawDoneMsg] = useState("");

  const withdrawAmount = Number(withdrawAmtUsd.toFixed(2));

  const onOpenWithdraw = (row: ProtocolDetailRow) => {
    const inputAmt = protocolAmounts[row.key] ?? 0;
    const initAmt = inputAmt > 0 && inputAmt <= row.amount
      ? inputAmt
      : row.amount;
    setWithdrawDraft({ row, maxUsd: row.amount });
    setWithdrawAmtUsd(Number(initAmt.toFixed(2)));
    setWithdrawVerifyPwd("");
    setWithdrawVerifyError("");
    setWithdrawDoneMsg("");
  };

  const onConfirmWithdraw = async () => {
    if (!withdrawDraft || withdrawAmount <= 0) return;
    const session = getSession();
    if (!session) {
      setWithdrawVerifyError("세션이 만료되었습니다. 다시 로그인해 주세요.");
      return;
    }
    if (!withdrawVerifyPwd) {
      setWithdrawVerifyError("비밀번호를 입력하세요.");
      return;
    }
    setWithdrawVerifyLoading(true);
    setWithdrawVerifyError("");
    try {
      await login(session.username, withdrawVerifyPwd);
      await (onWithdrawTarget
        ? onWithdrawTarget(withdrawAmount, {
            name: withdrawDraft.row.name,
            chain: withdrawDraft.row.chain,
            pool: withdrawDraft.row.pool
          })
        : onWithdraw?.(withdrawAmount));
      const doneMsg = `$${withdrawAmount.toFixed(2)} 인출 처리 완료`;
      setWithdrawDraft(null);
      setWithdrawVerifyPwd("");
      setWithdrawDoneMsg(doneMsg);
      window.setTimeout(() => setWithdrawDoneMsg(""), 5000);
    } catch (error) {
      setWithdrawVerifyError(error instanceof Error ? error.message : "인출 확인 실패");
    } finally {
      setWithdrawVerifyLoading(false);
    }
  };
  const totalDeposited = positions.reduce((acc, item) => acc + item.amountUsd, 0);
  const protocolTotals = positions.reduce<Record<string, ProtocolDetailRow>>((acc, item) => {
    item.protocolMix.forEach((mix) => {
      const chain = inferProtocolChain(mix.name, mix.pool);
      const pool = mix.pool ?? `${chain} · ${mix.name}`;
      const key = `${mix.name}__${chain}__${pool}`;
      const prev = acc[key];
      acc[key] = {
        key,
        name: mix.name,
        chain,
        pool,
        amount: (prev?.amount ?? 0) + item.amountUsd * mix.weight
      };
    });
    return acc;
  }, {});
  const protocolRows = Object.values(protocolTotals).sort((a, b) => {
    const byProtocolRank = getProtocolSortRank(a.name) - getProtocolSortRank(b.name);
    if (byProtocolRank !== 0) return byProtocolRank;
    const byName = a.name.localeCompare(b.name, "ko-KR", { sensitivity: "base" });
    if (byName !== 0) return byName;
    const byChain = a.chain.localeCompare(b.chain, "ko-KR", { sensitivity: "base" });
    if (byChain !== 0) return byChain;
    return a.pool.localeCompare(b.pool, "ko-KR", { sensitivity: "base" });
  });
  const annualYield = estimateAnnualYieldUsd(positions);

  return (
    <section className="card portfolio-panel-card">
      <div className="portfolio-overview-hero">
        <div>
          <p className="section-eyebrow">Positions Overview</p>
          <h2>${totalDeposited.toLocaleString(undefined, { maximumFractionDigits: 2 })}</h2>
          <p>입금된 상품과 프로토콜 노출을 기준으로 운영 상태를 크게 보여줍니다.</p>
        </div>
        <div className="portfolio-overview-metrics">
          <div>
            <span>예치 건수</span>
            <strong>{positions.length}건</strong>
          </div>
          <div>
            <span>프로토콜 수</span>
            <strong>{new Set(protocolRows.map((row) => row.name)).size}개</strong>
          </div>
          <div>
            <span>추정 연 수익</span>
            <strong>${Math.round(annualYield).toLocaleString()}</strong>
          </div>
        </div>
        <ChainExposureDonut positions={positions} compact />
      </div>
      <h3>프로토콜별 예치 상세</h3>
      <table className="protocol-detail-table">
        <thead>
          <tr>
            <th>프로토콜</th>
            <th>체인</th>
            <th>풀</th>
            <th>예치 금액 (USD)</th>
            <th>비중</th>
            <th>입출금</th>
          </tr>
        </thead>
        <tbody>
          {protocolRows.map((row) => (
            <tr key={row.key}>
              <td>{row.name}</td>
              <td>{row.chain}</td>
              <td className="product-pool-pool-label">{row.pool}</td>
              <td>${row.amount.toFixed(2)}</td>
              <td>
                <span className="protocol-weight-cell">{totalDeposited > 0 ? ((row.amount / totalDeposited) * 100).toFixed(1) : "0.0"}%</span>
              </td>
              <td>
                <div className="protocol-inline-transfer">
                  <input
                    type="number"
                    min={1}
                    step={100}
                    value={protocolAmounts[row.key] ?? Math.max(100, Math.round(row.amount || 100))}
                    onChange={(event) =>
                      setProtocolAmounts((prev) => ({
                        ...prev,
                        [row.key]: Number(event.target.value)
                      }))
                    }
                    aria-label={`${row.name} ${row.chain} 입출금 금액`}
                  />
                  <TradeControls
                    onDeposit={() => {
                      const input = protocolAmounts[row.key] ?? Math.max(100, Math.round(row.amount || 100));
                      if (!Number.isFinite(input) || input <= 0) return;
                      setProtocolAmounts((prev) => ({ ...prev, [row.key]: input + 100 }));
                    }}
                    onWithdraw={() => {
                      const input = protocolAmounts[row.key] ?? Math.max(100, Math.round(row.amount || 100));
                      if (!Number.isFinite(input) || input <= 0) return;
                      setProtocolAmounts((prev) => ({ ...prev, [row.key]: Math.max(0, input - 100) }));
                    }}
                  />
                  <button
                    type="button"
                    className="protocol-deposit-action"
                    onClick={() => {
                      const input = protocolAmounts[row.key] ?? Math.max(100, Math.round(row.amount || 100));
                      if (!Number.isFinite(input) || input <= 0) return;
                      setProtocolDepositDraft({ ...row, amount: input });
                      setProtocolDepositKey((prev) => prev + 1);
                    }}
                    title="조정한 금액으로 입금 처리 팝업을 엽니다. 포지션은 내 계정 기준으로 기록됩니다."
                  >
                    입금
                  </button>
                  <button
                    type="button"
                    className="protocol-withdraw-action"
                    onClick={() => onOpenWithdraw(row)}
                    title="이 프로토콜에서 인출합니다."
                    disabled={!canPersistToServer || row.amount <= 0}
                  >
                    인출
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {protocolRows.length === 0 ? (
            <tr>
              <td colSpan={6}>아직 예치 내역이 없습니다.</td>
            </tr>
          ) : (
            <tr className="protocol-total-row">
              <td>합계</td>
              <td>—</td>
              <td>—</td>
              <td>${totalDeposited.toFixed(2)}</td>
              <td>
                <span className="protocol-weight-cell">{totalDeposited > 0 ? "100.0" : "0.0"}%</span>
              </td>
              <td>—</td>
            </tr>
          )}
        </tbody>
      </table>
      {/* ── 인출 확인 패널 ── */}
      {withdrawDraft ? (
        <div className="protocol-withdraw-confirm" role="dialog" aria-label="인출 확인">
          <p className="protocol-withdraw-confirm-title">
            💸 {withdrawDraft.row.name} · {withdrawDraft.row.chain} 인출
          </p>
          <p className="protocol-withdraw-confirm-desc">
            {withdrawDraft.row.pool} 현재 잔액 <strong>${withdrawDraft.maxUsd.toFixed(2)}</strong> — 슬라이더로 인출 금액을 조절하세요.
          </p>
          <div className="protocol-withdraw-slider-row">
            <span className="protocol-withdraw-slider-label">$0</span>
            <input
              type="range"
              min={0}
              max={withdrawDraft.maxUsd}
              step={Math.max(1, Math.round(withdrawDraft.maxUsd / 100))}
              value={withdrawAmtUsd}
              onChange={(e) => setWithdrawAmtUsd(Number(e.target.value))}
              className="protocol-withdraw-slider"
              aria-label="인출 금액"
              disabled={withdrawVerifyLoading}
            />
            <span className="protocol-withdraw-slider-label">${withdrawDraft.maxUsd.toFixed(0)}</span>
            <strong className="protocol-withdraw-amount-badge">
              ${withdrawAmount.toFixed(2)}
              {withdrawDraft.maxUsd > 0
                ? <em>({((withdrawAmount / withdrawDraft.maxUsd) * 100).toFixed(0)}%)</em>
                : null}
            </strong>
          </div>
          <label className="exec-verify-label">
            비밀번호 확인
            <input
              type="password"
              className="exec-verify-input"
              value={withdrawVerifyPwd}
              onChange={(e) => setWithdrawVerifyPwd(e.target.value)}
              disabled={withdrawVerifyLoading}
              autoFocus
              autoComplete="current-password"
              onKeyDown={(e) => e.key === "Enter" && void onConfirmWithdraw()}
            />
          </label>
          {withdrawVerifyError ? (
            <p className="exec-verify-error">{withdrawVerifyError}</p>
          ) : null}
          <div className="exec-verify-actions">
            <button
              type="button"
              className="auth-primary-btn protocol-withdraw-confirm-btn"
              onClick={() => void onConfirmWithdraw()}
              disabled={withdrawVerifyLoading || !withdrawVerifyPwd || withdrawAmount <= 0}
            >
              {withdrawVerifyLoading ? "처리 중…" : `$${withdrawAmount.toFixed(2)} 인출 확인`}
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                setWithdrawDraft(null);
                setWithdrawVerifyPwd("");
                setWithdrawVerifyError("");
              }}
              disabled={withdrawVerifyLoading}
            >
              취소
            </button>
          </div>
        </div>
      ) : null}
      {withdrawDoneMsg ? (
        <p className="auth-message auth-message--ok protocol-withdraw-done">{withdrawDoneMsg}</p>
      ) : null}

      {protocolDepositDraft ? (
        <div className="modal-backdrop modal-backdrop--execution" role="dialog" aria-modal="true" aria-label="프로토콜 입금 처리 팝업">
          <div className="modal-card execution-modal-card deposit-execution-modal">
            <button type="button" className="modal-close-icon" aria-label="닫기" onClick={() => setProtocolDepositDraft(null)}>
              x
            </button>
            <div className="inline-execution-panel-head">
              <div>
                <p className="section-eyebrow">Protocol Deposit</p>
                <h3>
                  {protocolDepositDraft.name} · {protocolDepositDraft.chain} 입금 처리
                </h3>
              </div>
            </div>
            <OrchestratorBoard
              key={`${protocolDepositDraft.name}-${protocolDepositKey}`}
              initialDepositUsd={protocolDepositDraft.amount}
              initialProductName={`${protocolDepositDraft.name} ${protocolDepositDraft.chain} direct pool`}
              initialEstYieldUsd={protocolDepositDraft.amount * 0.08}
              initialEstFeeUsd={0}
              previewRowsOverride={[
                {
                  protocol: protocolDepositDraft.name,
                  chain: protocolDepositDraft.chain,
                  action: protocolDepositDraft.pool.replace(`${protocolDepositDraft.chain} · `, ""),
                  allocationUsd: protocolDepositDraft.amount
                }
              ]}
              onExecutionComplete={onExecutionComplete}
            />
          </div>
        </div>
      ) : null}
      <div className="position-detail-toggle-row">
        <button type="button" className="ghost-btn" onClick={() => setShowPositionDetails((prev) => !prev)} aria-expanded={showPositionDetails}>
          예치 건별 상세내역 {showPositionDetails ? "닫기" : "보기"}
        </button>
      </div>
      {showPositionDetails ? (
        <table>
          <thead>
            <tr>
              <th>상품</th>
              <th>예치 금액</th>
              <th>예상 APR</th>
              <th>프로토콜 믹스</th>
              <th>예치 시각</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => (
              <tr key={position.id}>
                <td>{position.productName}</td>
                <td>${position.amountUsd.toFixed(2)}</td>
                <td>{(position.expectedApr * 100).toFixed(2)}%</td>
                <td>{position.protocolMix.map((mix) => `${mix.name} ${(mix.weight * 100).toFixed(0)}%`).join(" / ")}</td>
                <td>{new Date(position.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {positions.length === 0 ? (
              <tr>
                <td colSpan={5}>아직 예치 내역이 없습니다.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
