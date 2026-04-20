export function AgentConsensusPanel() {
  return (
    <section className="card consensus-card">
      <h2>에이전트 합의 개선안</h2>
      <div className="kpi-grid">
        <div className="kpi-item">
          <p className="kpi-label">디자인 에이전트</p>
          <p className="kpi-value">실행 버튼 단계 분리 + 상태 배지 강화</p>
        </div>
        <div className="kpi-item">
          <p className="kpi-label">보안 에이전트</p>
          <p className="kpi-value">실행 이벤트 추적 + 재실행 멱등성 강제</p>
        </div>
        <div className="kpi-item">
          <p className="kpi-label">운용 에이전트</p>
          <p className="kpi-value">실행 흐름 자동 모니터링(이벤트 대시보드)</p>
        </div>
        <div className="kpi-item">
          <p className="kpi-label">컨설턴트 에이전트</p>
          <p className="kpi-value">프로토콜 위험 점검 + 파라미터 조정 권고</p>
        </div>
      </div>
    </section>
  );
}
