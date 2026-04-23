import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Decimal from "decimal.js";
import { AddressType } from "@phantom/browser-sdk";
import { useAccounts, useConnect, useDisconnect, usePhantom } from "@phantom/react-sdk";
import type { ISolanaChain } from "@phantom/chain-interfaces";
import {
  AUTH_CLEARED_EVENT,
  AUTH_UPDATED_EVENT,
  clearSession,
  fetchMarketPrices,
  getSession,
  linkAccountWallet,
  listAccountAssets,
  listAccountWallets,
  loginWithWallet,
  type AccountAssetBalance,
  type AccountAssetSymbol,
  type AuthSession,
  type DepositPositionPayload,
  type UserWallet
} from "../lib/api";
import { loadCachedAccountAssets, saveCachedAccountAssets } from "../lib/accountAssetCache";
import { getSolanaNetworkPreference, setSolanaNetworkPreference } from "../lib/solanaNetworkPreference";
import { fetchEvmPortfolioWithFallback, getEvmRpcCandidates, type EvmChainName } from "../lib/evmChainAssets";
import { fetchOnChainPortfolioWithFallback, getSolanaRpcCandidates, solscanTokenUrl, type OnChainTokenRow } from "../lib/solanaChainAssets";
import {
  buildWalletAssetChoices,
  createWalletActionConnection,
  sendSolanaAsset,
  swapSolanaAsset,
} from "../lib/solanaWalletActions";
import { quoteJupiterExactInSwap } from "../lib/solanaJupiterSwap";
import { resolveSolanaSymbolForMint, resolveSolanaTokenDecimals, resolveSolanaTokenMint } from "../lib/solanaTokenMints";

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

type SwapTargetChoice = {
  mint: string;
  symbol: AccountAssetSymbol;
  label: string;
  decimals: number;
};

type WalletMenuTab = "home" | "send" | "swap";

function WalletHomeGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 11.5 12 5l8 6.5" />
      <path d="M6.5 10.8V20h11V10.8" />
      <path d="M9.25 20v-5.2h5.5V20" />
    </svg>
  );
}

function WalletSendGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4.5 19.5 20 4" />
      <path d="M12.5 4.5H19.5V11.5" />
      <path d="M19.2 4.8 12.2 11.8" />
    </svg>
  );
}

function WalletSwapGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 7h11l-2.8-2.8" />
      <path d="M18 7 15.2 9.8" />
      <path d="M17 17H6l2.8 2.8" />
      <path d="M6 17l2.8-2.8" />
    </svg>
  );
}

function WalletCircularSwapGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7.5 8.5A7 7 0 0 1 18 8.8" />
      <path d="M18 8.8V5.8" />
      <path d="M18 8.8h-3" />
      <path d="M16.5 15.5A7 7 0 0 1 6 15.2" />
      <path d="M6 15.2v3" />
      <path d="M6 15.2h3" />
    </svg>
  );
}

function WalletLogoutGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M10 6.5H6.5A1.5 1.5 0 0 0 5 8v8a1.5 1.5 0 0 0 1.5 1.5H10" />
      <path d="M12 12h7" />
      <path d="M15.5 8.5 19 12l-3.5 3.5" />
    </svg>
  );
}

function formatTokenAmount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function normalizeAssetSymbol(symbol: string): AccountAssetSymbol | null {
  const upper = symbol.toUpperCase();
  if (upper.includes("MSOL")) return "MSOL";
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

function shortTxid(txid?: string | null): string {
  if (!txid) return "—";
  if (txid.length <= 16) return txid;
  return `${txid.slice(0, 8)}…${txid.slice(-8)}`;
}

function formatRawAmount(rawAmount: bigint | string, decimals: number): string {
  const numeric = typeof rawAmount === "bigint" ? Number(rawAmount) : Number(rawAmount);
  if (!Number.isFinite(numeric)) return "—";
  return (numeric / 10 ** decimals).toLocaleString(undefined, {
    maximumFractionDigits: decimals > 6 ? 6 : Math.max(decimals, 2)
  });
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

function readBrowserPhantomSolana(): ISolanaChain | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as { phantom?: { solana?: ISolanaChain } }).phantom?.solana;
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
  const clusterLabel = network === "mainnet" ? "Solana mainnet_live" : "Solana 개발망(데브넷)";
  const inner = (
    <div className="wallet-network-primary">
      <span className="wallet-network-dot" aria-hidden />
      <div>
        <p className="wallet-network-title">네트워크</p>
        <p className="wallet-network-cluster">
          <strong>{clusterLabel}</strong>
          <span className="wallet-network-pill">{network === "mainnet" ? "mainnet_live" : "devnet"}</span>
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
  const [network, setNetwork] = useState<"mainnet" | "devnet">(() => getSolanaNetworkPreference());
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
  const [accountMenuTab, setAccountMenuTab] = useState<WalletMenuTab>("home");
  const [walletActionsTab, setWalletActionsTab] = useState<WalletMenuTab>("home");
  const [walletActionLoading, setWalletActionLoading] = useState(false);
  const [walletActionError, setWalletActionError] = useState("");
  const [walletActionNote, setWalletActionNote] = useState("");
  const [walletHomeLedgerOpen, setWalletHomeLedgerOpen] = useState(false);
  const [sendTokenMenuOpen, setSendTokenMenuOpen] = useState(false);
  const [swapFromMenuOpen, setSwapFromMenuOpen] = useState(false);
  const [swapToMenuOpen, setSwapToMenuOpen] = useState(false);
  const [sendRecipient, setSendRecipient] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sendChoiceMint, setSendChoiceMint] = useState("");
  const [swapFromMint, setSwapFromMint] = useState("");
  const [swapToMint, setSwapToMint] = useState("");
  const [swapAmount, setSwapAmount] = useState("");
  const [swapQuote, setSwapQuote] = useState<{
    outAmountRaw: bigint;
    minOutAmountRaw: bigint;
    priceImpactPct: string;
    outputDecimals: number;
    outputSymbol: AccountAssetSymbol;
    outputMint: string;
  } | null>(null);
  const [swapQuoteLoading, setSwapQuoteLoading] = useState(false);
  const [swapQuoteError, setSwapQuoteError] = useState("");
  const [linkedWallets, setLinkedWallets] = useState<UserWallet[]>([]);
  const [accountAssets, setAccountAssets] = useState<AccountAssetBalance[]>([]);
  const [accountAssetsSnapshotLabel, setAccountAssetsSnapshotLabel] = useState("업데이트 전");
  const [walletRefreshTick, setWalletRefreshTick] = useState(0);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const compactDetailRef = useRef<HTMLDivElement>(null);
  const menuCallbacks = { onOpenWallet, onOpenActivity, onOpenPortfolio, onOpenMyOverview };
  void menuCallbacks;

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
    setSolanaNetworkPreference(network);
  }, [network]);

  useEffect(() => {
    if (!appUsername) {
      setLinkedWallets([]);
      setAccountAssets([]);
      setAccountAssetsSnapshotLabel("업데이트 전");
      return;
    }
    const controller = new AbortController();
    const cacheScope = {
      kind: "wallet" as const,
      mode: "dry-run" as const,
      username: appUsername,
      solanaAddress: solanaAccount?.address,
      evmAddress: evmAccount?.address
    };
    const cachedAssets = loadCachedAccountAssets(cacheScope);
    if (cachedAssets && cachedAssets.length > 0) {
      setAccountAssets(cachedAssets);
      setAccountAssetsSnapshotLabel("업데이트 전");
    }
    void Promise.allSettled([
      listAccountWallets({ signal: controller.signal }),
      listAccountAssets({ signal: controller.signal }, runtimeMode)
    ])
      .then(([walletsResult, assetsResult]) => {
        if (controller.signal.aborted) return;
        setLinkedWallets(walletsResult.status === "fulfilled" ? walletsResult.value : []);
        if (assetsResult.status === "fulfilled") {
          setAccountAssets(assetsResult.value);
          setAccountAssetsSnapshotLabel("업데이트 후");
          saveCachedAccountAssets(cacheScope, assetsResult.value);
        } else if (!cachedAssets || cachedAssets.length === 0) {
          setAccountAssets([]);
          setAccountAssetsSnapshotLabel("업데이트 전");
        }
    });
    return () => controller.abort();
  }, [appUsername, evmAccount?.address, solanaAccount?.address]);

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

  // 연결된 지갑의 펼침 메뉴도 화면의 다른 곳을 누르면 닫히게 한다.
  useEffect(() => {
    if (!isCompactDetailOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (compactDetailRef.current && !compactDetailRef.current.contains(e.target as Node)) {
        setIsCompactDetailOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [isCompactDetailOpen]);

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
  const runtimeMode = isConnected ? "live" : "dry-run";

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

  const rpcCandidates = useMemo(() => getSolanaRpcCandidates(network, network !== "devnet"), [network]);

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
  }, [isConnected, network, rpcCandidates, solanaAccount?.address, walletRefreshTick]);

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
  }, [evmAccount?.address, isConnected, walletRefreshTick]);

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
      setAccountMenuTab("home");
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
  const onChainVisibleTotal = useMemo(() => {
    const solUsd = solOnChain !== null && Number.isFinite(solOnChain) ? solOnChain * (marketPrices.SOL ?? 0) : 0;
    const tokenUsd = tokensOnChain.reduce((acc, token) => {
      const symbol = normalizeAssetSymbol(token.symbol);
      if (!symbol) return acc;
      return acc + token.amount * (marketPrices[symbol] ?? 0);
    }, 0);
    const evmUsd = evmAssetsOnChain.reduce((acc, asset) => acc + asset.usdValue, 0);
    return Number((solUsd + tokenUsd + evmUsd).toFixed(2));
  }, [evmAssetsOnChain, marketPrices, solOnChain, tokensOnChain]);
  const visibleTotalUsd =
    isConnected && (solOnChain !== null || tokensOnChain.length > 0 || evmAssetsOnChain.length > 0) ? onChainVisibleTotal : accountAssetsTotal;
  const walletAssetChoices = useMemo(
    () => buildWalletAssetChoices({ solBalance: solOnChain, tokenRows: tokensOnChain }),
    [solOnChain, tokensOnChain]
  );
  const walletAssetChoiceByMint = useMemo(() => new Map(walletAssetChoices.map((choice) => [choice.mint, choice])), [walletAssetChoices]);
  const sendAssetChoices = walletAssetChoices;
  const swapAssetChoices = walletAssetChoices.filter((choice) => {
    const symbol = resolveSolanaSymbolForMint(choice.mint);
    return Boolean(symbol);
  });
  const supportedSwapTargets = useMemo<SwapTargetChoice[]>(
    () =>
      (["USDC", "USDT", "SOL", "MSOL"] as const).map((symbol) => ({
        symbol,
        mint: resolveSolanaTokenMint(symbol),
        label: symbol,
        decimals: resolveSolanaTokenDecimals(symbol)
      })),
    []
  );
  const swapTargetChoices = supportedSwapTargets;
  const defaultSendChoiceMint = sendChoiceMint || sendAssetChoices[0]?.mint || "";
  const defaultSwapFromMint = swapFromMint || swapAssetChoices[0]?.mint || "";
  const defaultSwapToMint = swapToMint || swapTargetChoices.find((choice) => choice.mint !== defaultSwapFromMint)?.mint || "";

  const refreshWalletViews = useCallback(() => {
    setWalletRefreshTick((tick) => tick + 1);
  }, []);

  useEffect(() => {
    if (!isConnected) return;
    const refreshNow = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      refreshWalletViews();
    };
    const intervalId = window.setInterval(refreshNow, 15_000);
    const handleVisibility = () => refreshNow();
    const handleFocus = () => refreshNow();
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);
    refreshNow();
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
    };
  }, [isConnected, refreshWalletViews]);

  const submitSendAction = useCallback(async () => {
    const choice = walletAssetChoiceByMint.get(sendChoiceMint);
    if (!choice) {
      setWalletActionError("보낼 자산을 선택하세요.");
      return;
    }
    if (!sendRecipient.trim()) {
      setWalletActionError("받는 주소를 입력하세요.");
      return;
    }
    if (!sendAmount.trim()) {
      setWalletActionError("보낼 수량을 입력하세요.");
      return;
    }
    if (!solanaAccount?.address) {
      setWalletActionError("Solana 지갑이 연결되어 있지 않습니다.");
      return;
    }
    setWalletActionLoading(true);
    setWalletActionError("");
    setWalletActionNote("");
    try {
      const { connection } = await createWalletActionConnection(network);
      const phantomSolana = readBrowserPhantomSolana();
      if (!phantomSolana) {
        throw new Error("Phantom Solana 지갑을 찾지 못했습니다.");
      }
      const result = await sendSolanaAsset({
        wallet: phantomSolana,
        connection,
        recipient: sendRecipient.trim(),
        choice,
        amount: sendAmount.trim()
      });
      setWalletActionNote(`tx ${shortTxid(result.signature)}`);
      refreshWalletViews();
    } catch (error) {
      setWalletActionError(error instanceof Error ? error.message : "전송 실패");
    } finally {
      setWalletActionLoading(false);
    }
  }, [network, refreshWalletViews, sendAmount, sendChoiceMint, sendRecipient, solanaAccount?.address, walletAssetChoiceByMint]);

  const submitSwapAction = useCallback(async () => {
    const fromChoice = walletAssetChoiceByMint.get(swapFromMint);
    if (!fromChoice) {
      setWalletActionError("바꿀 자산을 선택하세요.");
      return;
    }
    if (!swapToMint.trim()) {
      setWalletActionError("받을 자산을 선택하세요.");
      return;
    }
    if (!swapAmount.trim()) {
      setWalletActionError("스왑 수량을 입력하세요.");
      return;
    }
    if (!solanaAccount?.address) {
      setWalletActionError("Solana 지갑이 연결되어 있지 않습니다.");
      return;
    }
    if (swapToMint === swapFromMint) {
      setWalletActionError("같은 자산끼리는 스왑할 수 없습니다.");
      return;
    }
    setWalletActionLoading(true);
    setWalletActionError("");
    setWalletActionNote("");
    try {
      const { connection } = await createWalletActionConnection(network);
      const wallet = readBrowserPhantomSolana();
      if (!wallet) {
        throw new Error("Phantom Solana 지갑을 찾지 못했습니다.");
      }
      const result = await swapSolanaAsset({
        wallet,
        connection,
        from: fromChoice,
        toMint: swapToMint,
        amount: swapAmount.trim()
      });
      setWalletActionNote(`tx ${shortTxid(result.signature)}`);
      refreshWalletViews();
    } catch (error) {
      setWalletActionError(error instanceof Error ? error.message : "스왑 실패");
    } finally {
      setWalletActionLoading(false);
    }
  }, [network, refreshWalletViews, solanaAccount?.address, swapAmount, swapFromMint, swapToMint, walletAssetChoiceByMint]);

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
      <div className="wallet-account-menu-scroll">
        {accountMenuTab === "home" ? (
          <>
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
              <strong>
                {accountAssetsSnapshotLabel} · ${accountAssetsTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </strong>
              <em>{accountAssets.slice(0, 4).map((asset) => `${asset.symbol} $${asset.usdValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`).join(" · ") || "조회 전"}</em>
            </div>
          </>
        ) : null}
        {accountMenuTab === "send" ? (
          <div className="wallet-account-menu-section">
            <span>보내기</span>
            <strong>지갑 연결 후 전송할 수 있습니다.</strong>
            <em>현재는 지갑 연결과 계정 확인만 먼저 하세요.</em>
            <div className="wallet-account-actions wallet-account-actions-inline">
              <button type="button" onClick={openWalletCreate}>
                지갑 생성/연결
              </button>
            </div>
          </div>
        ) : null}
        {accountMenuTab === "swap" ? (
          <div className="wallet-account-menu-section">
            <span>교환</span>
            <strong>지갑 연결 후 스왑을 사용할 수 있습니다.</strong>
            <em>연결된 지갑이 있어야 팬텀 스왑 흐름이 활성화됩니다.</em>
            <div className="wallet-account-actions wallet-account-actions-inline">
              <button type="button" onClick={openWalletCreate}>
                지갑 생성/연결
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="wallet-account-menu-footer">
        <button
          type="button"
          className={`wallet-account-menu-icon-btn${accountMenuTab === "home" ? " active" : ""}`}
          onClick={() => setAccountMenuTab("home")}
          aria-label="홈"
          title="홈"
        >
          <WalletHomeGlyph />
        </button>
        <button
          type="button"
          className={`wallet-account-menu-icon-btn${accountMenuTab === "send" ? " active" : ""}`}
          onClick={() => setAccountMenuTab("send")}
          aria-label="보내기"
          title="보내기"
        >
          <WalletSendGlyph />
        </button>
        <button
          type="button"
          className={`wallet-account-menu-icon-btn${accountMenuTab === "swap" ? " active" : ""}`}
          onClick={() => setAccountMenuTab("swap")}
          aria-label="교환"
          title="교환"
        >
          <WalletSwapGlyph />
        </button>
        <button
          type="button"
          className="wallet-account-menu-icon-btn wallet-account-menu-icon-btn-danger"
          onClick={() => void onLogout()}
          aria-label="연결 해제"
          title="연결 해제"
        >
          <WalletLogoutGlyph />
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

  const walletActionChoices = walletAssetChoices;
  const selectedSendChoice = walletActionChoices.find((choice) => choice.mint === defaultSendChoiceMint) ?? walletActionChoices[0];
  const selectedSwapFromChoice = walletActionChoices.find((choice) => choice.mint === defaultSwapFromMint) ?? walletActionChoices[0];
  const selectedSwapToChoices = swapTargetChoices.filter((choice) => choice.mint !== selectedSwapFromChoice?.mint);
  const selectedSwapToChoice = selectedSwapToChoices.find((choice) => choice.mint === defaultSwapToMint) ?? selectedSwapToChoices[0] ?? null;

  const swapSelectedAssets = useCallback(() => {
    const currentFrom = swapFromMint || selectedSwapFromChoice?.mint || "";
    const currentTo = swapToMint || selectedSwapToChoice?.mint || "";
    const nextFrom = currentTo || selectedSwapToChoice?.mint || currentFrom;
    const nextTo = currentFrom || swapTargetChoices.find((choice) => choice.mint !== nextFrom)?.mint || "";
    setSwapFromMint(nextFrom);
    setSwapToMint(nextTo);
    setSwapFromMenuOpen(false);
    setSwapToMenuOpen(false);
    setSwapQuote(null);
    setSwapQuoteError("");
  }, [
    defaultSwapToMint,
    selectedSwapFromChoice,
    selectedSwapToChoice?.mint,
    swapFromMint,
    swapToMint,
    swapTargetChoices,
    walletAssetChoiceByMint
  ]);

  useEffect(() => {
    if (walletActionsTab !== "swap") {
      setSwapQuote(null);
      setSwapQuoteLoading(false);
      setSwapQuoteError("");
      return;
    }
    const fromChoice = walletAssetChoiceByMint.get(swapFromMint) ?? selectedSwapFromChoice;
    if (!fromChoice || !swapToMint || swapToMint === fromChoice.mint || !swapAmount.trim()) {
      setSwapQuote(null);
      setSwapQuoteLoading(false);
      setSwapQuoteError("");
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        setSwapQuoteLoading(true);
        setSwapQuoteError("");
        try {
          const amountRaw = new Decimal(swapAmount.trim()).mul(new Decimal(10).pow(fromChoice.decimals)).floor();
          if (!amountRaw.isFinite() || amountRaw.lte(0)) {
            throw new Error("스왑 수량을 다시 확인해 주세요.");
          }
          const quote = await quoteJupiterExactInSwap({
            inputMint: fromChoice.mint,
            outputMint: swapToMint,
            amountRaw: BigInt(amountRaw.toFixed(0)),
            slippageBps: 100
          });
          if (cancelled) return;
          const outputSymbol = resolveSolanaSymbolForMint(swapToMint) ?? "USDC";
          const outputDecimals = resolveSolanaTokenDecimals(outputSymbol);
          setSwapQuote({
            outAmountRaw: quote.outAmountRaw,
            minOutAmountRaw: quote.minOutAmountRaw,
            priceImpactPct: quote.priceImpactPct,
            outputDecimals,
            outputSymbol,
            outputMint: swapToMint
          });
        } catch (error) {
          if (cancelled) return;
          setSwapQuote(null);
          setSwapQuoteError(error instanceof Error ? error.message : "예상 수량을 계산하지 못했습니다.");
        } finally {
          if (!cancelled) setSwapQuoteLoading(false);
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    selectedSwapFromChoice,
    swapAmount,
    swapFromMint,
    swapToMint,
    walletActionsTab,
    walletAssetChoiceByMint
  ]);

  useEffect(() => {
    if (walletActionsTab !== "swap") return;
    if (!swapFromMint || !swapToMint || swapFromMint !== swapToMint) return;
    const nextTarget = swapTargetChoices.find((choice) => choice.mint !== swapFromMint)?.mint ?? "";
    if (nextTarget && nextTarget !== swapToMint) {
      setSwapToMint(nextTarget);
    }
  }, [swapFromMint, swapToMint, swapTargetChoices, walletActionsTab]);

  useEffect(() => {
    if (walletActionsTab !== "send") {
      setSendTokenMenuOpen(false);
    }
  }, [walletActionsTab]);

  useEffect(() => {
    if (walletActionsTab !== "swap") {
      setSwapFromMenuOpen(false);
      setSwapToMenuOpen(false);
    }
  }, [walletActionsTab]);

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
    const openTab = (tab: WalletMenuTab) => {
      setWalletActionsTab(tab);
      setWalletActionError("");
      setWalletActionNote("");
    };
    return (
      <div className={opts.compact ? "wallet-action-panel wallet-action-panel-compact" : "wallet-action-panel"}>
        <div className="wallet-action-tab-body">
          {walletActionsTab === "home" ? (
            <div className="wallet-action-home-screen">
              <div className="wallet-home-total-card">
                <span className="wallet-home-label">총 자산</span>
                <strong>${visibleTotalUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
                <em>
                  {accountAssetsSnapshotLabel} · {walletHomeLedgerOpen ? "내역 표시 중" : "내역 숨김"}
                </em>
                <button type="button" className="wallet-home-action wallet-home-action-ledger" onClick={() => setWalletHomeLedgerOpen((prev) => !prev)}>
                  {walletHomeLedgerOpen ? "입출금내역 숨기기" : "입출금내역 보기"}
                </button>
              </div>
              <div className="wallet-home-panels">
                <ChainAssetsTable
                  loading={chainLoading}
                  error={chainError}
                  sol={solOnChain}
                  tokens={tokensOnChain}
                  network={network}
                  compact={opts.compact}
                  prices={marketPrices}
                  priceMeta={priceMeta}
                />
                <EvmAssetsTable loading={evmChainLoading} error={evmChainError} rows={evmAssetsOnChain} compact={opts.compact} priceMeta={priceMeta} />
              </div>
              {walletHomeLedgerOpen ? ledgerSection : null}
            </div>
          ) : null}
          {walletActionsTab === "send" ? (
            <div className="wallet-action-screen">
              <div className="wallet-action-summary">
                <div className="wallet-action-summary-main wallet-action-summary-main-amount">
                  <span className="wallet-action-summary-label">전송 예정 수량</span>
                  <input
                    className="wallet-send-amount-input"
                    value={sendAmount}
                    onChange={(e) => setSendAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="0.00"
                  />
                </div>
                <div className="wallet-action-summary-main">
                  <span className="wallet-action-summary-label">토큰</span>
                  <button
                    type="button"
                    className="wallet-send-token-button"
                    onClick={() => setSendTokenMenuOpen((prev) => !prev)}
                    aria-expanded={sendTokenMenuOpen}
                  >
                    <strong>{selectedSendChoice?.symbol ?? "—"}</strong>
                    <em>{selectedSendChoice ? `${selectedSendChoice.label} · 보유 ${formatTokenAmount(selectedSendChoice.amount)}` : "선택된 자산 없음"}</em>
                  </button>
                  {sendTokenMenuOpen ? (
                    <div className="wallet-send-token-menu" role="listbox" aria-label="보낼 토큰 선택">
                      {walletActionChoices.map((choice) => (
                        <button
                          key={choice.mint}
                          type="button"
                          className={`wallet-send-token-menu-item${choice.mint === selectedSendChoice?.mint ? " active" : ""}`}
                          onClick={() => {
                            setSendChoiceMint(choice.mint);
                            setSendTokenMenuOpen(false);
                          }}
                        >
                          <strong>{choice.symbol}</strong>
                          <em>{choice.label} · 보유 {formatTokenAmount(choice.amount)}</em>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="wallet-action-form">
                <label>
                  받는 주소
                  <input
                    className="wallet-send-recipient-input"
                    value={sendRecipient}
                    onChange={(e) => setSendRecipient(e.target.value)}
                    placeholder="Solana 주소"
                  />
                </label>
              </div>
              <div className="wallet-action-confirm-row">
                <button
                  type="button"
                  className="wallet-action-confirm-btn"
                  onClick={() => void submitSendAction()}
                  disabled={walletActionLoading}
                >
                  {walletActionLoading ? "전송 확인 중…" : "전송 확인"}
                </button>
              </div>
              {walletActionError ? <p className="wallet-error">{walletActionError}</p> : null}
              {walletActionNote ? <p className="wallet-action-note">{walletActionNote}</p> : null}
            </div>
          ) : null}
          {walletActionsTab === "swap" ? (
            <div className="wallet-action-screen">
              <div className="wallet-swap-panel">
                <div className="wallet-swap-stack">
                  <div className="wallet-swap-stack-card-wrap">
                    <div className="wallet-swap-stack-card">
                      <span className="wallet-swap-side-label">보내는 자산</span>
                      <div className="wallet-swap-stack-card-row">
                        <button
                          type="button"
                          className="wallet-swap-token-trigger"
                          onClick={() => {
                            setSwapFromMenuOpen((prev) => !prev);
                            setSwapToMenuOpen(false);
                          }}
                          aria-expanded={swapFromMenuOpen}
                        >
                          <strong>{selectedSwapFromChoice?.symbol ?? "선택"}</strong>
                          <em>{selectedSwapFromChoice ? formatTokenAmount(selectedSwapFromChoice.amount) : "보유 잔고 없음"}</em>
                        </button>
                        <input
                          className="wallet-swap-stack-card-input"
                          value={swapAmount}
                          onChange={(e) => setSwapAmount(e.target.value)}
                          inputMode="decimal"
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                    {swapFromMenuOpen ? (
                      <div className="wallet-swap-token-menu" role="listbox" aria-label="보낼 토큰 선택">
                        {walletAssetChoices.map((choice) => (
                          <button
                            key={choice.mint}
                            type="button"
                            className={`wallet-swap-token-menu-item${choice.mint === selectedSwapFromChoice?.mint ? " active" : ""}`}
                            onClick={() => {
                              setSwapFromMint(choice.mint);
                              setSwapFromMenuOpen(false);
                              setSwapToMenuOpen(false);
                            }}
                          >
                            <strong>{choice.symbol}</strong>
                            <em>{choice.label} · 보유 {formatTokenAmount(choice.amount)}</em>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <button type="button" className="wallet-swap-exchange" onClick={swapSelectedAssets} aria-label="보내는 토큰과 받는 토큰 교체">
                    <WalletCircularSwapGlyph />
                  </button>
                  <div className="wallet-swap-stack-card-wrap">
                    <div className="wallet-swap-stack-card">
                      <span className="wallet-swap-side-label">받는 자산</span>
                      <div className="wallet-swap-stack-card-row">
                        <button
                          type="button"
                          className="wallet-swap-token-trigger"
                          onClick={() => {
                            setSwapToMenuOpen((prev) => !prev);
                            setSwapFromMenuOpen(false);
                          }}
                          aria-expanded={swapToMenuOpen}
                        >
                          <strong>{selectedSwapToChoice?.symbol ?? "선택"}</strong>
                        </button>
                        <input
                          className="wallet-swap-stack-card-input"
                          value={
                            swapQuoteLoading
                              ? "조회 중"
                              : swapQuote
                                ? formatRawAmount(swapQuote.outAmountRaw, swapQuote.outputDecimals)
                                : ""
                          }
                          readOnly
                          placeholder="예상 수령"
                        />
                      </div>
                    </div>
                    {swapToMenuOpen ? (
                      <div className="wallet-swap-token-menu" role="listbox" aria-label="받을 토큰 선택">
                        {selectedSwapToChoices.map((choice) => (
                          <button
                            key={choice.mint}
                            type="button"
                            className={`wallet-swap-token-menu-item${choice.mint === selectedSwapToChoice?.mint ? " active" : ""}`}
                            onClick={() => {
                              setSwapToMint(choice.mint);
                              setSwapToMenuOpen(false);
                              setSwapFromMenuOpen(false);
                            }}
                          >
                            <strong>{choice.symbol}</strong>
                            <em>{choice.label}</em>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="wallet-action-confirm-row">
                <button
                  type="button"
                  className="wallet-action-confirm-btn"
                  onClick={() => void submitSwapAction()}
                  disabled={walletActionLoading}
                >
                  {walletActionLoading ? "교환 확인 중…" : "교환 확인"}
                </button>
              </div>
              {walletActionError ? <p className="wallet-error">{walletActionError}</p> : null}
              {walletActionNote ? <p className="wallet-action-note">{walletActionNote}</p> : null}
              {swapQuoteError ? <p className="wallet-error">{swapQuoteError}</p> : null}
            </div>
          ) : null}
        </div>
        <div className="wallet-action-bottom-bar">
          <button
            type="button"
            className={`wallet-action-icon-btn${walletActionsTab === "home" ? " active" : ""}`}
            onClick={() => openTab("home")}
            aria-label="홈"
            title="홈"
          >
            <WalletHomeGlyph />
          </button>
          <button
            type="button"
            className={`wallet-action-icon-btn${walletActionsTab === "send" ? " active" : ""}`}
            onClick={() => openTab("send")}
            disabled={!isConnected || walletAssetChoices.length === 0}
            aria-label="보내기"
            title="보내기"
          >
            <WalletSendGlyph />
          </button>
          <button
            type="button"
            className={`wallet-action-icon-btn${walletActionsTab === "swap" ? " active" : ""}`}
            onClick={() => openTab("swap")}
            disabled={!isConnected || walletAssetChoices.length < 2}
            aria-label="교환"
            title="교환"
          >
            <WalletSwapGlyph />
          </button>
          <button
            type="button"
            className="wallet-action-icon-btn wallet-action-icon-btn-danger"
            onClick={() => afterNav(onDisconnect)}
            aria-label="연결 해제"
            title="연결 해제"
          >
            <WalletLogoutGlyph />
          </button>
        </div>
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
        mainnet_live
      </button>
      <button type="button" className={network === "devnet" ? "active" : ""} onClick={() => setNetwork("devnet")}>
        devnet
      </button>
    </div>
  );

  if (compact) {
    return (
      <>
      <section className="wallet-widget">
        {isConnected ? (
          <>
            <div className="wallet-widget-head wallet-widget-head-address-only" ref={compactDetailRef}>
              <button type="button" className="wallet-address-link" onClick={() => setIsCompactDetailOpen((prev) => !prev)}>
                {walletAddressLabel} {isCompactDetailOpen ? "▴" : "▾"}
              </button>
            </div>
            {copyHint ? <p className="wallet-copy-hint wallet-copy-hint-compact">{copyHint}</p> : null}
            {isCompactDetailOpen ? (
              <div className="wallet-compact-detail">
                {actionRow({ compact: true })}
              </div>
            ) : null}
          </>
        ) : (
          <div className="wallet-widget-head wallet-widget-head-address-only" ref={appUsername ? accountMenuRef : undefined}>
            {appUsername ? (
              <button
                type="button"
                className="wallet-address-link"
                onClick={() => {
                  setAccountMenuOpen((prev) => {
                    const next = !prev;
                    if (next) setAccountMenuTab("home");
                    return next;
                  });
                }}
              >
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
