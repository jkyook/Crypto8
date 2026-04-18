import type { DepositPositionPayload } from "./api";
import { aggregateChainUsdFromPositions, estimateAnnualYieldUsd, inferChainFromMix } from "./portfolioMetrics";

export type PortfolioRiskLevel = "Low" | "Medium" | "High" | "Critical";

export type RebalanceHint = {
  from: string;
  to: string;
  amountUsd: number;
  reason: string;
  priority: "normal" | "high" | "urgent";
};

export type PortfolioRiskAssessment = {
  totalUsd: number;
  estimatedAnnualYieldUsd: number;
  estimatedApy: number;
  riskScore: number;
  riskLevel: PortfolioRiskLevel;
  primaryAction: string;
  reasons: string[];
  protocolExposure: Array<{ name: string; amountUsd: number; weight: number }>;
  chainExposure: Array<{ chain: string; amountUsd: number; weight: number }>;
  rebalanceHints: RebalanceHint[];
  controls: Array<{ label: string; status: "ok" | "watch" | "action"; detail: string }>;
};

const TARGET_CHAIN_WEIGHT: Record<string, number> = {
  Arbitrum: 0.6,
  Solana: 0.2,
  Base: 0.15,
  Multi: 0.05
};

function toRiskLevel(score: number): PortfolioRiskLevel {
  if (score >= 75) return "Critical";
  if (score >= 50) return "High";
  if (score >= 25) return "Medium";
  return "Low";
}

function pushReason(reasons: string[], condition: boolean, reason: string): number {
  if (!condition) return 0;
  reasons.push(reason);
  return 1;
}

function summarizeProtocolExposure(positions: DepositPositionPayload[], totalUsd: number) {
  const totals: Record<string, number> = {};
  for (const pos of positions) {
    for (const mix of pos.protocolMix) {
      const amount = pos.amountUsd * mix.weight;
      totals[mix.name] = (totals[mix.name] ?? 0) + amount;
    }
  }
  return Object.entries(totals)
    .map(([name, amountUsd]) => ({ name, amountUsd, weight: totalUsd > 0 ? amountUsd / totalUsd : 0 }))
    .sort((a, b) => b.amountUsd - a.amountUsd);
}

function summarizeChainExposure(positions: DepositPositionPayload[], totalUsd: number) {
  const totals = aggregateChainUsdFromPositions(positions);
  return Object.entries(totals)
    .map(([chain, amountUsd]) => ({ chain, amountUsd, weight: totalUsd > 0 ? amountUsd / totalUsd : 0 }))
    .sort((a, b) => b.amountUsd - a.amountUsd);
}

function buildRebalanceHints(
  protocolExposure: Array<{ name: string; amountUsd: number; weight: number }>,
  chainExposure: Array<{ chain: string; amountUsd: number; weight: number }>,
  totalUsd: number,
  estimatedApy: number
): RebalanceHint[] {
  if (totalUsd <= 0) return [];
  const hints: RebalanceHint[] = [];
  const topProtocol = protocolExposure[0];
  if (topProtocol && topProtocol.weight > 0.35) {
    hints.push({
      from: topProtocol.name,
      to: "Aave/Orca/Cash buffer",
      amountUsd: totalUsd * Math.min(topProtocol.weight - 0.3, 0.15),
      reason: "단일 프로토콜 노출이 35%를 초과합니다.",
      priority: topProtocol.weight > 0.5 ? "urgent" : "high"
    });
  }

  const topChain = chainExposure[0];
  if (topChain && topChain.weight > 0.6) {
    hints.push({
      from: topChain.chain,
      to: "Base/Solana/Multi chain buffer",
      amountUsd: totalUsd * Math.min(topChain.weight - 0.55, 0.2),
      reason: "단일 체인 노출이 60%를 초과합니다.",
      priority: topChain.weight > 0.75 ? "urgent" : "high"
    });
  }

  if (estimatedApy < 0.04 && totalUsd > 0) {
    hints.push({
      from: "Low-yield allocation",
      to: "검증된 lending/LP 후보",
      amountUsd: Math.min(totalUsd * 0.2, 5_000),
      reason: "추정 APY가 4% 미만입니다. 수익 대비 리스크가 낮은 대체 후보를 비교하세요.",
      priority: "normal"
    });
  }

  return hints.slice(0, 3);
}

function buildControls(assessment: {
  totalUsd: number;
  maxProtocolWeight: number;
  maxChainWeight: number;
  estimatedApy: number;
  stalePositionCount: number;
}) {
  return [
    {
      label: "단일 프로토콜 한도",
      status: assessment.maxProtocolWeight > 0.5 ? "action" : assessment.maxProtocolWeight > 0.35 ? "watch" : "ok",
      detail:
        assessment.totalUsd <= 0
          ? "예치 후 자동 계산"
          : `최대 ${(assessment.maxProtocolWeight * 100).toFixed(1)}% 노출`
    },
    {
      label: "단일 체인 한도",
      status: assessment.maxChainWeight > 0.75 ? "action" : assessment.maxChainWeight > 0.6 ? "watch" : "ok",
      detail:
        assessment.totalUsd <= 0
          ? "예치 후 자동 계산"
          : `최대 ${(assessment.maxChainWeight * 100).toFixed(1)}% 노출`
    },
    {
      label: "수익률 품질",
      status: assessment.estimatedApy < 0.03 && assessment.totalUsd > 0 ? "watch" : "ok",
      detail: assessment.totalUsd <= 0 ? "포지션 없음" : `명목 APY ${(assessment.estimatedApy * 100).toFixed(2)}%`
    },
    {
      label: "데이터 신선도",
      status: assessment.stalePositionCount > 0 ? "watch" : "ok",
      detail: assessment.stalePositionCount > 0 ? `${assessment.stalePositionCount}개 포지션 점검 필요` : "최근 포지션 기준 정상"
    }
  ] as const;
}

export function assessPortfolioRisk(positions: DepositPositionPayload[]): PortfolioRiskAssessment {
  const totalUsd = positions.reduce((acc, p) => acc + p.amountUsd, 0);
  const estimatedAnnualYieldUsd = estimateAnnualYieldUsd(positions);
  const estimatedApy = totalUsd > 0 ? estimatedAnnualYieldUsd / totalUsd : 0;
  const protocolExposure = summarizeProtocolExposure(positions, totalUsd);
  const chainExposure = summarizeChainExposure(positions, totalUsd);
  const maxProtocolWeight = protocolExposure[0]?.weight ?? 0;
  const maxChainWeight = chainExposure[0]?.weight ?? 0;
  const stalePositionCount = positions.filter((p) => Date.now() - new Date(p.createdAt).getTime() > 1000 * 60 * 60 * 24 * 30).length;

  const reasons: string[] = [];
  let score = 0;
  score += pushReason(reasons, totalUsd <= 0, "아직 예치 포지션이 없어 실제 리스크를 계산할 수 없습니다.") * 5;
  score += pushReason(reasons, maxProtocolWeight > 0.35, "단일 프로토콜 노출이 권장 기준(35%)을 초과했습니다.") * 20;
  score += pushReason(reasons, maxProtocolWeight > 0.5, "단일 프로토콜 노출이 50%를 초과해 집중 위험이 큽니다.") * 20;
  score += pushReason(reasons, maxChainWeight > 0.6, "단일 체인 노출이 권장 기준(60%)을 초과했습니다.") * 18;
  score += pushReason(reasons, maxChainWeight > 0.75, "단일 체인 장애·혼잡에 취약한 구조입니다.") * 17;
  score += pushReason(reasons, estimatedApy > 0.18, "명목 APY가 높아 보상 지속성·풀 리스크 검증이 필요합니다.") * 12;
  score += pushReason(reasons, stalePositionCount > 0, "30일 이상 경과한 포지션은 APR·유동성 재점검이 필요합니다.") * 10;

  if (reasons.length === 0) {
    reasons.push("노출 집중도와 명목 수익률이 1차 기준 안에 있습니다.");
  }

  const rebalanceHints = buildRebalanceHints(protocolExposure, chainExposure, totalUsd, estimatedApy);
  const riskScore = Math.min(100, score);
  const riskLevel = toRiskLevel(riskScore);
  const primaryAction =
    totalUsd <= 0
      ? "예치 후 운영 관제 지표가 활성화됩니다."
      : rebalanceHints.length > 0
        ? "리밸런싱 후보를 검토하고 실행 전 dry-run을 확인하세요."
        : "현재 배분은 1차 가드레일 안에 있습니다. 다음 분기 점검까지 모니터링하세요.";

  return {
    totalUsd,
    estimatedAnnualYieldUsd,
    estimatedApy,
    riskScore,
    riskLevel,
    primaryAction,
    reasons,
    protocolExposure,
    chainExposure,
    rebalanceHints,
    controls: [...buildControls({ totalUsd, maxProtocolWeight, maxChainWeight, estimatedApy, stalePositionCount })]
  };
}

export function getTargetChainWeight(chain: string): number {
  return TARGET_CHAIN_WEIGHT[chain] ?? 0;
}

export function describePositionChainMix(position: DepositPositionPayload): string {
  const chains = new Set(position.protocolMix.map((mix) => inferChainFromMix(mix)));
  return Array.from(chains).join(" / ");
}
