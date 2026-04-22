import { createContext, useContext, useMemo, type ReactNode } from "react";
import { AddressType } from "@phantom/browser-sdk";
import { useAccounts } from "@phantom/react-sdk";
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
  const accounts = useAccounts();
  const solanaAccount = accounts?.find((account) => account.addressType === AddressType.solana);
  const evmAccount = accounts?.find((account) => account.addressType === AddressType.ethereum);
  const walletAddress = evmAccount?.address ?? solanaAccount?.address;
  const portfolio = usePortfolio(session, walletAddress);
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
