import type { PrismaClient } from "@prisma/client";
import type { ExecutionMode } from "./adapters/types";

let runtimeExecutionModeOverride: ExecutionMode | null = null;
type LiveProtocol = "aave" | "uniswap" | "orca" | "aerodrome" | "raydium" | "curve";
type LiveFlagSource = "env" | "override";

const LIVE_FLAG_PROTOCOLS: LiveProtocol[] = ["aave", "uniswap", "orca", "aerodrome", "raydium", "curve"];
const LIVE_FLAG_OVERRIDE_PREFIX = "live_flag_override_";
let runtimeLiveFlagOverrides: Partial<Record<LiveProtocol, boolean>> = {};

function normalizeMode(value: unknown): ExecutionMode | null {
  return value === "live" || value === "dry-run" ? value : null;
}

function normalizeLiveFlag(value: unknown): boolean | null {
  if (value === "true" || value === true) return true;
  if (value === "false" || value === false) return false;
  return null;
}

function normalizeProtocol(value: unknown): LiveProtocol | null {
  return typeof value === "string" && (LIVE_FLAG_PROTOCOLS as string[]).includes(value) ? (value as LiveProtocol) : null;
}

function runtimeLiveFlagKey(protocol: LiveProtocol): string {
  return `${LIVE_FLAG_OVERRIDE_PREFIX}${protocol}`;
}

export function getExecutionModeRequestedFromEnv(): ExecutionMode {
  return process.env.EXECUTION_MODE === "live" ? "live" : "dry-run";
}

export function getRuntimeExecutionModeOverride(): ExecutionMode | null {
  return runtimeExecutionModeOverride;
}

export function getRuntimeLiveFlagOverride(protocol: LiveProtocol): boolean | null {
  const override = runtimeLiveFlagOverrides[protocol];
  return typeof override === "boolean" ? override : null;
}

export function getConfiguredLiveFlag(protocol: LiveProtocol): boolean {
  const override = getRuntimeLiveFlagOverride(protocol);
  if (override !== null) {
    return override;
  }
  const envKey = `ENABLE_${protocol.toUpperCase()}_LIVE`;
  return process.env[envKey] === "true";
}

export function getLiveFlagSource(protocol: LiveProtocol): LiveFlagSource {
  return typeof runtimeLiveFlagOverrides[protocol] === "boolean" ? "override" : "env";
}

export function getEffectiveLiveAdapterFlags(): Record<LiveProtocol, boolean> {
  const liveConfirmed = process.env.LIVE_EXECUTION_CONFIRM === "YES";
  return LIVE_FLAG_PROTOCOLS.reduce((acc, protocol) => {
    acc[protocol] = liveConfirmed && getConfiguredLiveFlag(protocol);
    return acc;
  }, {} as Record<LiveProtocol, boolean>);
}

export function getConfiguredLiveAdapterFlags(): Record<LiveProtocol, boolean> {
  return LIVE_FLAG_PROTOCOLS.reduce((acc, protocol) => {
    acc[protocol] = getConfiguredLiveFlag(protocol);
    return acc;
  }, {} as Record<LiveProtocol, boolean>);
}

export function isProtocolLiveExecutionEnabled(protocol: LiveProtocol): boolean {
  return process.env.LIVE_EXECUTION_CONFIRM === "YES" && getConfiguredLiveFlag(protocol);
}

export function getRuntimeLiveFlagSources(): Record<LiveProtocol, LiveFlagSource> {
  return LIVE_FLAG_PROTOCOLS.reduce((acc, protocol) => {
    acc[protocol] = getLiveFlagSource(protocol);
    return acc;
  }, {} as Record<LiveProtocol, LiveFlagSource>);
}

export function getEffectiveExecutionMode(): ExecutionMode {
  const override = runtimeExecutionModeOverride;
  if (override) {
    return override;
  }
  return getExecutionModeRequestedFromEnv() === "live" && process.env.LIVE_EXECUTION_CONFIRM === "YES"
    ? "live"
    : "dry-run";
}

export function buildRuntimeExecutionNote(): string {
  const override = getRuntimeExecutionModeOverride();
  if (override) {
    return `서버 실행 모드 오버라이드가 활성화되어 있습니다: ${override.toUpperCase()}.`;
  }
  return "현재 MVP는 로그인한 사용자가 본인 Job을 직접 실행 요청하는 구조입니다. dry-run 모드에서는 모든 어댑터가 시뮬레이션 결과를 반환합니다. live 모드는 LIVE_EXECUTION_CONFIRM=YES + ENABLE_<PROTOCOL>_LIVE=true 가 모두 필요합니다.";
}

export async function hydrateRuntimeModeOverride(db: PrismaClient): Promise<void> {
  try {
    runtimeExecutionModeOverride = null;
    runtimeLiveFlagOverrides = {};
    const rows = await db.$queryRawUnsafe<Array<{ key: string; value: string }>>(
      `SELECT key, value FROM runtime_settings WHERE key = 'execution_mode_override' OR key LIKE '${LIVE_FLAG_OVERRIDE_PREFIX}%'`
    );
    for (const row of rows) {
      if (row.key === "execution_mode_override") {
        runtimeExecutionModeOverride = normalizeMode(row.value);
        continue;
      }
      const protocol = normalizeProtocol(row.key.replace(LIVE_FLAG_OVERRIDE_PREFIX, ""));
      const flag = normalizeLiveFlag(row.value);
      if (protocol && flag !== null) {
        runtimeLiveFlagOverrides[protocol] = flag;
      }
    }
  } catch {
    runtimeExecutionModeOverride = null;
    runtimeLiveFlagOverrides = {};
  }
}

export async function setRuntimeExecutionModeOverride(
  db: PrismaClient,
  mode: ExecutionMode | null
): Promise<ExecutionMode | null> {
  runtimeExecutionModeOverride = mode;
  if (mode) {
    await db.$executeRawUnsafe(
      `INSERT INTO runtime_settings (key, value, updated_at)
       VALUES ('execution_mode_override', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      mode,
      new Date().toISOString()
    );
  } else {
    await db.$executeRawUnsafe(`DELETE FROM runtime_settings WHERE key = 'execution_mode_override'`);
  }
  return runtimeExecutionModeOverride;
}

export async function setRuntimeLiveFlagOverride(
  db: PrismaClient,
  protocol: LiveProtocol,
  enabled: boolean | null
): Promise<boolean | null> {
  if (enabled === null) {
    delete runtimeLiveFlagOverrides[protocol];
    await db.$executeRawUnsafe(`DELETE FROM runtime_settings WHERE key = '${runtimeLiveFlagKey(protocol)}'`);
    return null;
  }
  runtimeLiveFlagOverrides[protocol] = enabled;
  await db.$executeRawUnsafe(
    `INSERT INTO runtime_settings (key, value, updated_at)
     VALUES ('${runtimeLiveFlagKey(protocol)}', '${enabled ? "true" : "false"}', '${new Date().toISOString()}')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  return enabled;
}
