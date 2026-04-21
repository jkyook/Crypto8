import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listDepositPositions,
  listOnchainPositions,
  listWithdrawalLedger,
  withdrawDepositRemote,
  withdrawProductDepositRemote,
  withdrawProtocolExposureRemote,
  type AuthSession,
  type OnchainPositionPayload
} from "../lib/api";
import {
  GUEST_WITHDRAW_LEDGER_KEY,
  PORTFOLIO_NOTICE_AUTO_DISMISS_MS
} from "../lib/constants";
import {
  applyLifoWithdraw,
  applyProductWithdraw,
  applyTargetedWithdraw
} from "../lib/withdrawStrategies";
import type { WalletWithdrawLedgerLine } from "../components/WalletPanel";
import type { DepositPosition, ProtocolDetailRow } from "../types/portfolio";

export type PortfolioNotice = { variant: "error" | "info"; text: string };

/**
 * 포트폴리오 전반(예치 포지션 + 출금 장부 + 인출 3종 핸들러)을 한 훅에서 관리한다.
 * 세션이 있으면 서버 API, 없으면 로컬 상태 + localStorage 장부를 사용한다.
 *
 * App.tsx의 prop drilling을 줄이기 위한 1차 캡슐화 단계이며,
 * 이후 Context/React Query 도입 시 이 훅 내부만 교체하면 되도록 설계.
 */
export function usePortfolio(session: AuthSession | null) {
  const [positions, setPositions] = useState<DepositPosition[]>([]);
  const [onchainPositions, setOnchainPositions] = useState<OnchainPositionPayload[]>([]);
  const [withdrawLedger, setWithdrawLedger] = useState<WalletWithdrawLedgerLine[]>([]);
  const [portfolioNotice, setPortfolioNotice] = useState<PortfolioNotice | null>(null);

  const canPersistPortfolio = Boolean(session);
  const portfolioTotalUsd = useMemo(
    () => positions.reduce((acc, p) => acc + p.amountUsd, 0),
    [positions]
  );

  const refreshWithdrawLedgerFromServer = useCallback(async () => {
    if (!session) return;
    try {
      const rows = await listWithdrawalLedger();
      setWithdrawLedger(rows);
    } catch {
      setWithdrawLedger([]);
    }
  }, [session]);

  const refreshPositions = useCallback(async () => {
    if (!session) return;
    try {
      const rows = await listDepositPositions();
      setPositions(rows);
    } catch {
      setPositions([]);
    }
  }, [session]);

  const refreshOnchainPositions = useCallback(async () => {
    if (!session) return;
    try {
      const rows = await listOnchainPositions();
      setOnchainPositions(rows);
    } catch {
      setOnchainPositions([]);
    }
  }, [session]);

  const appendGuestLedgerEntry = (amountUsd: number) => {
    setWithdrawLedger((prev) => {
      const next = [{ id: `wd_${Date.now()}`, amountUsd, createdAt: new Date().toISOString() }, ...prev];
      try {
        localStorage.setItem(GUEST_WITHDRAW_LEDGER_KEY, JSON.stringify(next));
      } catch {
        /* 저장 실패 무시 */
      }
      return next;
    });
  };

  const handleWithdrawPosition = useCallback(
    async (amountUsd: number) => {
      if (amountUsd <= 0) return;
      setPortfolioNotice(null);
      try {
        if (canPersistPortfolio) {
          const { withdrawnUsd, mode } = await withdrawDepositRemote(amountUsd);
          await refreshPositions();
          await refreshWithdrawLedgerFromServer();
          if (mode === "ledger") {
            setPortfolioNotice({
              variant: "info",
              text: `포트폴리오 장부에 $${withdrawnUsd.toFixed(2)} 인출 반영 완료. 실제 온체인 출금은 Aave 앱(app.aave.com)에서 별도로 진행해 주세요.`
            });
          } else if (withdrawnUsd <= 0 && amountUsd > 0) {
            setPortfolioNotice({ variant: "info", text: "인출할 예치 잔액이 없습니다." });
          } else if (withdrawnUsd < amountUsd) {
            setPortfolioNotice({
              variant: "info",
              text: `요청 ${amountUsd.toLocaleString("ko-KR")} USD 중 실제 반영 ${withdrawnUsd.toFixed(2)} USD입니다.`
            });
          }
        } else {
          setPositions((prev) => applyLifoWithdraw(prev, amountUsd));
          appendGuestLedgerEntry(amountUsd);
        }
      } catch (err) {
        setPortfolioNotice({
          variant: "error",
          text: err instanceof Error ? err.message : "인출에 실패했습니다."
        });
      }
    },
    [canPersistPortfolio, refreshPositions, refreshWithdrawLedgerFromServer]
  );

  const handleWithdrawProtocolExposure = useCallback(
    async (amountUsd: number, target: Pick<ProtocolDetailRow, "name" | "chain" | "pool">): Promise<{ mode?: string }> => {
      if (amountUsd <= 0) return {};
      setPortfolioNotice(null);
      try {
        if (canPersistPortfolio) {
          const { withdrawnUsd, mode } = await withdrawProtocolExposureRemote({
            amountUsd,
            protocol: target.name,
            chain: target.chain,
            pool: target.pool
          });
          await refreshPositions();
          await refreshWithdrawLedgerFromServer();
          if (mode === "ledger") {
            setPortfolioNotice({
              variant: "info",
              text: `포트폴리오 장부에 $${withdrawnUsd.toFixed(2)} 인출 반영 완료. 실제 온체인 출금은 Aave 앱(app.aave.com)에서 별도로 진행해 주세요.`
            });
          } else if (withdrawnUsd <= 0 && amountUsd > 0) {
            setPortfolioNotice({ variant: "info", text: "해당 풀에서 인출할 예치 잔액이 없습니다." });
          } else if (withdrawnUsd < amountUsd) {
            setPortfolioNotice({
              variant: "info",
              text: `요청 ${amountUsd.toLocaleString("ko-KR")} USD 중 해당 풀에서 실제 반영 ${withdrawnUsd.toFixed(2)} USD입니다.`
            });
          }
          return { mode };
        } else {
          setPositions((prev) => applyTargetedWithdraw(prev, amountUsd, target));
          appendGuestLedgerEntry(amountUsd);
          return {};
        }
      } catch (err) {
        setPortfolioNotice({
          variant: "error",
          text: err instanceof Error ? err.message : "풀별 인출에 실패했습니다."
        });
        return {};
      }
    },
    [canPersistPortfolio, refreshPositions, refreshWithdrawLedgerFromServer]
  );

  const handleWithdrawProductDeposit = useCallback(
    async (amountUsd: number, productName: string) => {
      if (amountUsd <= 0) return;
      setPortfolioNotice(null);
      try {
        if (canPersistPortfolio) {
          const { withdrawnUsd, mode } = await withdrawProductDepositRemote({ amountUsd, productName });
          await refreshPositions();
          await refreshWithdrawLedgerFromServer();
          if (mode === "ledger") {
            setPortfolioNotice({
              variant: "info",
              text: `포트폴리오 장부에 $${withdrawnUsd.toFixed(2)} 인출 반영 완료. 실제 온체인 출금은 Aave 앱(app.aave.com)에서 별도로 진행해 주세요.`
            });
          } else if (withdrawnUsd <= 0 && amountUsd > 0) {
            setPortfolioNotice({ variant: "info", text: "선택 상품으로 인출할 예치 잔액이 없습니다." });
          } else if (withdrawnUsd < amountUsd) {
            setPortfolioNotice({
              variant: "info",
              text: `요청 ${amountUsd.toLocaleString("ko-KR")} USD 중 ${productName}에서 실제 반영 ${withdrawnUsd.toFixed(2)} USD입니다.`
            });
          }
        } else {
          setPositions((prev) => applyProductWithdraw(prev, amountUsd, productName));
          appendGuestLedgerEntry(amountUsd);
        }
      } catch (err) {
        setPortfolioNotice({
          variant: "error",
          text: err instanceof Error ? err.message : "상품별 인출에 실패했습니다."
        });
      }
    },
    [canPersistPortfolio, refreshPositions, refreshWithdrawLedgerFromServer]
  );

  useEffect(() => {
    if (!portfolioNotice) return;
    const timer = window.setTimeout(() => setPortfolioNotice(null), PORTFOLIO_NOTICE_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [portfolioNotice]);

  return {
    positions,
    setPositions,
    onchainPositions,
    setOnchainPositions,
    withdrawLedger,
    setWithdrawLedger,
    portfolioNotice,
    setPortfolioNotice,
    canPersistPortfolio,
    portfolioTotalUsd,
    refreshPositions,
    refreshOnchainPositions,
    refreshWithdrawLedgerFromServer,
    handleWithdrawPosition,
    handleWithdrawProtocolExposure,
    handleWithdrawProductDeposit
  };
}
