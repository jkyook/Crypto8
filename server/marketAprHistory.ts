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

/* ---- apy_history.csv (일별 역사 APY) — MG_HanTo 수집본 또는 번들 CSV ---- */

/** 로컬에서 MG_HanTo 수집 CSV가 있으면 우선 사용(Render 등에는 없으므로 번들로 폴백). */
const MG_HAN_APY_HISTORY_CSV = "/Users/yugjingwan/PycharmProjects/MG_HanTo/data/defi_yield/apy_history.csv";

function defaultApyCsvPath(): string {
  const fromEnv = process.env.APY_HISTORY_CSV_PATH;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  if (existsSync(MG_HAN_APY_HISTORY_CSV)) {
    return MG_HAN_APY_HISTORY_CSV;
  }
  return join(__marketHistoryDir, "data", "apy_history.csv");
}

function parseApyCsvLine(line: string): { date: string; project: string; chain: string; apyPct: number } | null {
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
  const project = parts[n - 7];
  const chain = parts[n - 6];
  return { date, project, chain, apyPct };
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
  for (const line of text.split("\n")) {
    const row = parseApyCsvLine(line);
    if (!row) continue;
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
  return byDate;
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
