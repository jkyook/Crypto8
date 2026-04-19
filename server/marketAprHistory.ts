import { randomUUID } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getDb } from "./db";

const __marketHistoryDir = dirname(fileURLToPath(import.meta.url));

const MIN_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
let lastSampleAtMs = 0;
let pruneCounter = 0;

export async function maybeAppendMarketRatesSnapshot(
  rates: { aave: number; uniswap: number; orca: number },
  force = false
): Promise<void> {
  const now = Date.now();
  if (!force && now - lastSampleAtMs < MIN_SAMPLE_INTERVAL_MS) {
    return;
  }
  lastSampleAtMs = now;
  const db = getDb();
  await db.marketRatesSnapshot.create({
    data: {
      id: randomUUID(),
      sampledAt: new Date().toISOString(),
      aave: rates.aave,
      uniswap: rates.uniswap,
      orca: rates.orca
    }
  });
  pruneCounter += 1;
  if (pruneCounter >= 12) {
    pruneCounter = 0;
    const cutoff = new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString();
    await db.marketRatesSnapshot.deleteMany({ where: { sampledAt: { lt: cutoff } } });
  }
}

export type MarketRatesHistoryPoint = {
  t: string;
  aave: number;
  uniswap: number;
  orca: number;
};

export type PoolApyHistoryPoint = {
  t: string;
  pools: Record<string, number>;
};

export type PoolApyHistorySeries = {
  key: string;
  label: string;
  poolLabel: string;
  matchedLabel?: string;
  matchedProject?: string;
  matchedChain?: string;
  matchedSymbol?: string;
};

function resolveBucketMs(hours: number, bucket: "auto" | "hour" | "day"): { bucketMs: number; granularity: "hour" | "day" } {
  if (bucket === "hour") return { bucketMs: 3_600_000, granularity: "hour" };
  if (bucket === "day") return { bucketMs: 86_400_000, granularity: "day" };
  return hours <= 72 ? { bucketMs: 3_600_000, granularity: "hour" } : { bucketMs: 86_400_000, granularity: "day" };
}

export async function listMarketRatesHistory(opts: {
  hours: number;
  bucket: "auto" | "hour" | "day";
}): Promise<{ granularity: "hour" | "day"; points: MarketRatesHistoryPoint[] }> {
  const hours = Number.isFinite(opts.hours) && opts.hours > 0 ? Math.min(opts.hours, 24 * 45) : 168;
  const { bucketMs, granularity } = resolveBucketMs(hours, opts.bucket);
  const sinceMs = Date.now() - hours * 3600 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();

  const db = getDb();
  const rows = await db.marketRatesSnapshot.findMany({
    where: { sampledAt: { gte: sinceIso } },
    orderBy: { sampledAt: "asc" },
    take: 12_000
  });

  const map = new Map<number, MarketRatesHistoryPoint>();
  for (const r of rows) {
    const ts = new Date(r.sampledAt).getTime();
    if (Number.isNaN(ts)) continue;
    const k = Math.floor(ts / bucketMs) * bucketMs;
    map.set(k, {
      t: new Date(k).toISOString(),
      aave: r.aave,
      uniswap: r.uniswap,
      orca: r.orca
    });
  }
  const points = [...map.values()].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
  return { granularity, points };
}

/* ---- apy_history.csv (일별 역사 APY) — 외부 수집본 또는 번들 CSV ---- */

/**
 * CSV 경로 우선순위:
 *  1) `APY_HISTORY_CSV_PATH` 환경변수
 *  2) (선택) `APY_HISTORY_CSV_FALLBACK_PATH` 환경변수 — 개발자 로컬 수집본 등
 *  3) 번들된 `server/data/apy_history.csv`
 *
 * 이전에는 특정 개발자의 절대경로(`/Users/yugjingwan/...`)가 하드코딩되어 있어
 *  코드 베이스 공유 시 의도치 않은 환경 의존성이 새겼습니다. 환경변수로만 받도록 정리.
 */
function defaultApyCsvPath(): string {
  const fromEnv = process.env.APY_HISTORY_CSV_PATH?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  const fallbackEnv = process.env.APY_HISTORY_CSV_FALLBACK_PATH?.trim();
  if (fallbackEnv && fallbackEnv.length > 0 && existsSync(fallbackEnv)) {
    return fallbackEnv;
  }
  return join(__marketHistoryDir, "data", "apy_history.csv");
}

function parseApyCsvLine(line: string): {
  date: string;
  label: string;
  project: string;
  chain: string;
  symbol: string;
  apyPct: number;
} | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("date,")) return null;
  const parts = trimmed.split(",");
  const n = parts.length;
  if (n < 10) return null;
  const date = parts[0];
  const apyRaw = parts[n - 4];
  const apyPct = Number(apyRaw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(apyPct)) {
    return null;
  }
  const label = parts[n - 8];
  const project = parts[n - 7];
  const chain = parts[n - 6];
  const symbol = parts[n - 5];
  return { date, label, project, chain, symbol, apyPct };
}

function csvRowMatchesAave(project: string, chain: string): boolean {
  const p = project.toLowerCase();
  const c = chain.toLowerCase();
  return p.includes("aave") && (c.includes("arbitrum") || c === "base");
}

function csvRowMatchesUniswap(project: string, chain: string): boolean {
  const p = project.toLowerCase();
  const c = chain.toLowerCase();
  return p.includes("uniswap") && c.includes("arbitrum");
}

function csvRowMatchesOrca(project: string, chain: string): boolean {
  const p = project.toLowerCase();
  const c = chain.toLowerCase();
  return p.includes("orca") && c.includes("solana");
}

function meanApy(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

let csvCachePath = "";
let csvCacheMtimeMs = 0;
let csvCacheByDate: Map<string, { aave: number[]; uni: number[]; orca: number[] }> | null = null;
let csvRowsCache: ReturnType<typeof parseApyCsvLine>[] | null = null;

function loadApyCsvAggregates(): Map<string, { aave: number[]; uni: number[]; orca: number[] }> | null {
  const path = defaultApyCsvPath();
  if (!existsSync(path)) {
    return null;
  }
  const st = statSync(path);
  if (csvCacheByDate && csvCachePath === path && st.mtimeMs === csvCacheMtimeMs) {
    return csvCacheByDate;
  }
  const text = readFileSync(path, "utf8");
  const byDate = new Map<string, { aave: number[]; uni: number[]; orca: number[] }>();
  const rows: NonNullable<ReturnType<typeof parseApyCsvLine>>[] = [];
  for (const line of text.split("\n")) {
    const row = parseApyCsvLine(line);
    if (!row) continue;
    rows.push(row);
    let bucket = byDate.get(row.date);
    if (!bucket) {
      bucket = { aave: [], uni: [], orca: [] };
      byDate.set(row.date, bucket);
    }
    const apyDec = row.apyPct / 100;
    if (csvRowMatchesAave(row.project, row.chain)) bucket.aave.push(apyDec);
    if (csvRowMatchesUniswap(row.project, row.chain)) bucket.uni.push(apyDec);
    if (csvRowMatchesOrca(row.project, row.chain)) bucket.orca.push(apyDec);
  }
  csvCachePath = path;
  csvCacheMtimeMs = st.mtimeMs;
  csvCacheByDate = byDate;
  csvRowsCache = rows;
  return byDate;
}

function loadApyCsvRows(): NonNullable<ReturnType<typeof parseApyCsvLine>>[] | null {
  const aggregates = loadApyCsvAggregates();
  if (!aggregates || !csvRowsCache) return null;
  return csvRowsCache.filter(Boolean) as NonNullable<ReturnType<typeof parseApyCsvLine>>[];
}

function normText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function poolSeriesKey(poolLabel: string, index: number): string {
  const key = normText(poolLabel).slice(0, 42);
  return key.length > 0 ? key : `pool${index}`;
}

function inferRequestedChain(poolLabel: string): string | null {
  const label = poolLabel.toLowerCase();
  if (label.includes("arbitrum")) return "arbitrum";
  if (label.includes("base")) return "base";
  if (label.includes("solana") || label.includes("orca")) return "solana";
  if (label.includes("ethereum")) return "ethereum";
  return null;
}

function requestedPairTokens(poolLabel: string): string[] {
  const label = poolLabel.toLowerCase();
  if (label.includes("usdc-usdt") || label.includes("usdt-usdc")) return ["usdc", "usdt"];
  if (label.includes("eth-usdc") || label.includes("weth-usdc") || label.includes("usdc-eth")) return ["eth", "weth", "usdc"];
  if (label.includes("sol-usdc") || label.includes("wsol-usdc") || label.includes("usdc-sol")) return ["sol", "wsol", "usdc"];
  if (label.includes("msol-sol") || label.includes("sol-msol")) return ["msol", "sol"];
  if (label.includes("usdc")) return ["usdc"];
  return [];
}

function requestedProjectScore(poolLabel: string, project: string): number {
  const label = poolLabel.toLowerCase();
  const p = project.toLowerCase();
  if (label.includes("aave") && p.includes("aave")) return 4;
  if (label.includes("uniswap") && p.includes("uniswap")) return 4;
  if (label.includes("orca") && p.includes("orca")) return 4;
  if (label.includes("raydium") && p.includes("raydium")) return 4;
  if (label.includes("aerodrome") && p.includes("aerodrome")) return 4;
  return 0;
}

function requestedSymbolScore(poolLabel: string, symbol: string): number {
  const tokens = requestedPairTokens(poolLabel);
  if (tokens.length === 0) return 1;
  const s = normText(symbol);
  const hits = tokens.filter((token) => s.includes(normText(token))).length;
  const minPairHits = tokens.length > 1 ? 2 : 1;
  if (hits < minPairHits && !(tokens.includes("eth") && s.includes("weth")) && !(tokens.includes("sol") && s.includes("wsol"))) {
    return -4;
  }
  if (tokens.includes("eth") && s.includes("weth")) return hits + 1;
  if (tokens.includes("sol") && s.includes("wsol")) return hits + 1;
  return hits;
}

function scorePoolRow(poolLabel: string, row: NonNullable<ReturnType<typeof parseApyCsvLine>>): number {
  const requestedChain = inferRequestedChain(poolLabel);
  const rowChain = row.chain.toLowerCase();
  const chainScore = requestedChain && rowChain.includes(requestedChain) ? 5 : requestedChain ? -8 : 0;
  const projectScore = requestedProjectScore(poolLabel, row.project);
  const symbolScore = requestedSymbolScore(poolLabel, row.symbol);
  const labelScore = normText(row.label).includes(normText(poolLabel).slice(0, 12)) ? 1 : 0;
  return chainScore + projectScore + symbolScore * 2 + labelScore;
}

function bestPoolRowForLabel(
  poolLabel: string,
  rows: NonNullable<ReturnType<typeof parseApyCsvLine>>[]
): NonNullable<ReturnType<typeof parseApyCsvLine>> | null {
  let best: NonNullable<ReturnType<typeof parseApyCsvLine>> | null = null;
  let bestScore = -Infinity;
  for (const row of rows) {
    const score = scorePoolRow(poolLabel, row);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return bestScore >= 3 ? best : null;
}

/** CSV 기준 일별 풀별 APY(연 소수). 선택 상품 풀 라벨에 가장 가까운 CSV 풀을 매칭한다. */
export function getPoolApySeriesFromCsv(days: number, poolLabels: string[]): {
  ok: boolean;
  source: "csv" | "missing";
  message?: string;
  series: PoolApyHistorySeries[];
  points: PoolApyHistoryPoint[];
} {
  const rows = loadApyCsvRows();
  if (!rows || rows.length === 0) {
    return { ok: false, source: "missing", message: "apy_history.csv 없음 또는 비어 있음", series: [], points: [] };
  }

  const requested = poolLabels.map((poolLabel, index) => ({
    key: poolSeriesKey(poolLabel, index),
    poolLabel,
    match: bestPoolRowForLabel(poolLabel, rows)
  }));

  const series: PoolApyHistorySeries[] = requested.map((item) => ({
    key: item.key,
    label: item.match?.label ?? item.poolLabel,
    poolLabel: item.poolLabel,
    matchedLabel: item.match?.label,
    matchedProject: item.match?.project,
    matchedChain: item.match?.chain,
    matchedSymbol: item.match?.symbol
  }));

  const matchedByKey = new Map(
    requested
      .filter((item): item is { key: string; poolLabel: string; match: NonNullable<ReturnType<typeof parseApyCsvLine>> } => item.match != null)
      .map((item) => [item.key, item.match])
  );
  if (matchedByKey.size === 0) {
    return { ok: false, source: "missing", message: "선택 상품과 매칭되는 CSV 풀이 없습니다.", series, points: [] };
  }

  const daySpan = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 800) : 90;
  const sortedDates = [...new Set(rows.map((row) => row.date))].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const startPos = Math.max(0, sortedDates.length - daySpan);
  const slice = sortedDates.slice(startPos);
  const rowsByDate = new Map<string, NonNullable<ReturnType<typeof parseApyCsvLine>>[]>();
  for (const row of rows) {
    if (!rowsByDate.has(row.date)) rowsByDate.set(row.date, []);
    rowsByDate.get(row.date)?.push(row);
  }

  const lastByKey: Record<string, number> = {};
  const points: PoolApyHistoryPoint[] = [];
  for (const date of slice) {
    const dailyRows = rowsByDate.get(date) ?? [];
    const pools: Record<string, number> = {};
    for (const [key, matched] of matchedByKey) {
      const samePoolRows = dailyRows.filter(
        (row) =>
          row.label === matched.label &&
          row.project === matched.project &&
          row.chain === matched.chain &&
          row.symbol === matched.symbol
      );
      if (samePoolRows.length > 0) {
        lastByKey[key] = meanApy(samePoolRows.map((row) => row.apyPct / 100)) ?? lastByKey[key] ?? 0;
      }
      pools[key] = lastByKey[key] ?? 0;
    }
    points.push({ t: `${date}T12:00:00.000Z`, pools });
  }

  return { ok: true, source: "csv", series, points };
}

/** CSV 기준 일별 APY(연 소수). `days`는 마지막 데이터일 기준 역일수. */
export function getDailyApySeriesFromCsv(days: number): {
  ok: boolean;
  source: "csv" | "missing";
  message?: string;
  points: MarketRatesHistoryPoint[];
} {
  const byDate = loadApyCsvAggregates();
  if (!byDate || byDate.size === 0) {
    return { ok: false, source: "missing", message: "apy_history.csv 없음 또는 비어 있음", points: [] };
  }

  const daySpan = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 800) : 90;
  const sortedDates = [...byDate.keys()].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (sortedDates.length === 0) {
    return { ok: false, source: "missing", message: "유효한 날짜 행이 없습니다.", points: [] };
  }

  const endPos = sortedDates.length - 1;
  const startPos = Math.max(0, endPos - daySpan + 1);
  const slice = sortedDates.slice(startPos, endPos + 1);

  let lastA = 0;
  let lastU = 0;
  let lastO = 0;

  const points: MarketRatesHistoryPoint[] = [];
  for (const d of slice) {
    const b = byDate.get(d);
    if (!b) continue;
    const ma = meanApy(b.aave);
    const mu = meanApy(b.uni);
    const mo = meanApy(b.orca);
    if (ma != null) lastA = ma;
    if (mu != null) lastU = mu;
    if (mo != null) lastO = mo;
    points.push({
      t: `${d}T12:00:00.000Z`,
      aave: lastA,
      uniswap: lastU,
      orca: lastO
    });
  }

  return { ok: true, source: "csv", points };
}
