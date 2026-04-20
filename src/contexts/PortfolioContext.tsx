import { createContext, useContext, useMemo, type ReactNode } from "react";
import { usePortfolio, type PortfolioNotice } from "../hooks/usePortfolio";
import type { OnchainPositionPayload } from "../lib/api";
import type { DepositPosition } from "../types/portfolio";
import { useSessionContext } from "./SessionContext";

type PortfolioContextValue = ReturnType<typeof usePortfolio> & {
  hasSession: boolean;
  positions: DepositPosition[];
  onchainPositions: OnchainPositionPayload[];
  portfolioNotice: PortfolioNotice | null;
};

const PortfolioContext = createContext<PortfolioContextValue | null>(null);

type PortfolioProviderProps = {
  children: ReactNode;
};

export function PortfolioProvider({ children }: PortfolioProviderProps) {
  const { session } = useSessionContext();
  const portfolio = usePortfolio(session);
  const value = useMemo(
    () => ({
      ...portfolio,
      hasSession: Boolean(session)
    }),
    [portfolio, session]
  );
  return <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>;
}

export function usePortfolioContext(): PortfolioContextValue {
  const value = useContext(PortfolioContext);
  if (!value) {
    throw new Error("usePortfolioContext must be used within PortfolioProvider");
  }
  return value;
}
