import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AddressType } from "@phantom/browser-sdk";
import { useAccounts, useConnect, useDisconnect, usePhantom } from "@phantom/react-sdk";
import {
  AUTH_CLEARED_EVENT,
  AUTH_UPDATED_EVENT,
  clearSession,
  fetchMarketPrices,
  fetchRuntimeInfo,
  getSession,
  linkAccountWallet,
  listAccountAssets,
  listAccountWallets,
  loginWithWallet,
  type AccountAssetBalance,
  type AccountAssetSymbol,
  type AuthSession,
  type DepositPositionPayload,
  type RuntimeInfo,
  type UserWallet
} from "../lib/api";
import { fetchEvmPortfolioWithFallback, getEvmRpcCandidates, type EvmChainName } from "../lib/evmChainAssets";
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
  onOpenAuth?: () => void;
  onSessionChange?: (session: AuthSession | null) => void;
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

function normalizeAssetSymbol(symbol: string): AccountAssetSymbol | null {
  const upper = symbol.toUpperCase();
  if (upper.includes("USDC")) return "USDC";
  if (upper.includes("USDT")) return "USDT";
  if (upper.includes("SOL")) return "SOL";
  if (upper.includes("ETH")) return "ETH";
  return null;
}

function shortAddress(address?: string | null): string {
  if (!address) return "온체인 지갑 미연결";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function readConnectedSolanaAddress(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const phantomSolana = (window as {
    phantom?: {
      solana?: {
        publicKey?: {
          toBase58?: () => string;
          toString?: () => string;
        };
      };
    };
  }).phantom?.solana;
  return phantomSolana?.publicKey?.toBase58?.() ?? phantomSolana?.publicKey?.toString?.();
}

async function waitForConnectedSolanaAddress(fallback?: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const addr = readConnectedSolanaAddress() ?? fallback;
    if (addr) return addr;
    await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 0 : 100));
  }
  return readConnectedSolanaAddress() ?? fallback;
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
  compact,
  prices,
  priceMeta
}: {
  loading: boolean;
  error: string;
  sol: number | null;
  tokens: OnChainTokenRow[];
  network: "mainnet" | "devnet";
  compact: boolean;
  prices: Partial<Record<AccountAssetSymbol, number>>;
  priceMeta: string;
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
      {priceMeta ? <p className="wallet-price-meta">가격 기준: {priceMeta}</p> : null}
      <table className="wallet-chain-table">
        <thead>
          <tr>
            <th>자산</th>
            <th>잔고</th>
            <th>USD 가치</th>
            {!compact ? <th>Mint</th> : null}
            <th>Solscan</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>SOL (네이티브)</td>
            <td className="wallet-mono">{sol !== null ? formatTokenAmount(sol) : "—"}</td>
            <td className="wallet-mono">
              {sol !== null && prices.SOL ? `$${(sol * prices.SOL).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}
            </td>
            {!compact ? (
              <td className="wallet-mono wallet-mint-muted">—</td>
            ) : null}
            <td>—</td>
          </tr>
          {tokens.map((t) => (
            (() => {
              const symbol = normalizeAssetSymbol(t.symbol);
              const usd = symbol && prices[symbol] ? t.amount * (prices[symbol] ?? 0) : null;
              return (
                <tr key={t.mint}>
                  <td>{t.symbol}</td>
                  <td className="wallet-mono">{formatTokenAmount(t.amount)}</td>
                  <td className="wallet-mono">{usd !== null ? `$${usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</td>
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
              );
            })()
          ))}
          {tokens.length === 0 ? (
            <tr>
              <td colSpan={compact ? 4 : 5}>SPL 토큰 계정 없음 (또는 잔고 0)</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function EvmAssetsTable({
  loading,
  error,
  rows,
  compact,
  priceMeta
}: {
  loading: boolean;
  error: string;
  rows: AccountAssetBalance[];
  compact: boolean;
  priceMeta: string;
}) {
  if (loading) {
    return <p className="wallet-chain-loading">EVM 체인에서 자산 조회 중…</p>;
  }
  if (error) {
    return <p className="wallet-error">{error}</p>;
  }
  return (
    <div className={compact ? "wallet-chain-table-wrap wallet-chain-table-wrap-compact" : "wallet-chain-table-wrap"}>
      <h4 className="wallet-feed-title">블록체인 자산 (EVM)</h4>
      {priceMeta ? <p className="wallet-price-meta">가격 기준: {priceMeta}</p> : null}
      <table className="wallet-chain-table">
        <thead>
          <tr>
            <th>체인</th>
            <th>자산</th>
            <th>잔고</th>
            <th>USD 가치</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.chain}-${row.symbol}-${row.amount}`}>
              <td>{row.chain}</td>
              <td>{row.symbol}</td>
              <td className="wallet-mono">{formatTokenAmount(row.amount)}</td>
              <td className="wallet-mono">${row.usdValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4}>EVM 잔고 없음</td>
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
  onOpenMyOverview,
  onOpenAuth,
  onSessionChange
}: WalletPanelProps) {
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { isConnected } = usePhantom();
  const accounts = useAccounts();
  const solanaAccount = accounts?.find((account) => account.addressType === AddressType.solana);
  const evmAccount = accounts?.find((account) => account.addressType === AddressType.ethereum);
  const [network, setNetwork] = useState<"mainnet" | "devnet">("mainnet");
  const [chainLoading, setChainLoading] = useState(false);
  const [chainError, setChainError] = useState("");
  const [solOnChain, setSolOnChain] = useState<number | null>(null);
  const [tokensOnChain, setTokensOnChain] = useState<OnChainTokenRow[]>([]);
  const [evmChainLoading, setEvmChainLoading] = useState(false);
  const [evmChainError, setEvmChainError] = useState("");
  const [evmAssetsOnChain, setEvmAssetsOnChain] = useState<AccountAssetBalance[]>([]);
  const [connectError, setConnectError] = useState<string>("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isCompactDetailOpen, setIsCompactDetailOpen] = useState(false);
  const [copyHint, setCopyHint] = useState("");
  const [appUsername, setAppUsername] = useState(() => getSession()?.username ?? "");
  const [marketPrices, setMarketPrices] = useState<Partial<Record<AccountAssetSymbol, number>>>({});
  const [priceMeta, setPriceMeta] = useState("");
  const [loginChoiceOpen, setLoginChoiceOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [walletCreateOpen, setWalletCreateOpen] = useState(false);
  const [linkedWallets, setLinkedWallets] = useState<UserWallet[]>([]);
  const [accountAssets, setAccountAssets] = useState<AccountAssetBalance[]>([]);
  const [accountMenuError, setAccountMenuError] = useState("");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeInfo["executionMode"]>("dry-run");
  const accountMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = (): void => {
      setAppUsername(getSession()?.username ?? "");
    };
    if (typeof window !== "undefined") {
      window.addEventListener(AUTH_CLEARED_EVENT, sync);
      window.addEventListener(AUTH_UPDATED_EVENT, sync);
    }
    sync();
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener(AUTH_CLEARED_EVENT, sync);
        window.removeEventListener(AUTH_UPDATED_EVENT, sync);
      }
    };
  }, []);

  useEffect(() => {
    if (!appUsername) {
      setLinkedWallets([]);
      setAccountAssets([]);
      setAccountMenuError("");
      return;
    }
    const controller = new AbortController();
    setAccountMenuError("");
    void Promise.allSettled([
      listAccountWallets({ signal: controller.signal }),
      listAccountAssets({ signal: controller.signal }, runtimeMode)
    ])
      .then(([walletsResult, assetsResult]) => {
        if (controller.signal.aborted) return;
        setLinkedWallets(walletsResult.status === "fulfilled" ? walletsResult.value : []);
        setAccountAssets(assetsResult.status === "fulfilled" ? assetsResult.value : []);
        if (walletsResult.status === "rejected") {
          setAccountMenuError("연결 지갑 정보를 불러오지 못했습니다. API 서버를 새 코드로 재시작하면 복구됩니다.");
        }
    });
    return () => controller.abort();
  }, [appUsername, runtimeMode]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const loadRuntimeMode = async () => {
      try {
        const info = await fetchRuntimeInfo();
        if (!cancelled) {
          setRuntimeMode(info.executionMode);
        }
      } catch {
        if (!cancelled) {
          setRuntimeMode("dry-run");
        }
      }
    };
    void loadRuntimeMode();
    timer = window.setInterval(() => {
      void loadRuntimeMode();
    }, 2000);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchMarketPrices({ signal: controller.signal })
      .then((snapshot) => {
        if (controller.signal.aborted) return;
        setMarketPrices(snapshot.prices);
        setPriceMeta(`${snapshot.source} · ${new Date(snapshot.updatedAt).toLocaleTimeString()}`);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setMarketPrices({});
          setPriceMeta("가격 조회 실패");
        }
      });
    return () => controller.abort();
  }, []);

  // 계정 메뉴 외부 클릭 시 닫기
  useEffect(() => {
    if (!accountMenuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [accountMenuOpen]);

  const walletAddressLabel = useMemo(() => {
    const chain = solanaAccount?.address ?? evmAccount?.address;
    if (appUsername && chain) {
      return `${appUsername} · ${shortAddress(chain)}`;
    }
    if (appUsername) {
      return `${appUsername} (앱 로그인)`;
    }
    if (chain) {
      return shortAddress(chain);
    }
    return "주소 없음";
  }, [appUsername, evmAccount?.address, solanaAccount?.address]);
  const primaryWalletAddress = solanaAccount?.address ?? evmAccount?.address;

  const connectPhantomWallet = async (): Promise<void> => {
    const hasInjected =
      typeof window !== "undefined" && Boolean((window as { phantom?: { solana?: { isPhantom?: boolean } } }).phantom?.solana?.isPhantom);
    if (!hasInjected) {
      throw new Error("Phantom 지갑이 설치되어 있지 않습니다. Phantom을 설치한 뒤 다시 시도해 주세요.");
    }
    await connect({ provider: "injected" });
  };

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
    const addr = primaryWalletAddress;
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      setCopyHint("복사됨");
      setTimeout(() => setCopyHint(""), 2000);
    } catch {
      setCopyHint("복사 실패");
      setTimeout(() => setCopyHint(""), 2000);
    }
  }, [primaryWalletAddress]);

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
  }, [isConnected, network, rpcCandidates, solanaAccount?.address]);

  useEffect(() => {
    const addr = evmAccount?.address as `0x${string}` | undefined;
    if (!isConnected || !addr) {
      setEvmAssetsOnChain([]);
      setEvmChainError("");
      setEvmChainLoading(false);
      return;
    }

    const controller = new AbortController();
    const load = async () => {
      setEvmChainLoading(true);
      setEvmChainError("");
      try {
        const snapshot = await fetchMarketPrices({ signal: controller.signal });
        if (controller.signal.aborted) return;
        const settled = await Promise.allSettled(
          (["Ethereum", "Arbitrum", "Base"] as EvmChainName[]).map((chainName) =>
            fetchEvmPortfolioWithFallback(
              getEvmRpcCandidates(chainName),
              addr,
              chainName,
              snapshot.prices,
              snapshot.source,
              snapshot.updatedAt
            )
          )
        );
        if (controller.signal.aborted) return;
        const nextRows: AccountAssetBalance[] = [];
        settled.forEach((result) => {
          if (result.status === "fulfilled") {
            nextRows.push(...result.value.portfolio);
          }
        });
        setEvmAssetsOnChain(nextRows);
        if (settled.every((result) => result.status === "rejected")) {
          setEvmChainError("EVM 잔고를 불러오지 못했습니다.");
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setEvmAssetsOnChain([]);
          setEvmChainError(e instanceof Error ? e.message : "EVM 잔고를 불러오지 못했습니다.");
        }
      } finally {
        if (!controller.signal.aborted) setEvmChainLoading(false);
      }
    };

    void load();
    return () => controller.abort();
  }, [evmAccount?.address, isConnected]);

  const onConnect = async () => {
    setIsConnecting(true);
    setConnectError("");
    try {
      await connectPhantomWallet();
    } catch (error) {
      console.error("지갑 연결 실패:", error);
      setConnectError(error instanceof Error ? error.message : "지갑 연결 실패: Phantom 지갑을 확인하세요.");
    } finally {
      setIsConnecting(false);
    }
  };

  const onWalletLogin = async () => {
    setIsConnecting(true);
    setConnectError("");
    try {
      if (!solanaAccount?.address) {
        await connectPhantomWallet();
      }
      const addr = await waitForConnectedSolanaAddress(solanaAccount?.address);
      if (!addr) {
        setConnectError("지갑 연결은 됐지만 주소를 아직 읽지 못했습니다. 잠시 후 다시 눌러 주세요.");
        return;
      }
      const session = await loginWithWallet(addr);
      onSessionChange?.(session);
      setAppUsername(session.username);
      setLoginChoiceOpen(false);
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : "지갑 로그인 실패");
    } finally {
      setIsConnecting(false);
    }
  };

  const onLinkCurrentWallet = async () => {
    setConnectError("");
    let addr = primaryWalletAddress;
    let chain = solanaAccount?.address ? "Solana" : evmAccount?.address ? "Ethereum" : "Solana";
    if (!addr) {
      setIsConnecting(true);
      try {
        await connectPhantomWallet();
      } catch (error) {
        setConnectError(error instanceof Error ? error.message : "지갑 연결 실패");
        setIsConnecting(false);
        return;
      }
      addr =
        primaryWalletAddress ??
        readConnectedSolanaAddress() ??
        (window as {
          phantom?: {
            ethereum?: { selectedAddress?: string };
          };
        }).phantom?.ethereum?.selectedAddress;
      if (!solanaAccount?.address && addr?.startsWith("0x")) {
        chain = "Ethereum";
      } else if (addr) {
        chain = "Solana";
      }
    }
    if (!addr) {
      setConnectError("지갑 주소를 아직 읽지 못했습니다. 연결 후 다시 시도해 주세요.");
      setIsConnecting(false);
      return;
    }
    try {
      const wallet = await linkAccountWallet(addr, chain, "phantom");
      setLinkedWallets((prev) => [wallet, ...prev.filter((item) => item.walletAddress !== wallet.walletAddress)]);
      setWalletCreateOpen(false);
      setAccountMenuOpen(true);
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : "지갑 연결 저장 실패");
    } finally {
      setIsConnecting(false);
    }
  };

  const onLogout = async () => {
    await clearSession();
    await disconnect().catch(() => undefined);
    setAppUsername("");
    setLinkedWallets([]);
    setAccountAssets([]);
    setAccountMenuOpen(false);
    setWalletCreateOpen(false);
    onSessionChange?.(null);
  };

  const accountAssetsTotal = accountAssets.reduce((acc, asset) => acc + asset.usdValue, 0);

  const loginChoice = (
    <div className="wallet-login-choice" role="menu" aria-label="로그인 방식 선택">
      <button
        type="button"
        onClick={() => {
          setLoginChoiceOpen(false);
          onOpenAuth?.();
        }}
      >
        아이디로 로그인
      </button>
      <button type="button" onClick={() => void onWalletLogin()} disabled={isConnecting}>
        {isConnecting ? "지갑 로그인 중..." : "지갑 연결로 로그인"}
      </button>
    </div>
  );

  const openWalletCreate = () => {
    setAccountMenuOpen(false);
    setWalletCreateOpen(true);
  };

  const accountMenu = appUsername ? (
    <div className="wallet-account-menu" role="menu" aria-label="계정 메뉴">
      <div className="wallet-account-menu-head">
        <span>로그인 계정</span>
        <strong>{appUsername}</strong>
      </div>
      <div className="wallet-account-menu-section">
        <span>연결 지갑</span>
        {linkedWallets.length > 0 ? (
          linkedWallets.slice(0, 3).map((wallet) => (
            <button key={wallet.id} type="button" className="wallet-account-row" onClick={() => void onConnect()}>
              <strong>{shortAddress(wallet.walletAddress)}</strong>
              <em>
                {wallet.chain} · {wallet.provider} · Phantom 연결
              </em>
            </button>
          ))
        ) : (
          <button type="button" className="wallet-account-row" onClick={openWalletCreate}>
            <strong>연결된 지갑 없음</strong>
            <em>눌러서 Phantom 지갑을 생성/연결</em>
          </button>
        )}
      </div>
      <div className="wallet-account-menu-section">
        <span>자산 요약</span>
        <strong>${accountAssetsTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
        <em>{accountAssets.slice(0, 4).map((asset) => `${asset.symbol} $${asset.usdValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`).join(" · ") || "조회 전"}</em>
      </div>
      {accountMenuError ? <p className="wallet-error">{accountMenuError}</p> : null}
      <div className="wallet-account-actions">
        <button type="button" onClick={openWalletCreate}>
          지갑 생성/연결
        </button>
        <button type="button" className="danger" onClick={() => void onLogout()}>
          로그아웃
        </button>
      </div>
    </div>
  ) : null;

  const walletCreateModal = walletCreateOpen
    ? createPortal(
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="지갑 생성 및 연결"
          onClick={(e) => { if (e.target === e.currentTarget) setWalletCreateOpen(false); }}
        >
          <div className="modal-card wallet-create-modal">
            <button type="button" className="modal-close-icon" aria-label="닫기" onClick={() => setWalletCreateOpen(false)}>
              ✕
            </button>
            <p className="section-eyebrow">Wallet Setup</p>
            <h3>지갑 생성 및 연결</h3>
            <p>
              Phantom이 설치되어 있으면 기존 지갑을 연결하고, 없으면 Phantom의 신규 지갑 생성 화면으로 이동합니다. 연결 후 현재 아이디와 지갑 주소를 저장합니다.
            </p>
            {connectError ? <p className="wallet-error">{connectError}</p> : null}
            <div className="button-row">
              <button type="button" onClick={() => void onLinkCurrentWallet()} disabled={isConnecting}>
                {isConnecting ? "연결 중..." : "현재 지갑 연결"}
              </button>
              <button type="button" className="ghost-btn" onClick={() => window.open("https://phantom.app/download", "_blank", "noopener,noreferrer")}>
                신규 지갑 만들기
              </button>
            </div>
          </div>
        </div>,
        document.body
      )
    : null;

  const onDisconnect = async () => {
    try {
      setConnectError("");
      setChainError("");
      setIsConnecting(false);
      setSolOnChain(null);
      setTokensOnChain([]);
      setIsCompactDetailOpen(false);
      setCopyHint("");
      await disconnect();
      if (appUsername.startsWith("wallet_")) {
        await clearSession();
        onSessionChange?.(null);
        setAppUsername("");
      }
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
        {primaryWalletAddress ? (
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
      <>
      <section className="wallet-widget">
        {isConnected ? (
          <>
            <div className="wallet-widget-head wallet-widget-head-address-only">
              <button type="button" className="wallet-address-link" onClick={() => setIsCompactDetailOpen((prev) => !prev)}>
                {walletAddressLabel} {isCompactDetailOpen ? "▴" : "▾"}
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
                  prices={marketPrices}
                  priceMeta={priceMeta}
                />
                <EvmAssetsTable loading={evmChainLoading} error={evmChainError} rows={evmAssetsOnChain} compact priceMeta={priceMeta} />
                {ledgerSection}
                {actionRow({ compact: true })}
              </div>
            ) : null}
          </>
        ) : (
          <div className="wallet-widget-head wallet-widget-head-address-only" ref={appUsername ? accountMenuRef : undefined}>
            {appUsername ? (
              <button type="button" className="wallet-address-link" onClick={() => setAccountMenuOpen((prev) => !prev)}>
                {appUsername} {accountMenuOpen ? "▴" : "▾"}
              </button>
            ) : (
              <>
                <button type="button" onClick={() => setLoginChoiceOpen((prev) => !prev)} disabled={isConnecting}>
                  {isConnecting ? "로그인 중…" : "로그인"}
                </button>
                {loginChoiceOpen ? loginChoice : null}
              </>
            )}
            {accountMenuOpen ? accountMenu : null}
          </div>
        )}
        {connectError ? <p className="wallet-error">{connectError}</p> : null}
      </section>
      {walletCreateModal}
    </>
    );
  }

  return (
    <>
    <section className="card wallet-page">
      <div className="wallet-page-head">
        <h2>지갑 · 자산</h2>
        <p className="wallet-page-lead">지갑 잔고와 앱 예치 입출금 내역입니다.</p>
      </div>
      {isConnected ? (
        <>
          <div className="wallet-identity-panel">
            {appUsername ? (
              <p className="wallet-app-account-line">
                앱 계정 <strong className="wallet-mono">{appUsername}</strong>
              </p>
            ) : null}
            <p className="wallet-full-address" title={primaryWalletAddress ?? undefined}>
              {shortAddress(primaryWalletAddress)}
            </p>
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
            prices={marketPrices}
            priceMeta={priceMeta}
          />
          <EvmAssetsTable loading={evmChainLoading} error={evmChainError} rows={evmAssetsOnChain} compact={false} priceMeta={priceMeta} />
          {ledgerSection}
          {actionRow({ compact: false })}
        </>
      ) : (
        <div className="wallet-login-panel">
          <button type="button" onClick={() => setLoginChoiceOpen((prev) => !prev)} disabled={isConnecting}>
            {isConnecting ? "로그인 중…" : "로그인"}
          </button>
          {loginChoiceOpen ? loginChoice : null}
        </div>
      )}
      {connectError ? <p className="wallet-error">{connectError}</p> : null}
    </section>
    {walletCreateModal}
    </>
  );
}
