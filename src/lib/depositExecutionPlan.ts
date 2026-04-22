import type { DepositSwapPlanRow } from "./depositAssetPlan";
import type { ExecutionPreviewRow } from "./executionPreview";

export type DepositExecutionPlanStepKind = "review" | "bridge" | "swap" | "approve" | "deposit";

export type DepositExecutionPlanStep = {
  order: number;
  kind: DepositExecutionPlanStepKind;
  title: string;
  detail: string;
  route?: string;
  protocol?: string;
  chain?: string;
  action?: string;
  amountUsd?: number;
  requiresWalletApproval: boolean;
};

function protocolStepTitles(protocol: string): { approve: string; deposit: string } {
  switch (protocol) {
    case "Aave":
      return { approve: "토큰 승인", deposit: "Aave 공급" };
    case "Uniswap":
      return { approve: "토큰 승인", deposit: "Uniswap LP 민트" };
    case "Orca":
      return { approve: "지갑 승인", deposit: "Orca Whirlpool 예치" };
    case "Aerodrome":
      return { approve: "토큰 승인", deposit: "Aerodrome Slipstream 예치" };
    case "Raydium":
      return { approve: "토큰 승인", deposit: "Raydium CLMM 예치" };
    case "Curve":
      return { approve: "토큰 승인", deposit: "Curve 풀 예치" };
    default:
      return { approve: "토큰 승인", deposit: "프로토콜 예치" };
  }
}

function describePreparation(row: DepositSwapPlanRow): string {
  const parts: string[] = [];
  if (row.needsTransfer) parts.push("브릿지/전송");
  if (row.needsSwap) parts.push("스왑");
  if (parts.length === 0) {
    return "추가 변환 없이 바로 실행 가능";
  }
  return `${parts.join(" → ")} 후 실행`;
}

export function buildDepositExecutionPlan(rows: DepositSwapPlanRow[], quoteRows: ExecutionPreviewRow[]): DepositExecutionPlanStep[] {
  const steps: DepositExecutionPlanStep[] = [
    {
      order: 1,
      kind: "review",
      title: "배분안 승인",
      detail: "리스크 검토 후 순차 실행을 시작합니다.",
      requiresWalletApproval: false
    }
  ];

  rows.forEach((row, idx) => {
    const quoteRow = quoteRows[idx];
    const titles = protocolStepTitles(row.protocol);
    if (row.needsTransfer) {
      steps.push({
        order: 0,
        kind: "bridge",
        title: `${row.target} 브릿지/전송`,
        detail: `${row.sourceAsset} ${row.sourceChain} → ${row.requiredAssets.join("/")} ${row.chain} · ${describePreparation(row)}`,
        route: row.route,
        protocol: row.protocol,
        chain: row.chain,
        action: row.action,
        amountUsd: row.requiredUsd,
        requiresWalletApproval: true
      });
    }

    if (row.needsSwap) {
      steps.push({
        order: 0,
        kind: "swap",
        title: `${row.target} 스왑`,
        detail: `${row.sourceAsset}를(을) ${row.requiredAssets.join("/")}로 맞춘 뒤 예치합니다.`,
        route: row.route,
        protocol: row.protocol,
        chain: row.chain,
        action: row.action,
        amountUsd: row.requiredUsd,
        requiresWalletApproval: true
      });
    }

    steps.push({
      order: 0,
      kind: "approve",
      title: `${row.target} ${titles.approve}`,
      detail: `${quoteRow ? `${quoteRow.allocationUsd.toFixed(2)} USD 배분` : `${row.requiredUsd.toFixed(2)} USD 배분`}에 대한 지갑 승인입니다.`,
      route: row.route,
      protocol: row.protocol,
      chain: row.chain,
      action: row.action,
      amountUsd: row.requiredUsd,
      requiresWalletApproval: true
    });

    steps.push({
      order: 0,
      kind: "deposit",
      title: `${row.target} ${titles.deposit}`,
      detail: `${row.requiredAssets.join("/")} 준비 후 최종 예치합니다.`,
      route: row.route,
      protocol: row.protocol,
      chain: row.chain,
      action: row.action,
      amountUsd: row.requiredUsd,
      requiresWalletApproval: true
    });
  });

  return steps.map((step, index) => ({ ...step, order: index + 1 }));
}
