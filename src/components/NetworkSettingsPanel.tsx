/**
 * NetworkSettingsPanel.tsx
 *
 * 네트워크·실행 모드 통합 설정 패널.
 * - DRY-RUN / REAL-RUN 프리셋 (준비된 프로토콜만 자동 활성화)
 * - 프로토콜별 readiness 상태 + 차단 이유 표시
 * - 개별 프로토콜 ON/OFF 미세 조정
 * - RPC / Solana 키 / LIVE_EXECUTION_CONFIRM 상태 표시
 */
import { useState } from "react";
import {
  setRuntimePreset,
  updateRuntimeLiveFlag,
  type LiveProtocol,
  type ProtocolReadiness,
  type RuntimeInfo
} from "../lib/api";

type Props = {
  runtime: RuntimeInfo | null;
  canToggle: boolean;
  onUpdate: (info: RuntimeInfo) => void;
  onClose: () => void;
};

const PROTOCOL_META: Record<LiveProtocol, { label: string; chain: string }> = {
  aave:      { label: "Aave",      chain: "Arbitrum / Base" },
  uniswap:   { label: "Uniswap",   chain: "Arbitrum" },
  orca:      { label: "Orca",      chain: "Solana" },
  aerodrome: { label: "Aerodrome", chain: "Base" },
  raydium:   { label: "Raydium",   chain: "Solana" },
  curve:     { label: "Curve",     chain: "Ethereum" }
};

const PROTOCOLS: LiveProtocol[] = ["aave", "uniswap", "orca", "aerodrome", "raydium", "curve"];

function ReadinessChip({ readiness }: { readiness: ProtocolReadiness | undefined }) {
  if (!readiness) return null;
  if (!readiness.implemented) return <span className="readiness-chip chip--unimpl">미구현</span>;
  if (readiness.ready) return <span className="readiness-chip chip--ready">준비됨</span>;
  return <span className="readiness-chip chip--blocked">미준비</span>;
}

export function NetworkSettingsPanel({ runtime, canToggle, onUpdate, onClose }: Props) {
  const [presetLoading, setPresetLoading] = useState(false);
  const [flagLoading, setFlagLoading] = useState<LiveProtocol | null>(null);
  const [error, setError] = useState("");

  const effectiveMode = runtime?.executionMode ?? "dry-run";
  const isRealRun = effectiveMode === "live";
  const liveConfirmed = runtime?.liveExecutionConfirmed ?? false;
  const rpc = runtime?.rpcConfigured;
  const solanaKey = runtime?.solanaKeyConfigured ?? false;
  const readinessMap = runtime?.protocolReadiness;

  // REAL-RUN 프리셋이 활성화할 프로토콜 수 (준비된 것만)
  const readyCount = PROTOCOLS.filter((p) => readinessMap?.[p]?.ready).length;

  const applyPreset = async (preset: "dry-run" | "real-run") => {
    if (!canToggle) return;
    setPresetLoading(true);
    setError("");
    try {
      const info = await setRuntimePreset(preset);
      onUpdate(info);
    } catch (err) {
      setError(err instanceof Error ? err.message : "프리셋 변경 실패");
    } finally {
      setPresetLoading(false);
    }
  };

  const toggleProtocol = async (protocol: LiveProtocol, enabled: boolean) => {
    if (!canToggle) return;
    setFlagLoading(protocol);
    setError("");
    try {
      const info = await updateRuntimeLiveFlag(protocol, enabled);
      onUpdate(info);
    } catch (err) {
      setError(err instanceof Error ? err.message : "플래그 변경 실패");
    } finally {
      setFlagLoading(null);
    }
  };

  return (
    <div
      className="net-settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="네트워크 설정"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="net-settings-panel">
        <div className="net-settings-header">
          <h3>⚙ 네트워크 설정</h3>
          <button type="button" className="net-settings-close" onClick={onClose} aria-label="닫기">✕</button>
        </div>

        {/* ── 전체 모드 프리셋 ── */}
        <section className="net-settings-section">
          <p className="net-settings-section-title">실행 모드</p>
          <div className="net-settings-mode-row">
            <button
              type="button"
              className={`net-settings-mode-btn${!isRealRun ? " active" : ""}`}
              onClick={() => void applyPreset("dry-run")}
              disabled={presetLoading || !canToggle}
            >
              DRY-RUN
              <small>시뮬레이션</small>
            </button>
            <button
              type="button"
              className={`net-settings-mode-btn${isRealRun ? " active active--live" : ""}`}
              onClick={() => void applyPreset("real-run")}
              disabled={presetLoading || !canToggle}
              title={readyCount === 0 ? "준비된 프로토콜이 없습니다" : `${readyCount}개 프로토콜 활성화`}
            >
              REAL-RUN
              <small>{readyCount > 0 ? `${readyCount}개 활성화` : "전제조건 필요"}</small>
            </button>
            {presetLoading && <span className="net-settings-spinner">⟳</span>}
          </div>
          {runtime?.executionModeOverride && (
            <span className="net-settings-badge badge--override">
              오버라이드 적용 중 · {runtime.executionModeOverride.toUpperCase()}
            </span>
          )}
          {!canToggle && (
            <p className="net-settings-hint net-settings-hint--warn">
              orchestrator / security 권한 계정만 변경할 수 있습니다.
            </p>
          )}
        </section>

        {/* ── 전제 조건 ── */}
        <section className="net-settings-section">
          <p className="net-settings-section-title">전제 조건</p>
          <div className="net-settings-prereq-grid">
            <div className={`net-settings-prereq${liveConfirmed ? " ok" : " warn"}`}>
              <span className="prereq-icon">{liveConfirmed ? "✓" : "✗"}</span>
              <div>
                <div>LIVE_EXECUTION_CONFIRM</div>
                <code>{liveConfirmed ? "YES" : "미설정"}</code>
              </div>
            </div>
            <div className={`net-settings-prereq${solanaKey ? " ok" : " warn"}`}>
              <span className="prereq-icon">{solanaKey ? "✓" : "✗"}</span>
              <div>
                <div>SOLANA_EXECUTOR_KEY</div>
                <code>{solanaKey ? "설정됨" : "미설정"}</code>
              </div>
            </div>
          </div>
        </section>

        {/* ── RPC 연결 ── */}
        <section className="net-settings-section">
          <p className="net-settings-section-title">RPC 연결</p>
          <div className="net-settings-prereq-grid">
            {(["ethereum", "arbitrum", "base", "solana"] as const).map((chain) => {
              const configured = rpc?.[chain] ?? false;
              return (
                <div key={chain} className={`net-settings-prereq${configured ? " ok" : " warn"}`}>
                  <span className="prereq-icon">{configured ? "✓" : "✗"}</span>
                  <div>
                    <div>{chain.charAt(0).toUpperCase() + chain.slice(1)}</div>
                    <code>{configured ? "연결됨" : "미설정"}</code>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── 프로토콜 플래그 ── */}
        <section className="net-settings-section">
          <p className="net-settings-section-title">프로토콜 Live 플래그</p>
          <div className="net-settings-protocol-list">
            {PROTOCOLS.map((protocol) => {
              const configured = runtime?.configuredLiveAdapterFlags?.[protocol] ?? false;
              const effective = runtime?.liveAdapterFlags?.[protocol] ?? false;
              const source = runtime?.liveAdapterFlagSources?.[protocol] ?? "env";
              const readiness = readinessMap?.[protocol];
              const loading = flagLoading === protocol;
              const canEnable = canToggle && (readiness?.implemented ?? false) && !configured;
              const canDisable = canToggle && configured;
              const meta = PROTOCOL_META[protocol];

              return (
                <div key={protocol} className={`net-settings-protocol-row${!readiness?.implemented ? " row--unimpl" : ""}`}>
                  <div className="net-settings-protocol-info">
                    <div className="protocol-name-row">
                      <span className="protocol-label">{meta.label}</span>
                      <span className="protocol-chain">{meta.chain}</span>
                      <ReadinessChip readiness={readiness} />
                    </div>
                    <div className="protocol-status-row">
                      <span className={`protocol-badge${effective ? " badge--live" : " badge--dry"}`}>
                        {effective ? "LIVE" : "dry-run"}
                      </span>
                      <span className="protocol-source">{source}</span>
                      {readiness && !readiness.ready && readiness.blockers.length > 0 && (
                        <span className="protocol-blocker" title={readiness.blockers.join(", ")}>
                          ⚠ {readiness.blockers[0]}{readiness.blockers.length > 1 ? ` 외 ${readiness.blockers.length - 1}개` : ""}
                        </span>
                      )}
                    </div>
                  </div>
                  {canToggle && (
                    <div className="net-settings-protocol-btns">
                      <button
                        type="button"
                        className={`toggle-btn${configured ? " active" : ""}`}
                        onClick={() => void toggleProtocol(protocol, true)}
                        disabled={loading || !canEnable}
                        title={!readiness?.implemented ? "어댑터 미구현" : !readiness.ready ? readiness.blockers.join(", ") : undefined}
                      >
                        ON
                      </button>
                      <button
                        type="button"
                        className={`toggle-btn${!configured ? " active" : ""}`}
                        onClick={() => void toggleProtocol(protocol, false)}
                        disabled={loading || !canDisable}
                      >
                        OFF
                      </button>
                      {loading && <span className="net-settings-spinner">⟳</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {error && <p className="net-settings-error">{error}</p>}
      </div>
    </div>
  );
}
