import { useEffect, useState } from "react";
import { ChainExposureDonut } from "../common/ChainExposureDonut";
import { TradeControls } from "../common/TradeControls";
import { OrchestratorBoard } from "../OrchestratorBoard";
import { getSession, login } from "../../lib/api";
import { DEFAULT_TARGET_APR, WITHDRAW_DONE_TOAST_MS } from "../../lib/constants";
import { estimateAnnualYieldUsd } from "../../lib/portfolioMetrics";
import { getProtocolSortRank, inferProtocolChain } from "../../lib/protocolChain";
import type { ProtocolDetailRow } from "../../types/portfolio";
import { usePortfolioContext } from "../../contexts/PortfolioContext";

export function PortfolioPanel() {
  const {
    positions,
    onchainPositions,
    canPersistPortfolio,
    handleWithdrawProtocolExposure,
    refreshPositions,
    refreshWithdrawLedgerFromServer,
    refreshOnchainPositions
  } = usePortfolioContext();
  const [protocolAmounts, setProtocolAmounts] = useState<Record<string, number>>({});
  const [protocolDepositDraft, setProtocolDepositDraft] = useState<ProtocolDetailRow | null>(null);
  const [protocolDepositKey, setProtocolDepositKey] = useState(0);
  const [showPositionDetails, setShowPositionDetails] = useState(false);

  const [withdrawDraft, setWithdrawDraft] = useState<{ row: ProtocolDetailRow; maxUsd: number } | null>(null);
  const [withdrawAmtUsd, setWithdrawAmtUsd] = useState(0);
  const [withdrawVerifyPwd, setWithdrawVerifyPwd] = useState("");
  const [withdrawVerifyLoading, setWithdrawVerifyLoading] = useState(false);
  const [withdrawVerifyError, setWithdrawVerifyError] = useState("");
  const [withdrawDoneMsg, setWithdrawDoneMsg] = useState("");

  const withdrawAmount = Number(withdrawAmtUsd.toFixed(2));

  const onOpenWithdraw = (row: ProtocolDetailRow) => {
    const inputAmt = protocolAmounts[row.key] ?? 0;
    const initAmt = inputAmt > 0 && inputAmt <= row.amount ? inputAmt : row.amount;
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
      const { mode } = await handleWithdrawProtocolExposure(withdrawAmount, {
        name: withdrawDraft.row.name,
        chain: withdrawDraft.row.chain,
        pool: withdrawDraft.row.pool
      });
      const doneMsg =
        mode === "ledger"
          ? `$${withdrawAmount.toFixed(2)} 장부 인출 반영 완료 — 온체인 출금은 Aave 앱에서 직접 진행해 주세요`
          : `$${withdrawAmount.toFixed(2)} 인출 처리 완료`;
      setWithdrawDraft(null);
      setWithdrawVerifyPwd("");
      setWithdrawDoneMsg(doneMsg);
      window.setTimeout(() => setWithdrawDoneMsg(""), WITHDRAW_DONE_TOAST_MS);
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
  const verificationCounts = onchainPositions.reduce(
    (acc, position) => {
      const status = position.verify?.status ?? "rpc_error";
      if (status === "verified") acc.verified += 1;
      else if (status === "drift") acc.drift += 1;
      else if (status === "closed_onchain") acc.closed += 1;
      else if (status === "rpc_error") acc.rpcError += 1;
      else acc.unsupported += 1;
      return acc;
    },
    { verified: 0, drift: 0, closed: 0, rpcError: 0, unsupported: 0 }
  );

  useEffect(() => {
    void refreshOnchainPositions();
  }, [refreshOnchainPositions]);

  const positionStatusBadge = (status: string) => {
    if (status === "verified") return "badge badge-low";
    if (status === "drift") return "badge badge-medium";
    if (status === "closed_onchain") return "badge badge-high";
    if (status === "rpc_error") return "badge badge-critical";
    return "badge badge-medium";
  };

  const positionStatusLabel = (status: string) => {
    if (status === "verified") return "확인됨";
    if (status === "drift") return "차이 있음";
    if (status === "closed_onchain") return "온체인 종료";
    if (status === "rpc_error") return "조회 실패";
    return "미지원";
  };

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
      <div className="portfolio-section-head">
        <div>
          <h3>온체인 검증 포지션</h3>
          <p>새 positions 테이블 기준으로 DB 금액과 온체인 잔고를 함께 보여줍니다.</p>
        </div>
        <div className="portfolio-overview-metrics">
          <div>
            <span>확인됨</span>
            <strong>{verificationCounts.verified}건</strong>
          </div>
          <div>
            <span>차이 있음</span>
            <strong>{verificationCounts.drift}건</strong>
          </div>
          <div>
            <span>조회 실패</span>
            <strong>{verificationCounts.rpcError}건</strong>
          </div>
        </div>
      </div>
      <table className="protocol-detail-table portfolio-onchain-table">
        <thead>
          <tr>
            <th>프로토콜</th>
            <th>체인</th>
            <th>상태</th>
            <th>DB 금액</th>
            <th>온체인 금액</th>
            <th>drift</th>
            <th>검증 시각</th>
            <th>메모</th>
          </tr>
        </thead>
        <tbody>
          {onchainPositions.map((position) => {
            const verify = position.verify ?? undefined;
            const status = verify?.status ?? position.status;
            return (
              <tr key={position.id}>
                <td data-label="프로토콜">{position.protocol}</td>
                <td data-label="체인">{position.chain}</td>
                <td data-label="상태">
                  <span className={positionStatusBadge(status)}>
                    {positionStatusLabel(status)}
                  </span>
                </td>
                <td data-label="DB 금액">${position.amountUsd.toFixed(2)}</td>
                <td data-label="온체인 금액">{verify?.onchainAmountUsd == null ? "—" : `$${verify.onchainAmountUsd.toFixed(2)}`}</td>
                <td data-label="drift">{verify?.driftPct == null ? "—" : `${verify.driftPct.toFixed(1)}%`}</td>
                <td data-label="검증 시각">{verify?.verifiedAt ? new Date(verify.verifiedAt).toLocaleString() : "—"}</td>
                <td data-label="메모">{verify?.detail ?? "—"}</td>
              </tr>
            );
          })}
          {onchainPositions.length === 0 ? (
            <tr>
              <td colSpan={8}>아직 온체인 검증 포지션이 없습니다.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
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
                    disabled={!canPersistPortfolio || row.amount <= 0}
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
              initialEstYieldUsd={protocolDepositDraft.amount * DEFAULT_TARGET_APR}
              initialEstFeeUsd={0}
              previewRowsOverride={[
                {
                  protocol: protocolDepositDraft.name,
                  chain: protocolDepositDraft.chain,
                  action: protocolDepositDraft.pool.replace(`${protocolDepositDraft.chain} · `, ""),
                  allocationUsd: protocolDepositDraft.amount
                }
              ]}
              onExecutionComplete={async () => {
                await refreshPositions();
                await refreshOnchainPositions();
                await refreshWithdrawLedgerFromServer();
              }}
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
