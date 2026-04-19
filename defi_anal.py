"""DeFi 유동성 공급(LP) 종합 분석 & 포트폴리오 백테스트 & HTML 리포트 생성 통합 스크립트.

이 단일 파일로 다음 단계를 순차 수행한다:

    1) DefiLlama Yields API 에서 이더리움/아비트럼/베이스/솔라나 대표 풀 메타데이터 수집
    2) 풀별 일별 APY 시계열로 평균/중앙값/변동성 등 통계 산출
    3) (옵션) DefiLlama Coins API 로 토큰 가격 받아 IL(비영구손실) 보정 수익률 계산
    4) (옵션) Uniswap V3/CLMM 집중유동성 범위별(±5%, ±10%, ±20%, ±50%)
             time-in-range 및 순수익 시뮬레이션
    5) 프로젝트별 30일 rolling APY 플롯 PNG 저장
    6) L1 / L2 두 전략에 대해 포트폴리오 NAV, CAGR, 변동성, Sharpe, MaxDD 백테스트
       + 월간/분기 리밸런싱 + 구성요소별 민감도 + Monte Carlo 최소분산 최적화
       + 포트폴리오 NAV 플롯 PNG 저장
    7) 위 모든 결과와 플롯을 임베드한 자립형 HTML 리포트 생성

기본 사용:

    python3 defi_anal.py
    python3 defi_anal.py --days 365 --skip-report
    python3 defi_anal.py --only pools
    python3 defi_anal.py --only portfolio --strategy l2
    python3 defi_anal.py --only report

참고: HTML 리포트의 표/수치는 이전 분석 실행으로 확정된 값을 템플릿에 고정한 것이며,
매 실행의 최신 수치가 표에 자동 반영되지는 않는다(참고용 정적 문서). 플롯 이미지만
재생성 PNG 로 교체된다.
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import math
import os
import statistics
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.request import Request, urlopen

import numpy as np


# ===========================================================================
# 1. 공통 설정 · 상수
# ===========================================================================

POOLS_URL = "https://yields.llama.fi/pools"
CHART_URL = "https://yields.llama.fi/chart/{pool_id}"
COIN_CHART_URL = "https://coins.llama.fi/chart/coingecko:{cg_id}?span={days}&period=1d"

COINGECKO_IDS: dict[str, str] = {
    "ETH": "ethereum",
    "WETH": "ethereum",
    "BTC": "bitcoin",
    "WBTC": "wrapped-bitcoin",
    "CBBTC": "coinbase-wrapped-btc",
    "SOL": "solana",
    "WSOL": "solana",
    "MSOL": "msol",
    "STETH": "staked-ether",
    "USDC": "usd-coin",
    "USDT": "tether",
    "DAI": "dai",
    "FRAX": "frax",
    "BOME": "book-of-meme",
    "MEW": "cat-in-a-dogs-world",
    "RAY": "raydium",
}

STABLE_TOKENS = {"USDC", "USDT", "DAI", "FRAX", "TUSD", "USDE", "GUSD", "BUSD"}

# 래핑 토큰 정규화. LSD(stETH/mSOL) 는 기초와 가격이 달라 별도 유지.
_TOKEN_NORMALIZE = {
    "WSOL": "SOL",
    "WETH": "ETH",
    "WBTC": "BTC",
    "CBBTC": "BTC",
    "STETH": "STETH",
    "MSOL": "MSOL",
}

# 각 프로젝트 대표 풀 (project/chain/symbol 로 매칭).
TARGETS: list[dict[str, Any]] = [
    # --- Ethereum Mainnet ---
    {"label": "Uniswap V3 / ETH-USDC (0.05%)",   "project": "uniswap-v3", "chain": "Ethereum", "symbol": "USDC-WETH", "fee_hint": 0.0005},
    {"label": "Uniswap V3 / WBTC-ETH (0.3%)",    "project": "uniswap-v3", "chain": "Ethereum", "symbol": "WBTC-WETH", "fee_hint": 0.003},
    {"label": "Uniswap V3 / USDC-USDT (0.01%)",  "project": "uniswap-v3", "chain": "Ethereum", "symbol": "USDC-USDT", "fee_hint": 0.0001},
    {"label": "Curve / 3pool (DAI-USDC-USDT)",   "project": "curve-dex",  "chain": "Ethereum", "symbol": "DAI-USDC-USDT"},
    {"label": "Curve / stETH-ETH",               "project": "curve-dex",  "chain": "Ethereum", "symbol": "STETH-ETH"},
    {"label": "Curve / FRAX-USDC",               "project": "curve-dex",  "chain": "Ethereum", "symbol": "FRAX-USDC"},
    {"label": "Aave V3 / USDC supply",           "project": "aave-v3",    "chain": "Ethereum", "symbol": "USDC"},
    {"label": "Aave V3 / WETH supply",           "project": "aave-v3",    "chain": "Ethereum", "symbol": "WETH"},
    {"label": "Aave V3 / WBTC supply",           "project": "aave-v3",    "chain": "Ethereum", "symbol": "WBTC"},

    # --- Solana ---
    {"label": "Orca / SOL-USDC",                 "project": "orca-dex",   "chain": "Solana",   "symbol": "SOL-USDC"},
    {"label": "Orca / mSOL-SOL",                 "project": "orca-dex",   "chain": "Solana",   "symbol": "SOL-MSOL"},
    {"label": "Orca / USDC-USDT",                "project": "orca-dex",   "chain": "Solana",   "symbol": "USDC-USDT"},
    {"label": "Raydium / SOL-USDC",              "project": "raydium-amm","chain": "Solana",   "symbol": "WSOL-USDC"},
    {"label": "Raydium / BOME-SOL",              "project": "raydium-amm","chain": "Solana",   "symbol": "BOME-WSOL"},
    {"label": "Raydium / MEW-SOL",               "project": "raydium-amm","chain": "Solana",   "symbol": "MEW-WSOL"},

    # --- Arbitrum ---
    {"label": "Aave V3 Arbitrum / USDC",          "project": "aave-v3",    "chain": "Arbitrum", "symbol": "USDC"},
    {"label": "Aave V3 Arbitrum / WETH",          "project": "aave-v3",    "chain": "Arbitrum", "symbol": "WETH"},
    {"label": "Uniswap V3 Arbitrum / ETH-USDC (0.05%)", "project": "uniswap-v3", "chain": "Arbitrum", "symbol": "WETH-USDC", "fee_hint": 0.0005},
    {"label": "Uniswap V3 Arbitrum / USDC-USDT",  "project": "uniswap-v3", "chain": "Arbitrum", "symbol": "USDC-USDT"},

    # --- Base ---
    {"label": "Aave V3 Base / USDC",              "project": "aave-v3",    "chain": "Base",     "symbol": "USDC"},
    {"label": "Aave V3 Base / WETH",              "project": "aave-v3",    "chain": "Base",     "symbol": "WETH"},
    {"label": "Uniswap V3 Base / ETH-USDC (0.05%)", "project": "uniswap-v3", "chain": "Base",     "symbol": "WETH-USDC", "fee_hint": 0.0005},
    {"label": "Aerodrome Base / USDC-USDT",       "project": "aerodrome-slipstream", "chain": "Base", "symbol": "USDC-USDT"},
]


# ===========================================================================
# 2. HTTP · 카탈로그 · 시계열 수집
# ===========================================================================

def _http_get_json(url: str, timeout: float = 30.0, retries: int = 3) -> Any:
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = Request(url, headers={"User-Agent": "defi-anal/1.0"})
            with urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last_err}")


def fetch_pools_catalog() -> list[dict[str, Any]]:
    data = _http_get_json(POOLS_URL)
    if isinstance(data, dict) and "data" in data:
        return list(data["data"])
    if isinstance(data, list):
        return data
    raise RuntimeError("Unexpected pools payload shape")


def fetch_pool_chart(pool_id: str) -> list[dict[str, Any]]:
    url = CHART_URL.format(pool_id=pool_id)
    payload = _http_get_json(url)
    if isinstance(payload, dict) and "data" in payload:
        return list(payload["data"])
    if isinstance(payload, list):
        return payload
    return []


def fetch_price_series(symbol: str, days: int) -> dict[datetime, float] | None:
    sym = symbol.upper()
    if sym in STABLE_TOKENS:
        now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        return {now - timedelta(days=i): 1.0 for i in range(days)}
    cg = COINGECKO_IDS.get(sym)
    if not cg:
        return None
    url = COIN_CHART_URL.format(cg_id=cg, days=days)
    try:
        payload = _http_get_json(url)
    except Exception:  # noqa: BLE001
        return None
    key = f"coingecko:{cg}"
    entries = (payload.get("coins") or {}).get(key, {}).get("prices") or []
    out: dict[datetime, float] = {}
    for e in entries:
        try:
            ts = datetime.fromtimestamp(float(e["timestamp"]), tz=timezone.utc)
            ts = ts.replace(hour=0, minute=0, second=0, microsecond=0)
            out[ts] = float(e["price"])
        except (KeyError, TypeError, ValueError):
            continue
    return out or None


# ===========================================================================
# 3. 풀 매칭
# ===========================================================================

def _is_ascii(s: str) -> bool:
    return all(ord(c) < 128 for c in s)


def _normalize_tokens(symbol: str) -> set[str]:
    toks = symbol.upper().replace("/", "-").split("-")
    return {_TOKEN_NORMALIZE.get(t, t) for t in toks if t}


def _parse_symbol_tokens(symbol: str) -> list[str]:
    return [t for t in symbol.upper().replace("/", "-").split("-") if t]


def _score_match(pool: dict[str, Any], target: dict[str, Any]) -> float:
    """DefiLlama 풀 카탈로그 엔트리가 타깃과 얼마나 잘 맞는지 점수화.

    엄격 규칙:
      1) project / chain 불일치 → 탈락
      2) symbol 에 비-ASCII 문자 → 탈락 (스캠/위장 풀 배제)
      3) 정규화된 토큰 집합이 완전 일치 아니면 탈락
      4) 이후 TVL 로그 + fee_hint 로 타이브레이크
    """
    if pool.get("project") != target["project"]:
        return -1
    if pool.get("chain") != target["chain"]:
        return -1
    sym = pool.get("symbol") or ""
    if not sym or not _is_ascii(sym):
        return -1
    if _normalize_tokens(sym) != _normalize_tokens(target["symbol"]):
        return -1

    score = 100.0
    if "fee_hint" in target:
        meta = str(pool.get("poolMeta") or "").lower().replace(" ", "")
        hint_pct = f"{target['fee_hint'] * 100:g}%"
        if hint_pct in meta:
            score += 30
    tvl = pool.get("tvlUsd") or 0
    if tvl > 0:
        score += min(20.0, math.log10(tvl))
    return score


def find_pool(catalog: list[dict[str, Any]], target: dict[str, Any]) -> dict[str, Any] | None:
    best: tuple[float, dict[str, Any]] | None = None
    for p in catalog:
        s = _score_match(p, target)
        if s < 0:
            continue
        if best is None or s > best[0]:
            best = (s, p)
    return best[1] if best else None


# ===========================================================================
# 4. 풀 통계 (mean/median/std/percentile)
# ===========================================================================

@dataclass
class PoolStats:
    label: str
    pool_id: str
    project: str
    chain: str
    symbol: str
    tvl_usd: float
    n_samples: int
    first_date: str
    last_date: str
    mean_apy: float
    median_apy: float
    stdev_apy: float
    min_apy: float
    max_apy: float
    p25_apy: float
    p75_apy: float
    mean_apy_base: float = float("nan")
    mean_apy_reward: float = float("nan")
    notes: list[str] = field(default_factory=list)

    def as_row(self) -> list[Any]:
        return [
            self.label, self.project, self.chain, self.symbol,
            f"{self.tvl_usd:,.0f}", self.n_samples, self.first_date, self.last_date,
            f"{self.mean_apy:.2f}", f"{self.median_apy:.2f}", f"{self.stdev_apy:.2f}",
            f"{self.p25_apy:.2f}", f"{self.p75_apy:.2f}",
            f"{self.min_apy:.2f}", f"{self.max_apy:.2f}",
            f"{self.mean_apy_base:.2f}" if self.mean_apy_base == self.mean_apy_base else "-",
            f"{self.mean_apy_reward:.2f}" if self.mean_apy_reward == self.mean_apy_reward else "-",
        ]


POOLSTAT_HEADER = [
    "label", "project", "chain", "symbol",
    "tvl_usd", "n_days", "first", "last",
    "mean_apy%", "median%", "std%",
    "p25%", "p75%", "min%", "max%",
    "mean_base%", "mean_reward%",
]


def _percentile(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return float("nan")
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    k = (len(sorted_vals) - 1) * q
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    if f == c:
        return sorted_vals[f]
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def summarize(label: str, pool_meta: dict[str, Any], chart: list[dict[str, Any]], lookback_days: int) -> PoolStats | None:
    if not chart:
        return None
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)

    apys: list[float] = []
    apys_base: list[float] = []
    apys_reward: list[float] = []
    dates: list[datetime] = []

    for row in chart:
        ts_raw = row.get("timestamp")
        if ts_raw is None:
            continue
        try:
            if isinstance(ts_raw, (int, float)):
                ts = datetime.fromtimestamp(float(ts_raw), tz=timezone.utc)
            else:
                ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
        except Exception:  # noqa: BLE001
            continue
        if ts < cutoff:
            continue
        apy = row.get("apy")
        if apy is None:
            continue
        try:
            apy_v = float(apy)
        except (TypeError, ValueError):
            continue
        apys.append(apy_v)
        dates.append(ts)

        ab = row.get("apyBase")
        ar = row.get("apyReward")
        if ab is not None:
            try:
                apys_base.append(float(ab))
            except (TypeError, ValueError):
                pass
        if ar is not None:
            try:
                apys_reward.append(float(ar))
            except (TypeError, ValueError):
                pass

    if not apys:
        return None

    apys_sorted = sorted(apys)
    return PoolStats(
        label=label,
        pool_id=str(pool_meta.get("pool")),
        project=str(pool_meta.get("project")),
        chain=str(pool_meta.get("chain")),
        symbol=str(pool_meta.get("symbol")),
        tvl_usd=float(pool_meta.get("tvlUsd") or 0),
        n_samples=len(apys),
        first_date=min(dates).strftime("%Y-%m-%d"),
        last_date=max(dates).strftime("%Y-%m-%d"),
        mean_apy=statistics.fmean(apys),
        median_apy=statistics.median(apys),
        stdev_apy=statistics.pstdev(apys) if len(apys) > 1 else 0.0,
        min_apy=min(apys),
        max_apy=max(apys),
        p25_apy=_percentile(apys_sorted, 0.25),
        p75_apy=_percentile(apys_sorted, 0.75),
        mean_apy_base=statistics.fmean(apys_base) if apys_base else float("nan"),
        mean_apy_reward=statistics.fmean(apys_reward) if apys_reward else float("nan"),
    )


# ===========================================================================
# 5. IL(비영구손실) 보정 수익률
# ===========================================================================

@dataclass
class ILResult:
    label: str
    token_a: str
    token_b: str
    n_days: int
    lp_value_ratio: float
    hold_value_ratio: float
    il_pct: float
    cum_fee_return_pct: float
    lp_with_fees_ratio: float
    net_vs_hold_pct: float
    annualized_net_pct: float


def _align_series(
    apy_rows: list[dict[str, Any]],
    price_a: dict[datetime, float],
    price_b: dict[datetime, float],
    lookback_days: int,
) -> list[tuple[datetime, float, float, float]]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    merged: list[tuple[datetime, float, float, float]] = []
    for row in apy_rows:
        ts_raw = row.get("timestamp")
        apy = row.get("apy")
        if ts_raw is None or apy is None:
            continue
        try:
            if isinstance(ts_raw, (int, float)):
                ts = datetime.fromtimestamp(float(ts_raw), tz=timezone.utc)
            else:
                ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
        except Exception:  # noqa: BLE001
            continue
        day = ts.replace(hour=0, minute=0, second=0, microsecond=0)
        if day < cutoff:
            continue
        pa = price_a.get(day)
        pb = price_b.get(day)
        if pa is None or pb is None:
            for off in (1, -1, 2, -2):
                pa = pa if pa is not None else price_a.get(day + timedelta(days=off))
                pb = pb if pb is not None else price_b.get(day + timedelta(days=off))
                if pa is not None and pb is not None:
                    break
        if pa is None or pb is None:
            continue
        try:
            merged.append((day, float(apy), float(pa), float(pb)))
        except (TypeError, ValueError):
            continue
    merged.sort(key=lambda x: x[0])
    dedup: dict[datetime, tuple[datetime, float, float, float]] = {}
    for rec in merged:
        dedup[rec[0]] = rec
    return list(dedup.values())


def compute_il_adjusted_return(
    label: str, symbol: str, chart: list[dict[str, Any]], lookback_days: int
) -> ILResult | None:
    toks = _parse_symbol_tokens(symbol)
    if len(toks) != 2:
        return None
    a, b = toks[0], toks[1]
    pa_series = fetch_price_series(a, lookback_days + 7)
    pb_series = fetch_price_series(b, lookback_days + 7)
    if pa_series is None or pb_series is None:
        return None

    aligned = _align_series(chart, pa_series, pb_series, lookback_days)
    if len(aligned) < 10:
        return None

    p_a0, p_b0 = aligned[0][2], aligned[0][3]
    p_aT, p_bT = aligned[-1][2], aligned[-1][3]
    ratio_a = p_aT / p_a0
    ratio_b = p_bT / p_b0
    # 50/50 constant-product: V_LP/V_0 = sqrt(r_a * r_b)
    lp_ratio = (ratio_a * ratio_b) ** 0.5
    hold_ratio = 0.5 * ratio_a + 0.5 * ratio_b
    il = 1.0 - lp_ratio / hold_ratio

    cum_fee = 1.0
    for _, apy_pct, _, _ in aligned:
        daily = (1.0 + max(0.0, apy_pct) / 100.0) ** (1.0 / 365.0) - 1.0
        cum_fee *= 1.0 + daily

    lp_with_fees = lp_ratio * cum_fee
    net_vs_hold = lp_with_fees / hold_ratio - 1.0
    days_elapsed = (aligned[-1][0] - aligned[0][0]).days or 1
    ann_net = (1.0 + net_vs_hold) ** (365.0 / days_elapsed) - 1.0

    return ILResult(
        label=label, token_a=a, token_b=b, n_days=len(aligned),
        lp_value_ratio=lp_ratio, hold_value_ratio=hold_ratio,
        il_pct=il * 100.0,
        cum_fee_return_pct=(cum_fee - 1.0) * 100.0,
        lp_with_fees_ratio=lp_with_fees,
        net_vs_hold_pct=net_vs_hold * 100.0,
        annualized_net_pct=ann_net * 100.0,
    )


# ===========================================================================
# 6. Uniswap V3 / CLMM 범위 시뮬 (volatile-stable 전용)
# ===========================================================================

@dataclass
class RangeSimResult:
    label: str
    width_pct: float
    concentration: float
    time_in_range_pct: float
    mean_apy_in_range: float
    effective_fee_apr_pct: float
    il_at_end_pct: float
    net_return_pct: float


def _v3_position_value(p: float, pa: float, pb: float, p0: float) -> float:
    """초기 V_0=1 정규화된 V3 volatile-stable 포지션의 가격 p 에서 USD 가치."""
    s, sa, sb, s0 = p ** 0.5, pa ** 0.5, pb ** 0.5, p0 ** 0.5
    if not (sa < sb):
        return float("nan")
    if s0 <= sa:
        v0_per_L = (1.0 / sa - 1.0 / sb) * p0
    elif s0 >= sb:
        v0_per_L = sb - sa
    else:
        v0_per_L = 2.0 * s0 - sa - p0 / sb
    if v0_per_L <= 0:
        return float("nan")
    L = 1.0 / v0_per_L
    if s <= sa:
        return L * (1.0 / sa - 1.0 / sb) * p
    if s >= sb:
        return L * (sb - sa)
    return L * (2.0 * s - sa - p / sb)


def simulate_v3_ranges(
    label: str, symbol: str, chart: list[dict[str, Any]],
    lookback_days: int, widths: list[float],
) -> list[RangeSimResult]:
    toks = _parse_symbol_tokens(symbol)
    if len(toks) != 2:
        return []
    a, b = toks[0], toks[1]
    if a in STABLE_TOKENS and b in STABLE_TOKENS:
        return []
    if a in STABLE_TOKENS:
        a, b = b, a
    if b not in STABLE_TOKENS:
        return []

    pa_series = fetch_price_series(a, lookback_days + 7)
    if pa_series is None:
        return []
    pb_series = {d: 1.0 for d in pa_series}

    aligned = _align_series(chart, pa_series, pb_series, lookback_days)
    if len(aligned) < 10:
        return []

    p0 = aligned[0][2]
    prices = [rec[2] for rec in aligned]
    apys = [rec[1] for rec in aligned]
    pool_mean_apy = statistics.fmean(apys)

    results: list[RangeSimResult] = []
    for w in widths:
        pa = p0 * (1.0 - w)
        pb = p0 * (1.0 + w)
        if pa <= 0:
            continue
        C = 1.0 / (1.0 - (pa / pb) ** 0.5)

        in_range_prices = [p for p in prices if pa <= p <= pb]
        tir = len(in_range_prices) / len(prices)
        effective_apr = pool_mean_apy * tir * C

        cum_fee = 1.0
        for rec in aligned:
            p, apy = rec[2], rec[1]
            if pa <= p <= pb:
                daily = (1.0 + max(0.0, apy) / 100.0 * C) ** (1.0 / 365.0) - 1.0
                cum_fee *= 1.0 + daily
        v_end = _v3_position_value(prices[-1], pa, pb, p0)
        if v_end != v_end:  # nan
            continue
        il_at_end_pct = (1.0 - v_end / (0.5 * (prices[-1] / p0) + 0.5)) * 100.0
        net_return_pct = (v_end * cum_fee - 1.0) * 100.0

        results.append(RangeSimResult(
            label=label, width_pct=w * 100.0, concentration=C,
            time_in_range_pct=tir * 100.0, mean_apy_in_range=pool_mean_apy,
            effective_fee_apr_pct=effective_apr,
            il_at_end_pct=il_at_end_pct, net_return_pct=net_return_pct,
        ))
    return results


# ===========================================================================
# 7. 풀 rolling APY 플롯
# ===========================================================================

def plot_rolling(
    results_with_charts: list[tuple[PoolStats, list[dict[str, Any]]]],
    out_dir: str, lookback_days: int, window: int = 30,
) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    os.makedirs(out_dir, exist_ok=True)
    by_project: dict[str, list[tuple[PoolStats, list[dict[str, Any]]]]] = {}
    for s, chart in results_with_charts:
        by_project.setdefault(s.project, []).append((s, chart))

    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    for project, items in by_project.items():
        fig, ax = plt.subplots(figsize=(11, 5.5))
        for stat, chart in items:
            dates: list[datetime] = []
            apys: list[float] = []
            for row in chart:
                ts_raw = row.get("timestamp")
                apy = row.get("apy")
                if ts_raw is None or apy is None:
                    continue
                try:
                    if isinstance(ts_raw, (int, float)):
                        ts = datetime.fromtimestamp(float(ts_raw), tz=timezone.utc)
                    else:
                        ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
                except Exception:  # noqa: BLE001
                    continue
                if ts < cutoff:
                    continue
                try:
                    apys.append(float(apy))
                    dates.append(ts)
                except (TypeError, ValueError):
                    continue
            if len(apys) < window:
                continue
            roll: list[float] = []
            for i in range(len(apys)):
                lo = max(0, i - window + 1)
                roll.append(sum(apys[lo:i + 1]) / (i - lo + 1))
            ax.plot(dates, roll, label=stat.label, linewidth=1.6)
        ax.set_title(f"{project} — {window}d rolling APY (last {lookback_days}d)")
        ax.set_ylabel("APY (%)")
        ax.grid(True, alpha=0.3)
        ax.legend(loc="best", fontsize=8)
        fig.autofmt_xdate()
        out = os.path.join(out_dir, f"rolling_apy_{project}.png")
        fig.tight_layout()
        fig.savefig(out, dpi=130)
        plt.close(fig)
        print(f"    저장: {out}")


# ===========================================================================
# 8. 포트폴리오 구성요소 NAV 빌더
# ===========================================================================

@dataclass
class ComponentSeries:
    key: str
    name: str
    dates: np.ndarray       # datetime64[D]
    nav: np.ndarray
    daily_return: np.ndarray


def _chart_to_daily_apy(chart: list[dict[str, Any]], lookback_days: int) -> list[tuple[datetime, float]]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days + 3)
    out: dict[datetime, float] = {}
    for row in chart:
        ts_raw = row.get("timestamp")
        apy = row.get("apy")
        if ts_raw is None or apy is None:
            continue
        try:
            if isinstance(ts_raw, (int, float)):
                ts = datetime.fromtimestamp(float(ts_raw), tz=timezone.utc)
            else:
                ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
            day = ts.replace(hour=0, minute=0, second=0, microsecond=0)
        except Exception:  # noqa: BLE001
            continue
        if day < cutoff:
            continue
        try:
            out[day] = float(apy)
        except (TypeError, ValueError):
            continue
    return sorted(out.items(), key=lambda x: x[0])


def _to_np_dates(dates: list[datetime]) -> np.ndarray:
    return np.array([np.datetime64(d.date(), "D") for d in dates])


def build_stable_nav(chart: list[dict[str, Any]], lookback_days: int) -> ComponentSeries | None:
    apy_series = _chart_to_daily_apy(chart, lookback_days)
    if len(apy_series) < 30:
        return None
    dates = [d for d, _ in apy_series]
    apys = np.array([a for _, a in apy_series], dtype=float)
    daily_ret = np.power(1.0 + np.maximum(apys, 0.0) / 100.0, 1.0 / 365.0) - 1.0
    nav = np.cumprod(1.0 + daily_ret)
    return ComponentSeries(key="", name="", dates=_to_np_dates(dates), nav=nav, daily_return=daily_ret)


def build_v3_vs_nav(
    symbol: str, chart: list[dict[str, Any]],
    lookback_days: int, range_width: float,
) -> ComponentSeries | None:
    toks = _parse_symbol_tokens(symbol)
    if len(toks) != 2:
        return None
    a, b = toks[0], toks[1]
    if a in STABLE_TOKENS and b not in STABLE_TOKENS:
        a, b = b, a
    if b not in STABLE_TOKENS or a in STABLE_TOKENS:
        return None

    price_map = fetch_price_series(a, lookback_days + 10)
    if price_map is None:
        return None
    apy_series = _chart_to_daily_apy(chart, lookback_days)
    if len(apy_series) < 30:
        return None

    dates_set = [d for d, _ in apy_series if d in price_map]
    if len(dates_set) < 30:
        dates_set = []
        for d, _ in apy_series:
            if d in price_map:
                dates_set.append(d)
            else:
                for off in (1, -1, 2, -2, 3, -3):
                    if (d + timedelta(days=off)) in price_map:
                        dates_set.append(d)
                        break
        if len(dates_set) < 30:
            return None

    dates, apys_aligned, prices_aligned = [], [], []
    apy_lookup = dict(apy_series)
    for d in dates_set:
        apy_v = apy_lookup.get(d)
        p = price_map.get(d)
        if p is None:
            for off in (1, -1, 2, -2):
                p = price_map.get(d + timedelta(days=off))
                if p is not None:
                    break
        if apy_v is None or p is None:
            continue
        dates.append(d)
        apys_aligned.append(float(apy_v))
        prices_aligned.append(float(p))
    if len(dates) < 30:
        return None

    prices = np.array(prices_aligned, dtype=float)
    apys = np.array(apys_aligned, dtype=float)
    p0 = prices[0]
    pa = p0 * (1.0 - range_width)
    pb = p0 * (1.0 + range_width)
    C = 1.0 / (1.0 - math.sqrt(pa / pb))

    v_lp = np.array([_v3_position_value(p, pa, pb, p0) for p in prices], dtype=float)
    in_range = (prices >= pa) & (prices <= pb)
    fee_daily = np.where(
        in_range,
        np.power(1.0 + np.maximum(apys, 0.0) / 100.0 * C, 1.0 / 365.0) - 1.0,
        0.0,
    )
    cum_fee = np.cumprod(1.0 + fee_daily)
    nav = v_lp * cum_fee
    nav = nav / nav[0]
    daily_ret = np.zeros_like(nav)
    daily_ret[1:] = nav[1:] / nav[:-1] - 1.0
    return ComponentSeries(key="", name="", dates=_to_np_dates(dates), nav=nav, daily_return=daily_ret)


def build_cp_vv_nav(symbol: str, chart: list[dict[str, Any]], lookback_days: int) -> ComponentSeries | None:
    toks = _parse_symbol_tokens(symbol)
    if len(toks) != 2:
        return None
    a, b = toks[0], toks[1]
    price_a = fetch_price_series(a, lookback_days + 10)
    price_b = fetch_price_series(b, lookback_days + 10)
    if price_a is None or price_b is None:
        return None
    apy_series = _chart_to_daily_apy(chart, lookback_days)
    if len(apy_series) < 30:
        return None

    dates: list[datetime] = []
    apys_aligned: list[float] = []
    pa_list: list[float] = []
    pb_list: list[float] = []
    for d, apy_v in apy_series:
        pa = price_a.get(d)
        pb = price_b.get(d)
        if pa is None or pb is None:
            for off in (1, -1, 2, -2):
                pa = pa if pa is not None else price_a.get(d + timedelta(days=off))
                pb = pb if pb is not None else price_b.get(d + timedelta(days=off))
                if pa is not None and pb is not None:
                    break
        if pa is None or pb is None:
            continue
        dates.append(d)
        apys_aligned.append(float(apy_v))
        pa_list.append(float(pa))
        pb_list.append(float(pb))
    if len(dates) < 30:
        return None

    prices_a = np.array(pa_list)
    prices_b = np.array(pb_list)
    apys = np.array(apys_aligned, dtype=float)
    r_a = prices_a / prices_a[0]
    r_b = prices_b / prices_b[0]
    v_lp = np.sqrt(r_a * r_b)
    daily = np.power(1.0 + np.maximum(apys, 0.0) / 100.0, 1.0 / 365.0) - 1.0
    cum_fee = np.cumprod(1.0 + daily)
    nav = v_lp * cum_fee
    nav = nav / nav[0]
    daily_ret = np.zeros_like(nav)
    daily_ret[1:] = nav[1:] / nav[:-1] - 1.0
    return ComponentSeries(key="", name="", dates=_to_np_dates(dates), nav=nav, daily_return=daily_ret)


# ===========================================================================
# 9. 성과 지표 & 포트폴리오 결합
# ===========================================================================

@dataclass
class PerfMetrics:
    cagr_pct: float
    ann_vol_pct: float
    sharpe: float
    max_dd_pct: float
    calmar: float
    n_days: int
    total_return_pct: float


def compute_metrics(nav: np.ndarray, risk_free: float = 0.0) -> PerfMetrics:
    n = len(nav)
    if n < 2:
        return PerfMetrics(0, 0, 0, 0, 0, n, 0)
    total_ret = nav[-1] / nav[0] - 1.0
    years = n / 365.0
    cagr = (nav[-1] / nav[0]) ** (1.0 / max(years, 1e-9)) - 1.0

    daily_ret = np.zeros(n)
    daily_ret[1:] = nav[1:] / nav[:-1] - 1.0
    ann_vol = float(np.std(daily_ret, ddof=1) * math.sqrt(365))
    sharpe = ((cagr - risk_free) / ann_vol) if ann_vol > 1e-9 else 0.0

    running_max = np.maximum.accumulate(nav)
    drawdown = nav / running_max - 1.0
    max_dd = float(drawdown.min())
    calmar = (cagr / abs(max_dd)) if max_dd < -1e-9 else 0.0

    return PerfMetrics(
        cagr_pct=cagr * 100.0, ann_vol_pct=ann_vol * 100.0,
        sharpe=sharpe, max_dd_pct=max_dd * 100.0, calmar=calmar,
        n_days=n, total_return_pct=total_ret * 100.0,
    )


def align_components(components: dict[str, ComponentSeries]) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    common: set | None = None
    for cs in components.values():
        s = {str(d) for d in cs.dates}
        common = s if common is None else common & s
    if not common:
        raise RuntimeError("공통 날짜가 없습니다.")
    sorted_days = sorted(common)
    common_dates = np.array(sorted_days, dtype="datetime64[D]")

    navs: dict[str, np.ndarray] = {}
    for key, cs in components.items():
        idx_map = {str(d): i for i, d in enumerate(cs.dates)}
        idx = np.array([idx_map[s] for s in sorted_days])
        nav = cs.nav[idx]
        nav = nav / nav[0]
        navs[key] = nav
    return common_dates, navs


def portfolio_nav(weights: dict[str, float], navs: dict[str, np.ndarray], cash_key: str = "CASH") -> np.ndarray:
    valid_w_sum = sum(max(w, 0.0) for k, w in weights.items() if k in navs)
    cash_w = max(0.0, 1.0 - valid_w_sum)
    n = len(next(iter(navs.values())))
    port = np.zeros(n)
    for k, w in weights.items():
        if w <= 0 or k not in navs:
            continue
        port += w * navs[k]
    port += cash_w * 1.0
    return port


def portfolio_nav_rebalanced(
    weights: dict[str, float],
    navs: dict[str, np.ndarray],
    dates: np.ndarray,
    rebalance: str = "none",
    rebalance_cost_bps: float = 30.0,
) -> tuple[np.ndarray, int]:
    keys = [k for k in weights if k in navs and weights[k] > 0]
    nav_mat = np.stack([navs[k] for k in keys], axis=1)
    T = nav_mat.shape[0]
    if T < 2:
        return np.array([1.0]), 0

    valid_sum = sum(weights[k] for k in keys)
    cash_w = max(0.0, 1.0 - valid_sum)

    ret = np.zeros_like(nav_mat)
    ret[1:] = nav_mat[1:] / nav_mat[:-1] - 1.0

    holdings = np.array([weights[k] for k in keys], dtype=float)
    cash = cash_w
    port_nav = np.zeros(T)
    port_nav[0] = holdings.sum() + cash

    rebal_days = set()
    if rebalance != "none":
        for i in range(1, T):
            d_prev = dates[i - 1].astype("datetime64[M]")
            d_cur = dates[i].astype("datetime64[M]")
            if rebalance == "monthly" and d_prev != d_cur:
                rebal_days.add(i)
            elif rebalance == "quarterly":
                m_prev = int(str(dates[i - 1])[5:7])
                m_cur = int(str(dates[i])[5:7])
                if d_prev != d_cur and (m_cur - 1) % 3 == 0:
                    rebal_days.add(i)

    cost = rebalance_cost_bps / 10000.0
    n_rebal = 0
    for t in range(1, T):
        holdings *= (1.0 + ret[t])
        V = holdings.sum() + cash
        if t in rebal_days:
            target_hold = np.array([weights[k] * V for k in keys], dtype=float)
            target_cash = cash_w * V
            turnover = np.abs(holdings - target_hold).sum() + abs(cash - target_cash)
            fee = 0.5 * turnover * cost
            V_net = V - fee
            holdings = np.array([weights[k] * V_net for k in keys], dtype=float)
            cash = cash_w * V_net
            n_rebal += 1
            port_nav[t] = V_net
        else:
            port_nav[t] = V
    return port_nav, n_rebal


# ===========================================================================
# 10. Monte Carlo 최소분산 최적화
# ===========================================================================

def _random_weights(
    n: int, n_samples: int, min_core: float, max_lp: float,
    core_idx: list[int], lp_idx: list[int], rng: np.random.Generator,
) -> np.ndarray:
    raw = rng.dirichlet(alpha=np.ones(n + 1), size=n_samples)
    w = raw[:, :n]
    core_sum = w[:, core_idx].sum(axis=1) if core_idx else np.ones(n_samples)
    lp_sum = w[:, lp_idx].sum(axis=1) if lp_idx else np.zeros(n_samples)
    mask = (core_sum >= min_core) & (lp_sum <= max_lp)
    return w[mask]


def monte_carlo_frontier(
    keys: list[str], navs: dict[str, np.ndarray],
    target_cagr: float, min_core: float, max_lp: float,
    core_keys: set[str], lp_keys: set[str],
    n_samples: int = 20000, seed: int = 42,
) -> tuple[list[dict[str, float]], list[PerfMetrics]]:
    rng = np.random.default_rng(seed)
    n = len(keys)
    core_idx = [i for i, k in enumerate(keys) if k in core_keys]
    lp_idx = [i for i, k in enumerate(keys) if k in lp_keys]
    W = _random_weights(n, n_samples, min_core, max_lp, core_idx, lp_idx, rng)
    if len(W) == 0:
        return [], []

    nav_mat = np.stack([navs[k] for k in keys], axis=1)
    n_days = nav_mat.shape[0]
    ones_T = np.ones(n_days)

    port = W @ nav_mat.T + (1.0 - W.sum(axis=1))[:, None] * ones_T[None, :]

    cagr = (port[:, -1] / port[:, 0]) ** (365.0 / n_days) - 1.0
    daily_ret = np.zeros_like(port)
    daily_ret[:, 1:] = port[:, 1:] / port[:, :-1] - 1.0
    ann_vol = daily_ret.std(axis=1, ddof=1) * math.sqrt(365)
    running_max = np.maximum.accumulate(port, axis=1)
    dd = port / running_max - 1.0
    max_dd = dd.min(axis=1)
    sharpe = np.where(ann_vol > 1e-9, cagr / ann_vol, 0.0)
    calmar = np.where(np.abs(max_dd) > 1e-9, cagr / np.abs(max_dd), 0.0)

    ok = cagr >= target_cagr
    if not ok.any():
        print(f"  [경고] 목표 CAGR {target_cagr*100:.1f}% 만족 표본 없음. 상위 5% 로 완화.")
        ok = cagr >= np.quantile(cagr, 0.95)

    idx_ok = np.where(ok)[0]
    order = idx_ok[np.argsort(ann_vol[idx_ok])][:5]
    ports = []
    metrics = []
    for i in order:
        wdict = {keys[j]: float(W[i, j]) for j in range(n)}
        wdict["CASH"] = float(max(0.0, 1.0 - W[i].sum()))
        ports.append(wdict)
        metrics.append(PerfMetrics(
            cagr_pct=float(cagr[i] * 100), ann_vol_pct=float(ann_vol[i] * 100),
            sharpe=float(sharpe[i]), max_dd_pct=float(max_dd[i] * 100),
            calmar=float(calmar[i]), n_days=n_days,
            total_return_pct=float((port[i, -1] / port[i, 0] - 1) * 100),
        ))
    return ports, metrics


# ===========================================================================
# 11. 전략 정의 (L1 / L2)
# ===========================================================================

COMPONENTS_L1: list[dict[str, Any]] = [
    {"key": "A", "name": "Aave V3 USDC (L1)",        "type": "lending",   "target_label": "Aave V3 / USDC supply"},
    {"key": "B", "name": "Curve FRAX-USDC (L1)",     "type": "stable_lp", "target_label": "Curve / FRAX-USDC"},
    {"key": "C", "name": "Orca USDC-USDT (SOL)",     "type": "stable_lp", "target_label": "Orca / USDC-USDT"},
    {"key": "D", "name": "Uniswap V3 USDC-USDT (L1)","type": "stable_lp", "target_label": "Uniswap V3 / USDC-USDT (0.01%)"},
    {"key": "E", "name": "Uniswap V3 ETH-USDC ±50% (L1)", "type": "v3_vs", "target_label": "Uniswap V3 / ETH-USDC (0.05%)", "range": 0.50},
    {"key": "F", "name": "Orca SOL-USDC ±50% (SOL)", "type": "v3_vs",     "target_label": "Orca / SOL-USDC", "range": 0.50},
]

COMPONENTS_L2: list[dict[str, Any]] = [
    {"key": "A", "name": "Aave V3 USDC (Arbitrum)",  "type": "lending",   "target_label": "Aave V3 Arbitrum / USDC"},
    {"key": "B", "name": "Aave V3 USDC (Base)",      "type": "lending",   "target_label": "Aave V3 Base / USDC"},
    {"key": "C", "name": "Orca USDC-USDT (SOL)",     "type": "stable_lp", "target_label": "Orca / USDC-USDT"},
    {"key": "D", "name": "Uniswap V3 USDC-USDT (Arb)","type":"stable_lp", "target_label": "Uniswap V3 Arbitrum / USDC-USDT"},
    {"key": "E", "name": "Uniswap V3 ETH-USDC ±50% (Arb)", "type": "v3_vs", "target_label": "Uniswap V3 Arbitrum / ETH-USDC (0.05%)", "range": 0.50},
    {"key": "F", "name": "Uniswap V3 ETH-USDC ±50% (Base)","type": "v3_vs", "target_label": "Uniswap V3 Base / ETH-USDC (0.05%)",     "range": 0.50},
]

STRATEGIES: dict[str, list[dict[str, Any]]] = {"l1": COMPONENTS_L1, "l2": COMPONENTS_L2}

DEFAULT_WEIGHTS_BY_STRATEGY: dict[str, dict[str, float]] = {
    "l1": {"A": 0.30, "B": 0.05, "C": 0.48, "D": 0.00, "E": 0.14, "F": 0.00},
    "l2": {"A": 0.25, "B": 0.20, "C": 0.30, "D": 0.10, "E": 0.10, "F": 0.05},
}


# ===========================================================================
# 12. 출력 유틸
# ===========================================================================

def print_table(rows: Iterable[list[Any]], header: list[str]) -> None:
    rows = list(rows)
    cols = list(zip(*([header] + rows)))
    widths = [max(len(str(c)) for c in col) for col in cols]

    def fmt(vals: list[Any]) -> str:
        return " | ".join(str(v).ljust(w) for v, w in zip(vals, widths))

    sep = "-+-".join("-" * w for w in widths)
    print(fmt(header))
    print(sep)
    for r in rows:
        print(fmt(r))


def write_csv(path: str, rows: Iterable[list[Any]], header: list[str]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        for r in rows:
            w.writerow(r)


HISTORY_HEADER = [
    "date", "pool_id", "label", "project", "chain", "symbol",
    "apy_pct", "apy_base_pct", "apy_reward_pct", "tvl_usd_snapshot",
]


def _parse_chart_ts(row: dict[str, Any]) -> datetime | None:
    ts_raw = row.get("timestamp")
    if ts_raw is None:
        return None
    try:
        if isinstance(ts_raw, (int, float)):
            return datetime.fromtimestamp(float(ts_raw), tz=timezone.utc)
        return datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        return None


def iter_apy_history_rows(
    charts_by_label: dict[str, tuple[dict[str, Any], list[dict[str, Any]]]],
    lookback_days: int,
) -> list[list[Any]]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    rows: list[list[Any]] = []
    for label, (pool, chart) in charts_by_label.items():
        pid = str(pool.get("pool") or "")
        project = str(pool.get("project") or "")
        chain = str(pool.get("chain") or "")
        symbol = str(pool.get("symbol") or "")
        tvl = float(pool.get("tvlUsd") or 0)
        for row in chart:
            ts = _parse_chart_ts(row)
            if ts is None or ts < cutoff:
                continue
            apy = row.get("apy")
            if apy is None:
                continue
            try:
                apy_v = float(apy)
            except (TypeError, ValueError):
                continue
            day = ts.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
            ab = row.get("apyBase")
            ar = row.get("apyReward")
            try:
                ab_v = float(ab) if ab is not None else ""
            except (TypeError, ValueError):
                ab_v = ""
            try:
                ar_v = float(ar) if ar is not None else ""
            except (TypeError, ValueError):
                ar_v = ""
            rows.append([
                day.strftime("%Y-%m-%d"), pid, label, project, chain, symbol,
                f"{apy_v:.6f}", ab_v if ab_v == "" else f"{float(ab_v):.6f}",
                ar_v if ar_v == "" else f"{float(ar_v):.6f}",
                f"{tvl:.2f}",
            ])
    rows.sort(key=lambda r: (r[3], r[2], r[0]))
    return rows


def write_apy_history_exports(
    charts_by_label: dict[str, tuple[dict[str, Any], list[dict[str, Any]]]],
    lookback_days: int,
    history_csv: str | None,
    history_by_project_dir: str | None,
) -> None:
    hc = (history_csv or "").strip() or None
    hd = (history_by_project_dir or "").strip() or None
    if not hc and not hd:
        return
    all_rows = iter_apy_history_rows(charts_by_label, lookback_days)
    if hc:
        p = Path(hc)
        p.parent.mkdir(parents=True, exist_ok=True)
        write_csv(str(p), all_rows, HISTORY_HEADER)
        print(f"\n  일별 APY 히스토리 CSV: {p}  ({len(all_rows):,}행)")
    if hd:
        d = Path(hd)
        d.mkdir(parents=True, exist_ok=True)
        by_proj: dict[str, list[list[Any]]] = {}
        for r in all_rows:
            proj = r[3] or "unknown"
            by_proj.setdefault(proj, []).append(r)
        for proj, pr in by_proj.items():
            safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in proj)
            out = d / f"{safe}_apy_daily.csv"
            write_csv(str(out), pr, HISTORY_HEADER)
            print(f"    프로젝트별: {out}  ({len(pr):,}행)")
        meta = {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "lookback_days": lookback_days,
            "source_chart": CHART_URL.replace("{pool_id}", "<pool_id>"),
            "pools": len(charts_by_label),
            "rows_total": len(all_rows),
        }
        meta_path = d / "run_meta.json"
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"    메타: {meta_path}")


def _fmt_weights(w: dict[str, float], keys_order: list[str]) -> str:
    parts = [f"{k}={w.get(k, 0)*100:.1f}%" for k in keys_order]
    parts.append(f"CASH={w.get('CASH', 0)*100:.1f}%")
    return "  ".join(parts)


# ===========================================================================
# 13. 파이프라인: 풀 분석
# ===========================================================================

def run_pools_analysis(
    catalog: list[dict[str, Any]],
    days: int, sleep: float,
    do_il: bool, do_range_sim: bool,
    widths: list[float],
    plot_dir: str | None, roll_window: int,
    csv_path: str | None,
    history_csv: str | None,
    history_by_project_dir: str | None,
) -> dict[str, tuple[dict[str, Any], list[dict[str, Any]]]]:
    """풀 통계 + IL + range-sim + rolling 플롯. 반환: label -> (pool_meta, chart)"""
    print(f"\n[풀 분석] 대상 타겟 {len(TARGETS)}개, 최근 {days}일")
    matched: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for tgt in TARGETS:
        p = find_pool(catalog, tgt)
        if p is None:
            print(f"    [경고] 매칭 실패: {tgt['label']}")
            continue
        matched.append((tgt, p))
        print(f"    OK  {tgt['label']:<40s} -> pool={p.get('pool')}  sym={p.get('symbol')}  tvl=${(p.get('tvlUsd') or 0):,.0f}")

    print(f"\n  풀별 일별 APY 시계열 수집 중 ...")
    results: list[PoolStats] = []
    charts_by_label: dict[str, tuple[dict[str, Any], list[dict[str, Any]]]] = {}
    for tgt, pool in matched:
        pid = str(pool.get("pool"))
        try:
            chart = fetch_pool_chart(pid)
        except Exception as exc:  # noqa: BLE001
            print(f"    [경고] {tgt['label']} 시계열 실패: {exc}")
            continue
        stat = summarize(tgt["label"], pool, chart, lookback_days=days)
        if stat is None:
            print(f"    [경고] {tgt['label']} 유효 샘플 없음")
            continue
        results.append(stat)
        charts_by_label[tgt["label"]] = (pool, chart)
        time.sleep(sleep)

    if not results:
        print("수집된 결과가 없습니다.")
        return charts_by_label

    print(f"\n  [요약] APY 단위 %")
    rows = [s.as_row() for s in results]
    print_table(rows, POOLSTAT_HEADER)

    print("\n  [프로젝트별 평균 APY (%)]")
    groups: dict[str, list[float]] = {}
    for s in results:
        groups.setdefault(s.project, []).append(s.mean_apy)
    for proj, vals in sorted(groups.items()):
        print(f"    {proj:<25s} n={len(vals)}  mean={statistics.fmean(vals):.2f}  median={statistics.median(vals):.2f}")

    if csv_path:
        write_csv(csv_path, rows, POOLSTAT_HEADER)
        print(f"\n  CSV 저장: {csv_path}")

    if do_il:
        print(f"\n  [IL 보정] 최근 {days}일, 2-토큰 페어만")
        il_header = [
            "label", "tokenA-B", "n_days",
            "LP_only%", "HOLD%", "IL%",
            "cum_fee%", "LP_w/_fees%", "net_vs_HOLD%", "ann_net%",
        ]
        il_rows: list[list[Any]] = []
        for s in results:
            pm = charts_by_label.get(s.label)
            if pm is None:
                continue
            ilr = compute_il_adjusted_return(s.label, s.symbol, pm[1], days)
            if ilr is None:
                continue
            il_rows.append([
                s.label, f"{ilr.token_a}-{ilr.token_b}", ilr.n_days,
                f"{(ilr.lp_value_ratio - 1) * 100:+.2f}",
                f"{(ilr.hold_value_ratio - 1) * 100:+.2f}",
                f"{ilr.il_pct:.2f}", f"{ilr.cum_fee_return_pct:.2f}",
                f"{(ilr.lp_with_fees_ratio - 1) * 100:+.2f}",
                f"{ilr.net_vs_hold_pct:+.2f}", f"{ilr.annualized_net_pct:+.2f}",
            ])
        if il_rows:
            print_table(il_rows, il_header)
        else:
            print("    (2-토큰 가격 시계열 매핑 가능한 풀 없음)")

    if do_range_sim:
        print(f"\n  [V3 범위 시뮬] volatile-stable, widths={widths}")
        rs_header = [
            "label", "width±%", "C", "TIR%",
            "pool_mean_APY%", "eff_fee_APR%",
            "IL_end%", "net_return%",
        ]
        rs_rows: list[list[Any]] = []
        for s in results:
            pm = charts_by_label.get(s.label)
            if pm is None:
                continue
            sims = simulate_v3_ranges(s.label, s.symbol, pm[1], days, widths)
            for r in sims:
                rs_rows.append([
                    r.label, f"{r.width_pct:.0f}", f"{r.concentration:.2f}",
                    f"{r.time_in_range_pct:.1f}", f"{r.mean_apy_in_range:.2f}",
                    f"{r.effective_fee_apr_pct:.2f}", f"{r.il_at_end_pct:+.2f}",
                    f"{r.net_return_pct:+.2f}",
                ])
        if rs_rows:
            print_table(rs_rows, rs_header)
        else:
            print("    (volatile-stable 2-토큰 페어 대상 없음)")

    if plot_dir:
        print(f"\n  [플롯] rolling APY {roll_window}d 윈도우 -> {plot_dir}")
        try:
            plot_rolling(
                [(s, charts_by_label[s.label][1]) for s in results if s.label in charts_by_label],
                out_dir=plot_dir, lookback_days=days, window=roll_window,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"    [경고] 플롯 실패: {exc}")

    if charts_by_label and (history_csv or history_by_project_dir):
        write_apy_history_exports(
            charts_by_label, days, history_csv, history_by_project_dir,
        )

    return charts_by_label


# ===========================================================================
# 14. 파이프라인: 포트폴리오 백테스트 (L1 또는 L2)
# ===========================================================================

def run_portfolio_backtest(
    strategy: str,
    catalog: list[dict[str, Any]],
    days: int, target_cagr: float,
    min_core: float, max_lp: float,
    mc: int, rebal: str, rebal_cost_bps: float,
    plot_dir: str | None, risk_free: float,
    charts_cache: dict[str, tuple[dict[str, Any], list[dict[str, Any]]]] | None = None,
    sleep: float = 0.25,
) -> None:
    strategy_components = STRATEGIES[strategy]
    strategy_weights = DEFAULT_WEIGHTS_BY_STRATEGY[strategy]
    print(f"\n[포트폴리오: {strategy.upper()}] 리밸런싱={rebal}  거래비용={rebal_cost_bps:.1f}bp")

    target_by_label = {t["label"]: t for t in TARGETS}
    charts_cache = charts_cache if charts_cache is not None else {}

    components: dict[str, ComponentSeries] = {}
    for comp in strategy_components:
        tgt = target_by_label.get(comp["target_label"])
        if tgt is None:
            print(f"  [경고] {comp['name']}: 타겟 정의 없음")
            continue

        if comp["target_label"] in charts_cache:
            pool, chart = charts_cache[comp["target_label"]]
        else:
            pool = find_pool(catalog, tgt)
            if pool is None:
                print(f"  [경고] {comp['name']}: 풀 매칭 실패")
                continue
            chart = fetch_pool_chart(str(pool["pool"]))
            charts_cache[comp["target_label"]] = (pool, chart)
            time.sleep(sleep)

        symbol = str(pool.get("symbol") or "")
        if comp["type"] in ("lending", "stable_lp"):
            cs = build_stable_nav(chart, days)
        elif comp["type"] == "v3_vs":
            cs = build_v3_vs_nav(symbol, chart, days, comp.get("range", 0.50))
        elif comp["type"] == "cp_vv":
            cs = build_cp_vv_nav(symbol, chart, days)
        else:
            cs = None
        if cs is None:
            print(f"  [경고] {comp['name']}: NAV 시계열 생성 실패")
            continue
        cs.key = comp["key"]
        cs.name = comp["name"]
        components[comp["key"]] = cs
        print(f"  OK {comp['key']} {comp['name']:<32s} n_days={len(cs.nav)}  pool={pool['pool']}")

    if len(components) < 3:
        print("  충분한 구성요소가 수집되지 않았습니다.")
        return

    dates, navs = align_components(components)
    print(f"  공통 날짜 {len(dates)}일 ({dates[0]} ~ {dates[-1]})")

    print("\n  [개별 구성요소 성과]")
    header = ["key", "name", "CAGR%", "vol%", "Sharpe", "MaxDD%", "Calmar"]
    print("    " + "  ".join(f"{h:>10s}" for h in header))
    for k, cs in components.items():
        m = compute_metrics(navs[k], risk_free=risk_free)
        print(f"    {k:>10s}  {cs.name[:28]:>10s}  "
              f"{m.cagr_pct:>9.2f}%  {m.ann_vol_pct:>8.2f}%  {m.sharpe:>6.2f}  "
              f"{m.max_dd_pct:>+7.2f}%  {m.calmar:>6.2f}")

    print(f"\n  [{strategy.upper()} 기본 가중치 백테스트]")
    print(f"    가중치: {_fmt_weights(strategy_weights, list(components.keys()))}")
    p_bh = portfolio_nav(strategy_weights, navs)
    m_bh = compute_metrics(p_bh, risk_free=risk_free)
    print(f"    [buy&hold]      총수익 {m_bh.total_return_pct:+6.2f}%   CAGR {m_bh.cagr_pct:6.2f}%   "
          f"vol {m_bh.ann_vol_pct:5.2f}%   Sharpe {m_bh.sharpe:5.2f}   MaxDD {m_bh.max_dd_pct:+6.2f}%   "
          f"Calmar {m_bh.calmar:5.2f}")

    for rebal_mode in ("monthly", "quarterly"):
        p_rb, n_rb = portfolio_nav_rebalanced(strategy_weights, navs, dates,
                                              rebalance=rebal_mode,
                                              rebalance_cost_bps=rebal_cost_bps)
        m_rb = compute_metrics(p_rb, risk_free=risk_free)
        print(f"    [{rebal_mode:9s}]  총수익 {m_rb.total_return_pct:+6.2f}%   CAGR {m_rb.cagr_pct:6.2f}%   "
              f"vol {m_rb.ann_vol_pct:5.2f}%   Sharpe {m_rb.sharpe:5.2f}   MaxDD {m_rb.max_dd_pct:+6.2f}%   "
              f"Calmar {m_rb.calmar:5.2f}   n_rebal={n_rb}")

    if rebal == "none":
        p_nav = p_bh
    else:
        p_nav, _ = portfolio_nav_rebalanced(strategy_weights, navs, dates,
                                            rebalance=rebal, rebalance_cost_bps=rebal_cost_bps)

    print(f"\n  [민감도 분석] 각 구성요소 ±10%p, 나머지 비례, 리밸={rebal}")
    print("    " + "  ".join(f"{h:>10s}" for h in ["perturb", "CAGR%", "vol%", "Sharpe", "MaxDD%", "Calmar"]))
    for k in components.keys():
        for delta in (-0.10, +0.10):
            w_new = dict(strategy_weights)
            w_new[k] = max(0.0, w_new.get(k, 0.0) + delta)
            other = {x: w_new[x] for x in w_new if x != k}
            other_sum = sum(other.values())
            cash_reserve = max(0.0, 1.0 - sum(strategy_weights.values()))
            target_other_sum = max(0.0, 1.0 - w_new[k] - cash_reserve)
            if other_sum > 0 and target_other_sum > 0:
                scale = target_other_sum / other_sum
                for x in other:
                    w_new[x] = other[x] * scale
            if rebal == "none":
                p = portfolio_nav(w_new, navs)
            else:
                p, _ = portfolio_nav_rebalanced(w_new, navs, dates,
                                                rebalance=rebal,
                                                rebalance_cost_bps=rebal_cost_bps)
            m = compute_metrics(p, risk_free=risk_free)
            sign = "+" if delta > 0 else "-"
            lbl = f"{k}{sign}{abs(delta)*100:.0f}%"
            print(f"    {lbl:>10s}  {m.cagr_pct:>9.2f}%  {m.ann_vol_pct:>8.2f}%  "
                  f"{m.sharpe:>6.2f}  {m.max_dd_pct:>+7.2f}%  {m.calmar:>6.2f}")

    print(f"\n  [최소분산 최적화] 목표 CAGR ≥ {target_cagr*100:.1f}%, "
          f"코어 ≥ {min_core*100:.0f}%, LP ≤ {max_lp*100:.0f}%, MC={mc:,}")
    core_keys = {"A", "B", "C", "D"}
    lp_keys = {"E", "F"}
    keys = list(components.keys())
    ports, metrics = monte_carlo_frontier(
        keys, navs,
        target_cagr=target_cagr, min_core=min_core, max_lp=max_lp,
        core_keys=core_keys, lp_keys=lp_keys, n_samples=mc,
    )
    if ports:
        print("    === 목표 수익 제약 하 최소변동성 Top 5 ===")
        for i, (w, m) in enumerate(zip(ports, metrics), 1):
            print(f"\n    [#{i}]  CAGR {m.cagr_pct:.2f}%   vol {m.ann_vol_pct:.2f}%   "
                  f"Sharpe {m.sharpe:.2f}   MaxDD {m.max_dd_pct:.2f}%")
            print(f"         {_fmt_weights(w, keys)}")

    if plot_dir:
        os.makedirs(plot_dir, exist_ok=True)
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, ax = plt.subplots(figsize=(11, 5.5))
        for k, cs in components.items():
            ax.plot(dates, navs[k], label=f"{k}: {cs.name}", linewidth=1.0, alpha=0.6)
        ax.plot(dates, p_bh, label="Portfolio (buy&hold)", linewidth=2.5, color="black")
        for rebal_mode, col in (("monthly", "red"), ("quarterly", "blue")):
            p_rb, _ = portfolio_nav_rebalanced(strategy_weights, navs, dates,
                                               rebalance=rebal_mode,
                                               rebalance_cost_bps=rebal_cost_bps)
            ax.plot(dates, p_rb, label=f"Portfolio ({rebal_mode})", linewidth=2.0,
                    color=col, linestyle="--", alpha=0.85)
        if ports:
            best_port = portfolio_nav(ports[0], navs)
            ax.plot(dates, best_port, label="Min-Var optimum #1", linewidth=2.0,
                    color="green", linestyle=":")
        ax.set_title(f"{strategy.upper()} DeFi portfolio NAV (last {days}d)")
        ax.set_ylabel("NAV (init=1.0)")
        ax.grid(True, alpha=0.3)
        ax.legend(loc="best", fontsize=8)
        fig.autofmt_xdate()
        out = os.path.join(plot_dir, f"portfolio_nav_{strategy}.png")
        fig.tight_layout()
        fig.savefig(out, dpi=130)
        plt.close(fig)
        print(f"\n  NAV 플롯 저장: {out}")


# ===========================================================================
# 15. HTML 리포트 템플릿 & 생성
# ===========================================================================

HTML_TEMPLATE = r"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeFi Yield Portfolio Report — 연 7~8% 안정 운용 전략</title>
<style>
  :root {
    --bg: #fafafa; --fg: #1a1a1a; --muted: #666; --accent: #1e3a8a;
    --table-border: #d0d0d0; --card: #ffffff; --code-bg: #f4f4f4;
    --pos: #16a34a; --neg: #dc2626;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", "Malgun Gothic", sans-serif;
    color: var(--fg); background: var(--bg); margin: 0; padding: 0;
    line-height: 1.6; font-size: 15px;
  }
  .container { max-width: 980px; margin: 0 auto; padding: 40px 24px 80px; }
  h1 { font-size: 28px; margin: 0 0 4px; color: var(--accent); letter-spacing: -0.01em; }
  h2 { font-size: 22px; margin: 48px 0 12px; padding-bottom: 6px; border-bottom: 2px solid var(--accent); }
  h3 { font-size: 17px; margin: 28px 0 10px; color: var(--accent); }
  h4 { font-size: 15px; margin: 20px 0 8px; color: #333; }
  .subtitle { color: var(--muted); margin: 0 0 8px; font-size: 14px; }
  .meta { color: var(--muted); font-size: 13px; border-bottom: 1px solid var(--table-border); padding-bottom: 16px; margin-bottom: 12px; }
  .tldr { background: #eff6ff; border-left: 4px solid var(--accent); padding: 16px 20px; margin: 16px 0; border-radius: 4px; }
  .tldr h3 { margin-top: 0; color: var(--accent); }
  .card { background: var(--card); border: 1px solid var(--table-border); border-radius: 8px; padding: 16px 20px; margin: 12px 0; }
  table { border-collapse: collapse; margin: 12px 0; width: 100%; font-size: 13.5px; }
  th, td { border: 1px solid var(--table-border); padding: 6px 10px; text-align: left; }
  th { background: #f0f0f0; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.highlight { background: #fef3c7; font-weight: 600; }
  .pos { color: var(--pos); font-weight: 600; }
  .neg { color: var(--neg); font-weight: 600; }
  code, pre { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 13px; }
  pre { background: var(--code-bg); padding: 12px 16px; border-radius: 6px; overflow-x: auto; line-height: 1.45; }
  code.inline { background: var(--code-bg); padding: 1px 6px; border-radius: 3px; font-size: 13px; }
  img.plot { max-width: 100%; height: auto; border: 1px solid var(--table-border); border-radius: 6px; margin: 8px 0; display: block; }
  .plot-caption { text-align: center; color: var(--muted); font-size: 13px; margin: 4px 0 24px; }
  ul, ol { padding-left: 22px; }
  li { margin: 4px 0; }
  .footer { color: var(--muted); font-size: 12px; border-top: 1px solid var(--table-border); padding-top: 16px; margin-top: 48px; }
  .toc { background: #fff; border: 1px solid var(--table-border); border-radius: 6px; padding: 12px 20px; margin: 16px 0 28px; }
  .toc a { color: var(--accent); text-decoration: none; }
  .toc a:hover { text-decoration: underline; }
  .toc ol { margin: 4px 0; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 720px) { .grid-2 { grid-template-columns: 1fr; } }
  .warn { background: #fef2f2; border-left: 4px solid var(--neg); padding: 12px 16px; margin: 12px 0; border-radius: 4px; font-size: 14px; }
  @media print {
    body { background: white; }
    .container { max-width: 100%; padding: 20px; }
    h2 { page-break-before: auto; }
  }
</style>
</head>
<body>
<div class="container">

<h1>DeFi Yield Portfolio Report</h1>
<p class="subtitle">연 7~8% 안정 운용을 위한 Ethereum / Arbitrum / Base / Solana DeFi 포트폴리오 설계 & 백테스트</p>
<p class="meta">Generated: __TIMESTAMP__  |  Source: DefiLlama Yields API + DefiLlama Coins API  |  Lookback: 365 days</p>

<div class="tldr">
<h3>TL;DR — 핵심 결론</h3>
<ul>
  <li>최근 365일 실측 데이터를 기반으로 <b>5개 DeFi 프로젝트 × 3개 풀 = 15개 풀</b>을 분석.</li>
  <li>IL(비영구손실) 보정 후 HOLD 대비 연 초과수익이 가장 컸던 풀은
      <b>Orca SOL-USDC</b> (+58.5%), <b>Uniswap V3 ETH-USDC 0.05%</b> (+19.3%).</li>
  <li>연 7~8% 안정 운용 최적해는 <b>L2(Arbitrum + Base) + Solana 혼합 전략</b>.
      실측 CAGR <b>8.3~9.1%</b>, 변동성 1.2~1.5%, MaxDD -0.3% 이내.</li>
  <li>리밸런싱 주기는 <b>분기(연 4회)</b>가 월간 대비 Sharpe 우수.</li>
  <li>실제 배포 시 L2 가스비 &lt; $1/거래, 초기 진입 비용 총 <b>$20 이하</b>.</li>
</ul>
</div>

<div class="toc">
<b>목차</b>
<ol>
  <li><a href="#s1">개별 풀 365일 실측 수익률</a></li>
  <li><a href="#s2">IL(비영구손실) 보정 수익률</a></li>
  <li><a href="#s3">Uniswap V3 집중유동성 범위 시뮬레이션</a></li>
  <li><a href="#s4">포트폴리오 백테스트: L1 vs L2</a></li>
  <li><a href="#s5">리밸런싱 주기 효과</a></li>
  <li><a href="#s6">최소분산 최적화 결과</a></li>
  <li><a href="#s7">최종 추천 포트폴리오 (Option L2*)</a></li>
  <li><a href="#s8">실제 배포 체크리스트</a></li>
  <li><a href="#s9">리스크 시나리오 & 대응</a></li>
  <li><a href="#s10">주의 & 면책</a></li>
</ol>
</div>

<h2 id="s1">1. 개별 풀 365일 실측 수익률</h2>
<p>DefiLlama Yields API 에서 5개 프로젝트 × 3개 풀 씩 총 15개를 선정하여 일별 APY 시계열 수집.</p>

<table>
<thead><tr>
<th>프로젝트</th><th>풀</th><th class="num">평균 APY</th><th class="num">중앙값</th><th class="num">표준편차</th><th class="num">최소</th><th class="num">최대</th>
</tr></thead>
<tbody>
<tr><td>Uniswap V3 (ETH)</td><td>ETH-USDC 0.05%</td><td class="num">23.48%</td><td class="num">15.30%</td><td class="num">27.51%</td><td class="num">0.00%</td><td class="num">345.15%</td></tr>
<tr><td>Uniswap V3 (ETH)</td><td>WBTC-ETH 0.3%</td><td class="num">7.91%</td><td class="num">5.34%</td><td class="num">9.40%</td><td class="num">0.00%</td><td class="num">87.34%</td></tr>
<tr><td>Uniswap V3 (ETH)</td><td>USDC-USDT 0.01%</td><td class="num">3.17%</td><td class="num">2.44%</td><td class="num">2.53%</td><td class="num">0.00%</td><td class="num">18.82%</td></tr>
<tr><td>Curve (ETH)</td><td>3pool (DAI/USDC/USDT)</td><td class="num">0.00%</td><td class="num">0.00%</td><td class="num">0.00%</td><td class="num">0.00%</td><td class="num">0.00%</td></tr>
<tr><td>Curve (ETH)</td><td>stETH-ETH</td><td class="num">1.80%</td><td class="num">1.71%</td><td class="num">0.47%</td><td class="num">1.23%</td><td class="num">4.18%</td></tr>
<tr><td>Curve (ETH)</td><td>FRAX-USDC</td><td class="num">3.94%</td><td class="num">3.97%</td><td class="num">2.86%</td><td class="num">0.15%</td><td class="num">14.62%</td></tr>
<tr><td>Aave V3 (ETH)</td><td>USDC supply</td><td class="num">3.50%</td><td class="num">3.64%</td><td class="num">0.84%</td><td class="num">1.57%</td><td class="num">6.07%</td></tr>
<tr><td>Aave V3 (ETH)</td><td>WETH supply</td><td class="num">1.82%</td><td class="num">1.80%</td><td class="num">0.59%</td><td class="num">1.05%</td><td class="num">5.75%</td></tr>
<tr><td>Aave V3 (ETH)</td><td>WBTC supply</td><td class="num">0.01%</td><td class="num">0.01%</td><td class="num">0.01%</td><td class="num">0.00%</td><td class="num">0.03%</td></tr>
<tr><td>Orca (Solana)</td><td>SOL-USDC</td><td class="num">63.30%</td><td class="num">59.33%</td><td class="num">24.77%</td><td class="num">8.50%</td><td class="num">284.58%</td></tr>
<tr><td>Orca (Solana)</td><td>mSOL-SOL</td><td class="num">2.52%</td><td class="num">3.44%</td><td class="num">2.61%</td><td class="num">0.00%</td><td class="num">43.11%</td></tr>
<tr><td>Orca (Solana)</td><td>USDC-USDT</td><td class="num">4.57%</td><td class="num">5.49%</td><td class="num">2.08%</td><td class="num">0.09%</td><td class="num">21.30%</td></tr>
<tr><td>Raydium (Solana)</td><td>SOL-USDC</td><td class="num">27.21%</td><td class="num">15.25%</td><td class="num">60.22%</td><td class="num">2.48%</td><td class="num">660.31%</td></tr>
<tr><td>Raydium (Solana)</td><td>BOME-SOL</td><td class="num">11.32%</td><td class="num">5.44%</td><td class="num">13.08%</td><td class="num">1.22%</td><td class="num">87.48%</td></tr>
<tr><td>Raydium (Solana)</td><td>MEW-SOL</td><td class="num">9.13%</td><td class="num">4.27%</td><td class="num">12.01%</td><td class="num">0.82%</td><td class="num">91.90%</td></tr>
</tbody>
</table>

<h3>프로젝트별 30d Rolling APY 시계열</h3>
<div class="grid-2">
<div><img class="plot" src="__PLOT_UNISWAP__" alt="Uniswap V3 rolling APY"><div class="plot-caption">Uniswap V3 (Ethereum) 30d rolling APY</div></div>
<div><img class="plot" src="__PLOT_CURVE__" alt="Curve rolling APY"><div class="plot-caption">Curve (Ethereum) 30d rolling APY</div></div>
<div><img class="plot" src="__PLOT_AAVE__" alt="Aave rolling APY"><div class="plot-caption">Aave V3 supply APY</div></div>
<div><img class="plot" src="__PLOT_ORCA__" alt="Orca rolling APY"><div class="plot-caption">Orca (Solana) rolling APY</div></div>
</div>
<img class="plot" src="__PLOT_RAYDIUM__" alt="Raydium rolling APY">
<div class="plot-caption">Raydium (Solana) rolling APY</div>

<h2 id="s2">2. IL(비영구손실) 보정 수익률</h2>
<p>DefiLlama Coins API 로 각 토큰의 일별 USD 가격을 받아 constant-product AMM 공식
  <code class="inline">V_LP/V_0 = √(r_a · r_b)</code> 로 LP 포지션의 가격 변동만을 계산하고,
  여기에 수수료 누적을 곱해 HOLD 대비 초과수익을 산출.</p>

<table>
<thead><tr>
<th>풀</th><th>토큰</th><th class="num">LP 가격 변동</th><th class="num">HOLD 변동</th><th class="num">IL</th><th class="num">누적 수수료</th><th class="num">LP+fees</th><th class="num">HOLD 대비 초과</th><th class="num">연율화</th>
</tr></thead>
<tbody>
<tr><td>Uniswap V3 ETH-USDC 0.05%</td><td>USDC-WETH</td><td class="num pos">+21.44%</td><td class="num pos">+23.74%</td><td class="num">1.86%</td><td class="num">21.51%</td><td class="num pos">+47.56%</td><td class="num pos">+19.25%</td><td class="num pos">+19.31%</td></tr>
<tr><td>Uniswap V3 WBTC-ETH 0.3%</td><td>WBTC-WETH</td><td class="num pos">+14.07%</td><td class="num pos">+17.85%</td><td class="num">3.21%</td><td class="num">7.56%</td><td class="num pos">+22.69%</td><td class="num pos">+4.10%</td><td class="num pos">+4.11%</td></tr>
<tr><td>Uniswap V3 USDC-USDT 0.01%</td><td>USDC-USDT</td><td class="num">0.00%</td><td class="num">0.00%</td><td class="num">0.00%</td><td class="num">3.14%</td><td class="num pos">+3.14%</td><td class="num pos">+3.14%</td><td class="num pos">+3.15%</td></tr>
<tr><td>Curve stETH-ETH</td><td>ETH-STETH</td><td class="num pos">+47.44%</td><td class="num pos">+47.44%</td><td class="num">0.00%</td><td class="num">1.78%</td><td class="num pos">+50.07%</td><td class="num pos">+1.78%</td><td class="num pos">+1.79%</td></tr>
<tr><td>Curve FRAX-USDC</td><td>FRAX-USDC</td><td class="num">0.00%</td><td class="num">0.00%</td><td class="num">0.00%</td><td class="num">3.88%</td><td class="num pos">+3.88%</td><td class="num pos">+3.88%</td><td class="num pos">+3.89%</td></tr>
<tr class="highlight"><td>Orca SOL-USDC</td><td>SOL-USDC</td><td class="num neg">-18.90%</td><td class="num neg">-17.11%</td><td class="num">2.15%</td><td class="num">61.77%</td><td class="num pos">+31.20%</td><td class="num pos">+58.29%</td><td class="num pos">+58.49%</td></tr>
<tr><td>Orca mSOL-SOL</td><td>SOL-MSOL</td><td class="num neg">-32.24%</td><td class="num neg">-32.21%</td><td class="num">0.04%</td><td class="num">2.49%</td><td class="num neg">-30.55%</td><td class="num pos">+2.44%</td><td class="num pos">+2.45%</td></tr>
<tr><td>Orca USDC-USDT</td><td>USDC-USDT</td><td class="num">0.00%</td><td class="num">0.00%</td><td class="num">0.00%</td><td class="num">4.54%</td><td class="num pos">+4.54%</td><td class="num pos">+4.54%</td><td class="num pos">+4.56%</td></tr>
<tr><td>Raydium WSOL-USDC</td><td>WSOL-USDC</td><td class="num neg">-18.90%</td><td class="num neg">-17.11%</td><td class="num">2.15%</td><td class="num">22.15%</td><td class="num neg">-0.93%</td><td class="num pos">+19.52%</td><td class="num pos">+19.57%</td></tr>
<tr><td>Raydium BOME-WSOL</td><td>BOME-WSOL</td><td class="num neg">-43.92%</td><td class="num neg">-43.20%</td><td class="num">1.26%</td><td class="num">10.58%</td><td class="num neg">-37.98%</td><td class="num pos">+9.19%</td><td class="num pos">+9.22%</td></tr>
<tr><td>Raydium MEW-WSOL</td><td>MEW-WSOL</td><td class="num neg">-57.26%</td><td class="num neg">-53.22%</td><td class="num">8.62%</td><td class="num">8.49%</td><td class="num neg">-53.63%</td><td class="num neg">-0.87%</td><td class="num neg">-0.87%</td></tr>
</tbody>
</table>

<div class="card">
<h4>핵심 인사이트</h4>
<ul>
  <li><b>Orca SOL-USDC</b>: SOL -34% 하락에도 수수료 수익 +61.8% 로 HOLD 대비 연 +58% 초과수익 — 하락장에서 LP의 헤징 효과 실증.</li>
  <li><b>Raydium 밈코인 풀(MEW/BOME)</b>: HOLD 대비 초과수익은 +9% 이지만 <b>절대 수익 -38~-54%</b>. 기초자산 폭락에 잠식됨.</li>
  <li><b>Uniswap V3 ETH-USDC</b>: IL 1.86% 에 불과하고 수수료 수익이 압도 → 연 <b>+19% 순초과수익</b>.</li>
</ul>
</div>

<h2 id="s3">3. Uniswap V3 집중유동성 범위 시뮬레이션</h2>
<p>volatile-stable 페어(ETH-USDC, SOL-USDC)에 대해 진입시점 ±폭% 의 고정 범위로
  포지션을 잡았을 때 time-in-range, 농도 부스트, IL, 순수익을 시뮬.</p>

<table>
<thead><tr>
<th>풀</th><th class="num">범위 ±%</th><th class="num">농도 C</th><th class="num">TIR%</th><th class="num">풀 평균 APY</th><th class="num">실효 수수료 APR</th><th class="num">만기 IL</th><th class="num">순수익</th>
</tr></thead>
<tbody>
<tr><td>Uniswap V3 ETH-USDC</td><td class="num">5%</td><td class="num">20.49</td><td class="num">1.4%</td><td class="num">23.49%</td><td class="num">6.59%</td><td class="num pos">+18.21%</td><td class="num pos">+3.44%</td></tr>
<tr><td>Uniswap V3 ETH-USDC</td><td class="num">10%</td><td class="num">10.47</td><td class="num">1.4%</td><td class="num">23.49%</td><td class="num">3.37%</td><td class="num pos">+17.31%</td><td class="num pos">+3.88%</td></tr>
<tr><td>Uniswap V3 ETH-USDC</td><td class="num">20%</td><td class="num">5.45</td><td class="num">6.0%</td><td class="num">23.49%</td><td class="num">7.71%</td><td class="num pos">+15.70%</td><td class="num pos">+9.07%</td></tr>
<tr class="highlight"><td>Uniswap V3 ETH-USDC</td><td class="num">50%</td><td class="num">2.37</td><td class="num">27.4%</td><td class="num">23.49%</td><td class="num">15.23%</td><td class="num pos">+12.20%</td><td class="num pos">+29.33%</td></tr>
<tr><td>Orca SOL-USDC</td><td class="num">5%</td><td class="num">20.49</td><td class="num">13.2%</td><td class="num">63.31%</td><td class="num">170.58%</td><td class="num pos">+19.59%</td><td class="num neg">-7.27%</td></tr>
<tr><td>Orca SOL-USDC</td><td class="num">10%</td><td class="num">10.47</td><td class="num">27.9%</td><td class="num">63.31%</td><td class="num">185.33%</td><td class="num pos">+18.39%</td><td class="num pos">+14.07%</td></tr>
<tr><td>Orca SOL-USDC</td><td class="num">20%</td><td class="num">5.45</td><td class="num">40.3%</td><td class="num">63.31%</td><td class="num">138.95%</td><td class="num pos">+15.51%</td><td class="num pos">+22.54%</td></tr>
<tr class="highlight"><td>Orca SOL-USDC</td><td class="num">50%</td><td class="num">2.37</td><td class="num">85.8%</td><td class="num">63.31%</td><td class="num">128.46%</td><td class="num pos">+4.30%</td><td class="num pos">+71.09%</td></tr>
</tbody>
</table>

<div class="card">
<h4>범위 설정 교훈</h4>
<ul>
  <li>좁은 범위(±5~10%)는 이론 농도 20배이지만 <b>실측 TIR 1.4%</b>에 그쳐 수수료 수익이 미미.</li>
  <li>1년간 ETH +47%, SOL -34% 움직임에서 <b>±50% 범위가 종합 수익 최대</b>.</li>
  <li>→ "좁을수록 고APR" 은 추세장에서 함정. <b>±20~50% 중광범위 + 연 1~2회 재설정</b>이 현실적 최적.</li>
</ul>
</div>

<h2 id="s4">4. 포트폴리오 백테스트: L1 vs L2</h2>
<p>6개 구성요소로 포트폴리오를 구성하고 최근 365일 일별 NAV 를 시뮬.
Uniswap V3 범위는 진입시점 ±50% 고정, 리밸런싱 비용 30bp/회.</p>

<h3>L1 (Ethereum 메인넷 + Solana) 전략 구성요소</h3>
<table>
<thead><tr><th>Key</th><th>구성</th><th class="num">CAGR</th><th class="num">변동성</th><th class="num">Sharpe</th><th class="num">MaxDD</th></tr></thead>
<tbody>
<tr><td>A</td><td>Aave V3 USDC (Ethereum)</td><td class="num">3.50%</td><td class="num">0.04%</td><td class="num">11.63</td><td class="num">0.00%</td></tr>
<tr><td>B</td><td>Curve FRAX-USDC</td><td class="num">3.89%</td><td class="num">0.14%</td><td class="num">6.21</td><td class="num">0.00%</td></tr>
<tr class="highlight"><td>C</td><td>Orca USDC-USDT (Solana)</td><td class="num">4.56%</td><td class="num">0.10%</td><td class="num">15.17</td><td class="num">0.00%</td></tr>
<tr><td>D</td><td>Uniswap V3 USDC-USDT</td><td class="num">3.14%</td><td class="num">0.13%</td><td class="num">1.12</td><td class="num">0.00%</td></tr>
<tr><td>E</td><td>Uniswap V3 ETH-USDC ±50%</td><td class="num">30.33%</td><td class="num">8.75%</td><td class="num">3.12</td><td class="num neg">-1.91%</td></tr>
<tr><td>F</td><td>Orca SOL-USDC ±50%</td><td class="num">73.17%</td><td class="num">31.02%</td><td class="num">2.26</td><td class="num neg">-24.89%</td></tr>
</tbody>
</table>

<h3>L2 (Arbitrum + Base + Solana) 전략 구성요소</h3>
<table>
<thead><tr><th>Key</th><th>구성</th><th class="num">CAGR</th><th class="num">변동성</th><th class="num">Sharpe</th><th class="num">MaxDD</th></tr></thead>
<tbody>
<tr><td>A</td><td>Aave V3 USDC (Arbitrum)</td><td class="num">3.36%</td><td class="num">0.10%</td><td class="num">3.55</td><td class="num">0.00%</td></tr>
<tr><td>B</td><td>Aave V3 USDC (Base)</td><td class="num">4.26%</td><td class="num">0.11%</td><td class="num">11.88</td><td class="num">0.00%</td></tr>
<tr><td>C</td><td>Orca USDC-USDT (Solana)</td><td class="num">4.83%</td><td class="num">0.15%</td><td class="num">11.88</td><td class="num">0.00%</td></tr>
<tr class="highlight"><td>D</td><td>Uniswap V3 USDC-USDT (Arbitrum)</td><td class="num">6.40%</td><td class="num">0.35%</td><td class="num">9.81</td><td class="num">0.00%</td></tr>
<tr><td>E</td><td>Uniswap V3 ETH-USDC ±50% (Arb)</td><td class="num">35.85%</td><td class="num">9.25%</td><td class="num">3.55</td><td class="num neg">-2.30%</td></tr>
<tr><td>F</td><td>Uniswap V3 ETH-USDC ±50% (Base)</td><td class="num">34.19%</td><td class="num">9.10%</td><td class="num">3.43</td><td class="num neg">-2.22%</td></tr>
</tbody>
</table>

<p><b>관찰:</b> L2 가 L1 대비 Aave USDC (Base 4.26% vs L1 3.50%),
Uniswap V3 USDC-USDT (Arbitrum 6.40% vs L1 3.14%, MERKL 리워드),
ETH-USDC LP (35.85% vs 30.33%) 에서 모두 우위. 가스비도 1/20 수준.</p>

<h3>포트폴리오 NAV 시계열</h3>
<img class="plot" src="__PLOT_L1__" alt="L1 portfolio NAV">
<div class="plot-caption">L1 전략: 6개 구성요소 NAV + 포트폴리오 (buy&hold / monthly / quarterly)</div>
<img class="plot" src="__PLOT_L2__" alt="L2 portfolio NAV">
<div class="plot-caption">L2 전략: 6개 구성요소 NAV + 포트폴리오 (buy&hold / monthly / quarterly)</div>

<h2 id="s5">5. 리밸런싱 주기 효과</h2>

<table>
<thead><tr>
<th>전략</th><th>리밸런싱</th><th class="num">CAGR</th><th class="num">변동성</th><th class="num">Sharpe</th><th class="num">MaxDD</th><th class="num">횟수</th><th>코멘트</th>
</tr></thead>
<tbody>
<tr><td>L1</td><td>없음</td><td class="num">7.68%</td><td class="num">1.29%</td><td class="num">3.62</td><td class="num">-0.24%</td><td class="num">0</td><td>기준</td></tr>
<tr><td>L1</td><td>월간</td><td class="num">7.40%</td><td class="num">1.22%</td><td class="num">3.60</td><td class="num">-0.22%</td><td class="num">12</td><td>-0.28%p (비용 과다)</td></tr>
<tr><td>L1</td><td>분기</td><td class="num">7.49%</td><td class="num">1.24%</td><td class="num">3.62</td><td class="num">-0.22%</td><td class="num">4</td><td>월간보다 양호</td></tr>
<tr><td>L2</td><td>없음</td><td class="num">9.05%</td><td class="num">1.49%</td><td class="num">4.06</td><td class="num">-0.33%</td><td class="num">0</td><td>기준</td></tr>
<tr><td>L2</td><td>월간</td><td class="num">8.68%</td><td class="num">1.39%</td><td class="num">4.09</td><td class="num">-0.30%</td><td class="num">12</td><td>-0.37%p</td></tr>
<tr class="highlight"><td>L2</td><td>분기</td><td class="num">8.80%</td><td class="num">1.41%</td><td class="num">4.11</td><td class="num">-0.30%</td><td class="num">4</td><td>Sharpe 최고</td></tr>
</tbody>
</table>

<div class="card">
<h4>결론</h4>
<ul>
  <li>저변동 포트폴리오에서는 <b>리밸런싱 비용 &gt; 분산 효과</b> 로 buy&hold 가 약간 우위.</li>
  <li>하지만 현실에서는 장기간 가중치 편류가 누적되므로 <b>분기 1회</b>가 실무 최적.</li>
  <li>월간은 거래비용(가스+슬리피지)만 누적되므로 권장하지 않음.</li>
</ul>
</div>

<h2 id="s6">6. 최소분산 최적화 (목표 CAGR ≥ 6.5~7.5%)</h2>

<h3>L1 — 목표 CAGR ≥ 7.5%, Top 5 (Monte Carlo 30,000표본)</h3>
<table>
<thead><tr>
<th>#</th><th class="num">A</th><th class="num">B</th><th class="num">C</th><th class="num">D</th><th class="num">E</th><th class="num">F</th><th class="num">현금</th><th class="num">CAGR</th><th class="num">변동성</th><th class="num">Sharpe</th><th class="num">MaxDD</th>
</tr></thead>
<tbody>
<tr class="highlight"><td>1</td><td class="num">29.8%</td><td class="num">5.1%</td><td class="num">48.7%</td><td class="num">0.6%</td><td class="num">13.9%</td><td class="num">0.0%</td><td class="num">1.8%</td><td class="num">7.74%</td><td class="num">1.30%</td><td class="num">5.97</td><td class="num">-0.25%</td></tr>
<tr><td>2</td><td class="num">18.8%</td><td class="num">12.4%</td><td class="num">47.0%</td><td class="num">5.7%</td><td class="num">12.5%</td><td class="num">0.5%</td><td class="num">3.0%</td><td class="num">7.64%</td><td class="num">1.30%</td><td class="num">5.86</td><td class="num">-0.32%</td></tr>
<tr><td>3</td><td class="num">24.6%</td><td class="num">40.2%</td><td class="num">14.0%</td><td class="num">6.5%</td><td class="num">13.2%</td><td class="num">0.4%</td><td class="num">1.2%</td><td class="num">7.55%</td><td class="num">1.33%</td><td class="num">5.66</td><td class="num">-0.33%</td></tr>
</tbody>
</table>

<h3>L2 — 목표 CAGR ≥ 6.5%, Top 3</h3>
<table>
<thead><tr>
<th>#</th><th class="num">A</th><th class="num">B</th><th class="num">C</th><th class="num">D</th><th class="num">E</th><th class="num">F</th><th class="num">현금</th><th class="num">CAGR</th><th class="num">변동성</th><th class="num">Sharpe</th><th class="num">MaxDD</th>
</tr></thead>
<tbody>
<tr class="highlight"><td>1</td><td class="num">13.0%</td><td class="num">3.0%</td><td class="num">10.0%</td><td class="num">69.6%</td><td class="num">2.3%</td><td class="num">0.7%</td><td class="num">1.4%</td><td class="num">6.55%</td><td class="num">0.40%</td><td class="num">16.43</td><td class="num">-0.04%</td></tr>
<tr><td>2</td><td class="num">2.2%</td><td class="num">13.7%</td><td class="num">5.4%</td><td class="num">68.4%</td><td class="num">0.4%</td><td class="num">3.2%</td><td class="num">6.8%</td><td class="num">6.52%</td><td class="num">0.44%</td><td class="num">14.97</td><td class="num">-0.05%</td></tr>
<tr><td>3</td><td class="num">9.1%</td><td class="num">0.7%</td><td class="num">33.5%</td><td class="num">49.8%</td><td class="num">1.9%</td><td class="num">2.1%</td><td class="num">3.0%</td><td class="num">6.53%</td><td class="num">0.45%</td><td class="num">14.54</td><td class="num">-0.06%</td></tr>
</tbody>
</table>

<p><b>주의</b>: 최적화가 <b>D(Arbitrum V3 USDC-USDT) 에 70% 집중</b>하지만, 단일 풀 리스크 상 실무는 <b>30-40% 상한</b> 권장.</p>

<h2 id="s7">7. 최종 추천 포트폴리오 (Option L2*)</h2>
<p>최적화 결과에 "단일 풀 최대 25%, 단일 체인 최대 60%, 최소 3개 프로토콜" 제약을 반영한 실운용안:</p>

<table>
<thead><tr>
<th>자산</th><th>프로토콜</th><th>체인</th><th class="num">비중</th><th class="num">개별 CAGR</th><th class="num">기여</th><th>역할</th>
</tr></thead>
<tbody>
<tr><td>Aave V3 USDC</td><td>Aave</td><td>Arbitrum</td><td class="num">20%</td><td class="num">3.36%</td><td class="num">+0.67%</td><td>대형 렌딩 #1</td></tr>
<tr><td>Aave V3 USDC</td><td>Aave</td><td>Base</td><td class="num">15%</td><td class="num">4.26%</td><td class="num">+0.64%</td><td>대형 렌딩 #2</td></tr>
<tr><td>Orca USDC-USDT</td><td>Orca</td><td>Solana</td><td class="num">20%</td><td class="num">4.83%</td><td class="num">+0.97%</td><td>Solana 스테이블</td></tr>
<tr><td>Uniswap V3 USDC-USDT</td><td>Uniswap</td><td>Arbitrum</td><td class="num">25%</td><td class="num">6.40%</td><td class="num">+1.60%</td><td>고수익 스테이블 LP</td></tr>
<tr class="highlight"><td>Uniswap V3 ETH-USDC ±50%</td><td>Uniswap</td><td>Arbitrum</td><td class="num">15%</td><td class="num">35.85%</td><td class="num">+5.38%</td><td>수익 엔진</td></tr>
<tr><td>USDC 현금</td><td>-</td><td>-</td><td class="num">5%</td><td class="num">0.00%</td><td class="num">+0.00%</td><td>예비금 (범위 이탈 대응)</td></tr>
<tr><td colspan="3"><b>합계</b></td><td class="num"><b>100%</b></td><td class="num">-</td><td class="num"><b>+9.26%</b></td><td>(단일 경로 백테스트)</td></tr>
</tbody>
</table>

<div class="tldr">
<h3>Option L2* 예상 성과</h3>
<ul>
  <li><b>CAGR: ~8.3%</b> (보수적 추정, 실측 9.26%)</li>
  <li><b>변동성: ~1.2%</b></li>
  <li><b>Sharpe: ~4.5</b></li>
  <li><b>MaxDD: ~-0.3%</b></li>
  <li>단일 프로토콜 최대 노출 25%, 단일 체인 최대 60% (Arbitrum)</li>
</ul>
</div>

<h2 id="s8">8. 실제 배포 체크리스트</h2>

<h3>8-A. 지갑 & 도구 셋업</h3>
<table>
<thead><tr><th>항목</th><th>권장</th><th>URL</th></tr></thead>
<tbody>
<tr><td>EVM 지갑</td><td>Rabby (MetaMask 대체, 시뮬레이션 우수)</td><td><a href="https://rabby.io" target="_blank">rabby.io</a></td></tr>
<tr><td>Solana 지갑</td><td>Phantom</td><td><a href="https://phantom.app" target="_blank">phantom.app</a></td></tr>
<tr><td>하드웨어 지갑</td><td>Ledger Nano X / Trezor Model T</td><td>ledger.com / trezor.io</td></tr>
<tr><td>포트폴리오 추적</td><td>DeBank (EVM), Step Finance (SOL)</td><td><a href="https://debank.com" target="_blank">debank.com</a></td></tr>
<tr><td>실시간 APY</td><td>DefiLlama Yields</td><td><a href="https://defillama.com/yields" target="_blank">defillama.com/yields</a></td></tr>
<tr><td>L2 가스</td><td>l2fees.info</td><td><a href="https://l2fees.info" target="_blank">l2fees.info</a></td></tr>
</tbody>
</table>

<h3>8-B. 각 풀 진입 절차</h3>
<table>
<thead><tr><th>프로토콜</th><th>풀</th><th>URL</th><th>진입 방법</th></tr></thead>
<tbody>
<tr><td>Aave V3</td><td>USDC Supply (Arbitrum)</td><td><a href="https://app.aave.com" target="_blank">app.aave.com</a></td><td>체인 Arbitrum → Supply → USDC</td></tr>
<tr><td>Aave V3</td><td>USDC Supply (Base)</td><td>app.aave.com</td><td>체인 Base → Supply → USDC</td></tr>
<tr><td>Orca</td><td>USDC-USDT Whirlpool</td><td><a href="https://orca.so/pools" target="_blank">orca.so/pools</a></td><td>Pools → USDC-USDT → Full Range</td></tr>
<tr><td>Uniswap V3</td><td>USDC-USDT (Arbitrum)</td><td><a href="https://app.uniswap.org" target="_blank">app.uniswap.org</a></td><td>Pool → 0.01% 티어 → Full Range</td></tr>
<tr><td>Uniswap V3</td><td>ETH-USDC 0.05% (Arbitrum)</td><td>app.uniswap.org</td><td>Pool → 0.05% → 진입가 ±50% 범위 직접 설정</td></tr>
</tbody>
</table>

<h3>8-C. 자금 이동 플로우</h3>
<pre>
1. 국내 거래소 (업비트/빗썸) → USDC 구매 → 개인 지갑 송금
2. Rabby 에 $40,000  →  Across/Stargate 브리지
      ├─ $25,000 → Arbitrum  (Aave + Uniswap V3 용)
      └─ $15,000 → Base      (Aave 용)
3. Phantom 에 $10,000 (거래소에서 Solana 직접 출금, Orca 용)
4. 각 체인 네이티브 가스 확보: ETH on Arb/Base ($30), SOL on Solana ($20)
5. 각 프로토콜 순차 진입 (총 소요 30분, 가스 총 $20 이내)
6. DeBank + Phantom 대시보드 추적 설정
7. 분기 1회 NAV·범위 점검
</pre>

<h3>8-D. 보험 옵션 (자금 $50k 이상 권장)</h3>
<table>
<thead><tr><th>프로바이더</th><th>URL</th><th>연 비용</th><th>커버 대상</th></tr></thead>
<tbody>
<tr><td>Nexus Mutual</td><td><a href="https://nexusmutual.io" target="_blank">nexusmutual.io</a></td><td>2-5%</td><td>스마트컨트랙트 실패</td></tr>
<tr><td>OpenCover</td><td><a href="https://opencover.com" target="_blank">opencover.com</a></td><td>1-3%</td><td>Aave/Uniswap/Curve</td></tr>
<tr><td>Uno Re</td><td><a href="https://unore.io" target="_blank">unore.io</a></td><td>2-4%</td><td>크로스체인</td></tr>
</tbody>
</table>

<h3>8-E. 세무 (한국)</h3>
<ul>
  <li>LP 수수료 수익: 현재 기타소득/사업소득 분류 가능 → 종합과세 대상</li>
  <li>2027년부터 가상자산 양도소득세 시행 (연 250만원 공제, 초과분 22%)</li>
  <li>기록 관리: <a href="https://koinly.io" target="_blank">Koinly</a>, <a href="https://cointracker.io" target="_blank">CoinTracker</a> 로 자동 기록</li>
  <li>$10k 이상 운용 시 세무사 1회 상담 권장</li>
</ul>

<h2 id="s9">9. 리스크 시나리오 & 대응</h2>
<table>
<thead><tr><th>시나리오</th><th>확률</th><th>영향</th><th>대응</th></tr></thead>
<tbody>
<tr><td>USDC 디페그 (1일 &lt; $0.98)</td><td>낮음</td><td>-5% 내외</td><td>즉시 USDT/DAI 스왑</td></tr>
<tr><td>Aave 해킹</td><td>매우 낮음</td><td>-35% (Aave 비중)</td><td>Nexus Mutual 보험</td></tr>
<tr><td>ETH -50% 폭락</td><td>중간 (2-3년 1회)</td><td>LP -15%</td><td>범위 재설정 or Aave 이동</td></tr>
<tr><td>Solana 체인 중단</td><td>낮음</td><td>일시 유동성 정지</td><td>재개 후 정상 운용</td></tr>
<tr><td>Arbitrum Sequencer 중단</td><td>낮음</td><td>거래 지연</td><td>대체 UI 사용</td></tr>
<tr><td>ETH-USDC 범위 이탈</td><td>높음 (6-12개월)</td><td>수수료 0</td><td>분기 점검 시 재설정</td></tr>
</tbody>
</table>

<h2 id="s10">10. 주의 & 면책</h2>
<div class="warn">
<ul>
  <li>본 리포트는 <b>최근 1년(365일) DefiLlama 단일 경로 데이터</b>에 기반한 추정이며,
    과거 성과는 미래 성과를 보장하지 않습니다.</li>
  <li>Uniswap V3 LP 는 "진입시점 ±50% 범위 고정, 방치" 가정. 실제로는 범위 이탈·재설정 비용 발생.</li>
  <li>스마트컨트랙트 해킹, 스테이블코인 디페그, 체인 중단, 프라이빗키 분실 등으로
    <b>원금 전체 손실 가능성</b>이 존재합니다.</li>
  <li>한국 세무·규제 관점에서 개인 신고 책임이 발생할 수 있으며, 세무 자문이 필요합니다.</li>
  <li>본 리포트는 투자자문이 아닌 <b>정보성 자료</b>이며, 투자 판단 및 그 결과에 대한 책임은 전적으로 본인에게 있습니다.</li>
</ul>
</div>

<h3>재현 명령어</h3>
<pre>
python3 defi_anal.py                                  # 전체 파이프라인 (기본)
python3 defi_anal.py --only pools                     # 풀 분석만
python3 defi_anal.py --only portfolio --strategy l2   # L2 포트폴리오만
python3 defi_anal.py --only report                    # 기존 PNG 로 리포트만 재생성
</pre>

<div class="footer">
DefiLlama Yields / Coins API (공개 무인증) · Python numpy + matplotlib · 단일 HTML 자립형 리포트<br>
파일 공유: 이 HTML 파일을 그대로 이메일·메신저·드롭박스 등에 첨부하면 별도 리소스 없이 열람 가능.<br>
Generated at __TIMESTAMP__.
</div>

</div>
</body>
</html>
"""


def _img_b64(path: str) -> str | None:
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        data = f.read()
    return "data:image/png;base64," + base64.b64encode(data).decode("ascii")


def run_report(plot_dir: str, out_html: str) -> None:
    plot_dir_p = Path(plot_dir)
    required = {
        "UNISWAP":  plot_dir_p / "rolling_apy_uniswap-v3.png",
        "CURVE":    plot_dir_p / "rolling_apy_curve-dex.png",
        "AAVE":     plot_dir_p / "rolling_apy_aave-v3.png",
        "ORCA":     plot_dir_p / "rolling_apy_orca-dex.png",
        "RAYDIUM":  plot_dir_p / "rolling_apy_raydium-amm.png",
        "L1":       plot_dir_p / "portfolio_nav_l1.png",
        "L2":       plot_dir_p / "portfolio_nav_l2.png",
    }
    missing = [k for k, p in required.items() if not p.exists()]
    if missing:
        print(f"  [경고] 누락 플롯: {missing}")
        print("    누락된 플롯은 빈 이미지로 처리됩니다. 먼저 pools/portfolio 단계를 실행하세요.")

    html = HTML_TEMPLATE.replace("__TIMESTAMP__", datetime.now().strftime("%Y-%m-%d %H:%M"))
    total_b64 = 0
    for key, p in required.items():
        b64 = _img_b64(str(p))
        placeholder = f"__PLOT_{key}__"
        if b64:
            html = html.replace(placeholder, b64)
            total_b64 += len(b64)
        else:
            html = html.replace(placeholder, "")

    os.makedirs(os.path.dirname(os.path.abspath(out_html)), exist_ok=True)
    with open(out_html, "w", encoding="utf-8") as f:
        f.write(html)

    size_kb = os.path.getsize(out_html) / 1024
    print(f"  ✓ 리포트 저장: {out_html}")
    print(f"    파일 크기: {size_kb:,.1f} KB  (이미지 임베드 {total_b64/1024:,.0f} KB)")
    print(f"    브라우저에서 열기: file://{os.path.abspath(out_html)}")


# ===========================================================================
# 16. 메인
# ===========================================================================

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="DeFi 종합 분석 (풀 수익률 + 포트폴리오 백테스트 + HTML 리포트)",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--only", choices=["all", "pools", "portfolio", "report"], default="all",
                        help="실행 단계 선택")
    parser.add_argument("--days", type=int, default=365, help="최근 N일 데이터")
    parser.add_argument("--sleep", type=float, default=0.3, help="요청 사이 딜레이(초)")

    g_pool = parser.add_argument_group("풀 분석 옵션")
    g_pool.add_argument("--no-il", action="store_true", help="IL 계산 생략")
    g_pool.add_argument("--no-range-sim", action="store_true", help="V3 범위 시뮬 생략")
    g_pool.add_argument("--widths", type=str, default="0.05,0.10,0.20,0.50",
                        help="range-sim 폭(±) 콤마 구분")
    g_pool.add_argument("--roll", type=int, default=30, help="rolling window 일수")
    g_pool.add_argument("--csv", type=str, default=None, help="풀 통계 CSV 저장 경로")
    g_pool.add_argument(
        "--history-csv",
        type=str,
        default="data/defi_yield/apy_history.csv",
        help="일별 APY 롱포맷 통합 CSV (--no-history 시 비활성)",
    )
    g_pool.add_argument(
        "--history-by-project-dir",
        type=str,
        default="data/defi_yield/by_project",
        help="프로젝트별 CSV 및 run_meta.json 저장 디렉터리",
    )
    g_pool.add_argument("--no-history", action="store_true", help="일별 APY 파일 저장 생략")

    g_port = parser.add_argument_group("포트폴리오 옵션")
    g_port.add_argument("--strategy", choices=["l1", "l2", "both"], default="both",
                        help="포트폴리오 전략 (both = L1 + L2 모두)")
    g_port.add_argument("--target", type=float, default=0.075, help="목표 CAGR (소수)")
    g_port.add_argument("--min-core", type=float, default=0.50, help="코어 최소 비중")
    g_port.add_argument("--max-lp", type=float, default=0.45, help="LP 최대 비중")
    g_port.add_argument("--mc", type=int, default=20000, help="Monte Carlo 표본 수")
    g_port.add_argument("--rebal", choices=["none", "monthly", "quarterly"], default="quarterly",
                        help="기본 리밸런싱 주기 (민감도/플롯 강조용)")
    g_port.add_argument("--rebal-cost-bps", type=float, default=30.0, help="리밸런싱 거래비용(bp)")
    g_port.add_argument("--risk-free", type=float, default=0.03, help="무위험 이자율(Sharpe)")

    g_out = parser.add_argument_group("출력")
    g_out.add_argument("--plot-dir", type=str, default="tools/plots", help="PNG 저장 폴더")
    g_out.add_argument("--no-plot", action="store_true", help="모든 플롯 생성 생략")
    g_out.add_argument("--report-out", type=str, default="reports/defi_portfolio_report.html",
                        help="HTML 리포트 출력 경로")

    args = parser.parse_args(argv)

    try:
        widths = [float(x) for x in args.widths.split(",") if x.strip()]
    except ValueError:
        widths = [0.05, 0.10, 0.20, 0.50]

    plot_dir: str | None = None if args.no_plot else args.plot_dir
    charts_cache: dict[str, tuple[dict[str, Any], list[dict[str, Any]]]] = {}
    catalog: list[dict[str, Any]] | None = None

    need_catalog = args.only in ("all", "pools", "portfolio")
    if need_catalog:
        print(f"[0] DefiLlama 풀 카탈로그 가져오는 중 ...")
        catalog = fetch_pools_catalog()
        print(f"    총 {len(catalog):,}개 풀 메타데이터 수신")

    hist_csv = None if args.no_history else args.history_csv
    hist_dir = None if args.no_history else args.history_by_project_dir

    if args.only in ("all", "pools"):
        assert catalog is not None
        charts_cache = run_pools_analysis(
            catalog=catalog,
            days=args.days, sleep=args.sleep,
            do_il=not args.no_il, do_range_sim=not args.no_range_sim,
            widths=widths,
            plot_dir=plot_dir, roll_window=args.roll,
            csv_path=args.csv,
            history_csv=hist_csv,
            history_by_project_dir=hist_dir,
        )

    if args.only in ("all", "portfolio"):
        assert catalog is not None
        strategies = ["l1", "l2"] if args.strategy == "both" else [args.strategy]
        for s in strategies:
            run_portfolio_backtest(
                strategy=s, catalog=catalog,
                days=args.days, target_cagr=args.target,
                min_core=args.min_core, max_lp=args.max_lp,
                mc=args.mc, rebal=args.rebal, rebal_cost_bps=args.rebal_cost_bps,
                plot_dir=plot_dir, risk_free=args.risk_free,
                charts_cache=charts_cache, sleep=args.sleep,
            )

    if args.only in ("all", "report"):
        print(f"\n[리포트] 자립형 HTML 생성")
        run_report(plot_dir=args.plot_dir, out_html=args.report_out)

    print("\n[주의]")
    print(" - 과거 성과 ≠ 미래 성과. DefiLlama 단일 경로 백테스트.")
    print(" - Uniswap V3 은 진입시점 ±50% 범위 고정 방치 가정.")
    print(" - 가스비·브리지·슬리피지·세금 미반영. 실체감 수익률은 보수적으로 -1~2%p.")
    print(" - HTML 리포트 표의 수치는 이전 분석 결과 고정값으로, 플롯만 최신 PNG 로 교체됩니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
