import type { AgentTask, RiskLevel } from "../types";

type RunContext = {
  isSecurityApproved: boolean;
  isRangeOut: boolean;
  isDepegAlert: boolean;
  hasPendingRelease: boolean;
};

export function evaluateRisk(context: RunContext): RiskLevel {
  if (context.isDepegAlert) {
    return "Critical";
  }
  if (context.isRangeOut || !context.isSecurityApproved) {
    return "High";
  }
  if (context.hasPendingRelease) {
    return "Medium";
  }
  return "Low";
}

export function buildAgentTasks(context: RunContext): AgentTask[] {
  const tasks: AgentTask[] = [];

  tasks.push({
    agent: "Strategy-PM",
    priority: "P1",
    objective: "분기 기준 리밸런싱 정책과 파라미터 최신화",
    doneDefinition: "가드레일 위반 없는 신규 정책 문서 제출"
  });

  tasks.push({
    agent: "Yield-Operator",
    priority: context.isRangeOut ? "P0" : "P1",
    objective: context.isRangeOut
      ? "ETH-USDC 범위 이탈 포지션 재설정안 생성"
      : "목표 비중 대비 편차 점검 및 주문서 초안 생성",
    doneDefinition: "예상 비용/수익 개선 포함 주문 목록 제출"
  });

  tasks.push({
    agent: "Protocol-Engineer",
    priority: context.hasPendingRelease ? "P1" : "P2",
    objective: "예치 플로우와 전략 실행 API 안정화",
    doneDefinition: "실패 재시도 및 에러 핸들링 테스트 통과"
  });

  tasks.push({
    agent: "Security-Guardian",
    priority: "P0",
    objective: "권한/본인 확인/서명 플로우 점검 및 실행 가능 여부 판단",
    doneDefinition: "취약점 등급과 본인 확인 기준 포함 결과 제출"
  });

  tasks.push({
    agent: "Growth-Marketer",
    priority: "P3",
    objective: "예치 전환율 개선 실험 1건 실행",
    doneDefinition: "2주 실험 KPI 리포트 제출"
  });

  return tasks;
}
