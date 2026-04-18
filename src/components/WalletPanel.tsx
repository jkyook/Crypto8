import { useCallback, useEffect, useMemo, useState } from "react";
import { AddressType } from "@phantom/browser-sdk";
import { useAccounts, useConnect, useDisconnect, usePhantom } from "@phantom/react-sdk";
import type { DepositPositionPayload } from "../lib/api";
import { fetchOnChainPortfolioWithFallback, getSolanaRpcCandidates, solscanTokenUrl, type OnChainTokenRow } from "../lib/solanaChainAssets";

export type WalletWithdrawLedgerLine = {
  id: string;
  amountUsd: number;
  createdAt: string;
};

type WalletPanelProps = {
  compact?: boolean;
  /** 앱에 반영된 예치 포지션(입금 잔여). */
  positions?: DepositPositionPayload[];
  /** 이 기기·세션에서 기록한 인출(출금) 건. */
  withdrawLedger?: WalletWithdrawLedgerLine[];
  /** 예치 잔액 합계(USD). */
  portfolioUsd?: number;
  onOpenWallet?: () => void;
  onOpenActivity?: () => void;
  onOpenPortfolio?: () => void;
  onOpenMyOverview?: () => void;
};

type LedgerRow = {
  id: string;
  kind: "입금" | "출금";
  amountUsd: number;
  createdAt: string;
  productName?: string;
};

function solscanAccountUrl(address: string, network: "mainnet" | "devnet"): string {
  const base = `https://solscan.io/account/${address}`;
  return network === "devnet" ? `${base}?cluster=devnet` : base;
}

function formatTokenAmount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function NetworkStatusBlock({ network, plain }: { network: "mainnet" | "devnet"; plain?: boolean }) {
  const clusterLabel = network === "mainnet" ? "Solana 메인넷" : "Solana 개발망(데브넷)";
  const inner = (
    <div className="wallet-network-primary">
      <span className="wallet-network-dot" aria-hidden />
      <div>
        <p className="wallet-network-title">네트워크</p>
        <p className="wallet-network-cluster">
          <strong>{clusterLabel}</strong>
          <span className="wallet-network-pill">{network === "mainnet" ? "메인넷" : "데브넷"}</span>
        </p>
      </div>
    </div>
  );
  if (plain) {
    return <div className="wallet-network-inline">{inner}</div>;
  }
  return <div className="wallet-network-status">{inner}</div>;
}

function ChainAssetsTable({
  loading,
  error,
  sol,
  tokens,
  network,
  compact
}: {
  loading: boolean;
  error: string;
  sol: number | null;
  tokens: OnChainTokenRow[];
  network: "mainnet" | "devnet";
  compact: boolean;
}) {
  if (loading) {
    return <p className="wallet-chain-loading">블록체인에서 자산 조회 중…</p>;
  }
  if (error) {
    return <p className="wallet-error">{error}</p>;
  }
  return (
    <div className={compact ? "wallet-chain-table-wrap wallet-chain-table-wrap-compact" : "wallet-chain-table-wrap"}>
      <h4 className="wallet-feed-title">블록체인 자산 (SPL)</h4>
      <table className="wallet-chain-table">
        <thead>
          <tr>
            <th>자산</th>
            <th>잔고</th>
            {!compact ? <th>Mint</th> : null}
            <th>Solscan</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>SOL (네이티브)</td>
            <td className="wallet-mono">{sol !== null ? formatTokenAmount(sol) : "—"}</td>
            {!compact ? (
              <td className="wallet-mono wallet-mint-muted">—</td>
            ) : null}
            <td>—</td>
          </tr>
          {tokens.map((t) => (
            <tr key={t.mint}>
              <td>{t.symbol}</td>
              <td className="wallet-mono">{formatTokenAmount(t.amount)}</td>
              {!compact ? <td className="wallet-mono wallet-mint-muted">{t.mint}</td> : null}
              <td>
                <button
                  type="button"
                  className="wallet-linkish"
                  onClick={() => window.open(solscanTokenUrl(t.mint, network), "_blank", "noopener,noreferrer")}
                >
                  Solscan
                </button>
              </td>
            </tr>
          ))}
          {tokens.length === 0 ? (
            <tr>
              <td colSpan={compact ? 3 : 4}>SPL 토큰 계정 없음 (또는 잔고 0)</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export function WalletPanel({
  compact = false,
  positions = [],
  withdrawLedger = [],
  portfolioUsd = 0,
  onOpenWallet,
  onOpenActivity,
  onOpenPortfolio,
  onOpenMyOverview
}: WalletPanelProps) {
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { isConnected } = usePhantom();
  const accounts = useAccounts();
  const solanaAccount = accounts?.find((account) => account.addressType === AddressType.solana);
  const [network, setNetwork] = useState<"mainnet" | "devnet">("mainnet");
  const [chainLoading, setChainLoading] = useState(false);
  const [chainError, setChainError] = useState("");
  const [solOnChain, setSolOnChain] = useState<number | null>(null);
  const [tokensOnChain, setTokensOnChain] = useState<OnChainTokenRow[]>([]);
  const [connectError, setConnectError] = useState<string>("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isCompactDetailOpen, setIsCompactDetailOpen] = useState(false);
  const [copyHint, setCopyHint] = useState("");

  const ledgerRows = useMemo(() => {
    const rows: LedgerRow[] = [];
    for (const p of positions) {
      rows.push({
        id: `in-${p.id}`,
        kind: "입금",
        amountUsd: p.amountUsd,
        productName: p.productName,
        createdAt: p.createdAt
      });
    }
    for (const w of withdrawLedger) {
      rows.push({
        id: w.id,
        kind: "출금",
        amountUsd: w.amountUsd,
        createdAt: w.createdAt
      });
    }
    return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [positions, withdrawLedger]);

  const rpcCandidates = useMemo(() => getSolanaRpcCandidates(network), [network]);
  const copyAddress = useCallback(async () => {
    const addr = solanaAccount?.address;
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      setCopyHint("복사됨");
      setTimeout(() => setCopyHint(""), 2000);
    } catch {
      setCopyHint("복사 실패");
      setTimeout(() => setCopyHint(""), 2000);
    }
  }, [solanaAccount?.address]);

  useEffect(() => {
    const addr = solanaAccount?.address;
    if (!isConnected || !addr) {
      setSolOnChain(null);
      setTokensOnChain([]);
      setChainError("");
      setChainLoading(false);
      setIsCompactDetailOpen(false);
      return;
    }

    const load = async () => {
      setChainLoading(true);
      setChainError("");
      try {
        const { portfolio } = await fetchOnChainPortfolioWithFallback(rpcCandidates, addr, network);
        setSolOnChain(portfolio.sol);
        setTokensOnChain(portfolio.tokens);
      } catch (e) {
        setSolOnChain(null);
        setTokensOnChain([]);
        setChainError(e instanceof Error ? e.message : "잔고를 불러오지 못했습니다.");
      } finally {
        setChainLoading(false);
      }
    };

    void load();
  }, [isConnected, solanaAccount?.address, network, rpcCandidates]);

  const onConnect = async () => {
    setIsConnecting(true);
    setConnectError("");
    try {
      const hasInjected =
        typeof window !== "undefined" && Boolean((window as { phantom?: { solana?: { isPhantom?: boolean } } }).phantom?.solana?.isPhantom);
      if (hasInjected) {
        try {
          await connect({ provider: "phantom" });
          return;
        } catch {
          await connect({ provider: "injected" });
          return;
        }
      }
      try {
        await connect({ provider: "google" });
      } catch {
        await connect({ provider: "apple" });
      }
    } catch (error) {
      console.error("지갑 연결 실패:", error);
      setConnectError("지갑 연결 실패: Phantom 확장 또는 소셜 로그인 설정을 확인하세요.");
    } finally {
      setIsConnecting(false);
    }
  };

  const onDisconnect = async () => {
    try {
      setConnectError("");
      setChainError("");
      setIsConnecting(false);
      await disconnect();
    } catch (error) {
      console.error("연결 해제 실패:", error);
    }
  };

  const ledgerSection = (
    <div className="wallet-ledger-section">
      <h4 className="wallet-feed-title">입출금 내역</h4>
      {ledgerRows.length === 0 ? (
        <p className="wallet-feed-empty">내역이 없습니다.</p>
      ) : (
        <div className={compact ? "wallet-ledger-scroll" : undefined}>
          <table className="wallet-ledger-table">
            <thead>
              <tr>
                <th>일시</th>
                <th>구분</th>
                {!compact ? <th>상품</th> : null}
                <th>금액 (USD)</th>
              </tr>
            </thead>
            <tbody>
              {ledgerRows.map((row) => (
                <tr key={row.id}>
                  <td className="wallet-ledger-muted">{new Date(row.createdAt).toLocaleString()}</td>
                  <td>
                    <span className={row.kind === "입금" ? "wallet-ledger-tag-in" : "wallet-ledger-tag-out"}>{row.kind}</span>
                  </td>
                  {!compact ? <td>{row.kind === "입금" ? row.productName ?? "—" : "—"}</td> : null}
                  <td className="wallet-ledger-amount">
                    {row.kind === "출금" ? "−" : "+"}
                    {row.amountUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </td>
                </tr>
              ))}
            </tbody>
            {(portfolioUsd > 0 || positions.length > 0) && (
              <tfoot>
                <tr>
                  <td colSpan={compact ? 3 : 4} className="wallet-ledger-foot">
                    예치 잔액 <strong>${portfolioUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );

  const actionRow = (opts: { compact: boolean }) => {
    const afterNav = (fn?: () => void) => {
      if (!fn) return;
      if (opts.compact) setIsCompactDetailOpen(false);
      fn();
    };
    return (
      <div className={opts.compact ? "wallet-action-grid wallet-action-grid-compact" : "wallet-action-grid"}>
        {solanaAccount?.address ? (
          <button type="button" className="wallet-action-btn" onClick={() => void copyAddress()}>
            주소 복사
          </button>
        ) : null}
        {onOpenMyOverview ? (
          <button type="button" className="wallet-action-btn primary" onClick={() => afterNav(onOpenMyOverview)}>
            내 현황
          </button>
        ) : null}
        {onOpenPortfolio ? (
          <button type="button" className={`wallet-action-btn${onOpenMyOverview ? "" : " primary"}`} onClick={() => afterNav(onOpenPortfolio)}>
            포트폴리오
          </button>
        ) : null}
        <button type="button" className="wallet-action-btn" onClick={() => afterNav(onOpenActivity)}>
          활동 피드
        </button>
        {onOpenWallet ? (
          <button type="button" className="wallet-action-btn" onClick={() => afterNav(onOpenWallet)}>
            지갑 상세
          </button>
        ) : null}
        {solanaAccount?.address ? (
          <button
            type="button"
            className="wallet-action-btn"
            onClick={() => window.open(solscanAccountUrl(solanaAccount.address, network), "_blank", "noopener,noreferrer")}
          >
            Solscan
          </button>
        ) : null}
        <button type="button" className="wallet-action-btn danger" onClick={onDisconnect}>
          연결 해제
        </button>
      </div>
    );
  };

  const networkToggle = (opts: { compact: boolean }) => (
    <div
      className={
        opts.compact
          ? "wallet-network-toggle"
          : "wallet-network-toggle wallet-network-toggle-inline wallet-network-toggle-below-status"
      }
    >
      <button type="button" className={network === "mainnet" ? "active" : ""} onClick={() => setNetwork("mainnet")}>
        메인넷
      </button>
      <button type="button" className={network === "devnet" ? "active" : ""} onClick={() => setNetwork("devnet")}>
        데브넷
      </button>
    </div>
  );

  if (compact) {
    return (
      <section className="wallet-widget">
        {isConnected ? (
          <>
            <div className="wallet-widget-head wallet-widget-head-address-only">
              <button type="button" className="wallet-address-link" onClick={() => setIsCompactDetailOpen((prev) => !prev)}>
                {solanaAccount?.address ? `${solanaAccount.address.slice(0, 6)}…${solanaAccount.address.slice(-4)}` : "주소 없음"}{" "}
                {isCompactDetailOpen ? "▴" : "▾"}
              </button>
            </div>
            {copyHint ? <p className="wallet-copy-hint wallet-copy-hint-compact">{copyHint}</p> : null}
            {isCompactDetailOpen ? (
              <div className="wallet-compact-detail">
                {networkToggle({ compact: true })}
                <NetworkStatusBlock network={network} plain />
                <ChainAssetsTable
                  loading={chainLoading}
                  error={chainError}
                  sol={solOnChain}
                  tokens={tokensOnChain}
                  network={network}
                  compact
                />
                {ledgerSection}
                {actionRow({ compact: true })}
              </div>
            ) : null}
          </>
        ) : (
          <div className="wallet-widget-head wallet-widget-head-address-only">
            <button type="button" onClick={onConnect} disabled={isConnecting}>
              {isConnecting ? "연결 중…" : "연결"}
            </button>
          </div>
        )}
        {connectError ? <p className="wallet-error">{connectError}</p> : null}
      </section>
    );
  }

  return (
    <section className="card wallet-page">
      <div className="wallet-page-head">
        <h2>지갑 · 자산</h2>
        <p className="wallet-page-lead">지갑 잔고와 앱 예치 입출금 내역입니다.</p>
      </div>
      {isConnected ? (
        <>
          <div className="wallet-identity-panel">
            <p className="wallet-full-address">{solanaAccount?.address ?? "주소 없음"}</p>
            {copyHint ? <p className="wallet-copy-hint wallet-copy-hint-in-panel">{copyHint}</p> : null}
            <NetworkStatusBlock network={network} plain />
            {networkToggle({ compact: false })}
          </div>
          <ChainAssetsTable
            loading={chainLoading}
            error={chainError}
            sol={solOnChain}
            tokens={tokensOnChain}
            network={network}
            compact={false}
          />
          {ledgerSection}
          {actionRow({ compact: false })}
        </>
      ) : (
        <button type="button" onClick={onConnect} disabled={isConnecting}>
          {isConnecting ? "연결 중…" : "Phantom 연결"}
        </button>
      )}
      {connectError ? <p className="wallet-error">{connectError}</p> : null}
    </section>
  );
}
