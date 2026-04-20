import { useState } from "react";
import { fetchProtocolNews, type ProtocolNewsBundle } from "../../lib/api";

const PROTOCOL_CARDS = [
  {
    name: "Aave (Arbitrum/Base)",
    risk: "Low",
    note: "유동성 충분. 운영 우선순위: 유지",
    details: "수수료 안정적, 변동성 낮음, 재예치 자동화 적합"
  },
  {
    name: "Uniswap V3 (Arbitrum)",
    risk: "Medium",
    note: "틱 범위/슬리피지 상시 점검 필요",
    details: "최근 체결 빈도 높음, 수수료 수익 우수, 범위 이탈 모니터링 필수"
  },
  {
    name: "Orca (Solana)",
    risk: "Medium",
    note: "체인 혼잡/중단 시 fallback 계획 필요",
    details: "체인 상태 의존도 높음, 수수료 경쟁력 양호, 장애 대응 런북 필요"
  }
];

export function ConsultantInsightsPanel() {
  const [selectedProtocol, setSelectedProtocol] = useState<string>("");
  const [newsBundle, setNewsBundle] = useState<ProtocolNewsBundle | null>(null);
  const [isNewsLoading, setIsNewsLoading] = useState(false);
  const [newsError, setNewsError] = useState("");

  const onSelectProtocol = async (protocolName: string) => {
    setSelectedProtocol(protocolName);
    setIsNewsLoading(true);
    setNewsError("");
    setNewsBundle(null);
    try {
      const bundle = await fetchProtocolNews(protocolName);
      setNewsBundle(bundle);
    } catch (error) {
      setNewsBundle(null);
      setNewsError(error instanceof Error ? error.message : "뉴스 조회 실패");
    } finally {
      setIsNewsLoading(false);
    }
  };

  return (
    <section className="card">
      <h2>컨설턴트 인사이트</h2>
      <p>핵심 프로토콜 점검 기준으로 현재 전략의 우선 조정 항목을 제시합니다.</p>
      <div className="kpi-grid protocol-grid">
        {PROTOCOL_CARDS.map((card) => (
          <button key={card.name} className="kpi-item protocol-card" onClick={() => onSelectProtocol(card.name)}>
            <p className="kpi-label">{card.name}</p>
            <p className="kpi-value">리스크: {card.risk}</p>
            <p>{card.note}</p>
            <div className="protocol-hover-detail">{card.details}</div>
          </button>
        ))}
      </div>
      {selectedProtocol ? (
        <div className="card protocol-news-panel" style={{ marginTop: 12 }}>
          <h3>{selectedProtocol} — 최근 동향 요약</h3>
          <p className="protocol-news-lead">뉴스·거버넌스 RSS·GDELT·Reddit 등을 넓게 모은 뒤, 중복을 줄이고 요약합니다.</p>
          {isNewsLoading ? <p>뉴스 조회 중...</p> : null}
          {newsError ? <p>{newsError}</p> : null}
          {!isNewsLoading && !newsError && newsBundle ? (
            <>
              {newsBundle.digest ? (
                <div className="protocol-news-digest" role="region" aria-label="요약">
                  {newsBundle.digest}
                </div>
              ) : null}
              {newsBundle.scannedSources.length > 0 ? (
                <p className="protocol-news-sources">수집에 사용한 소스 태그: {newsBundle.scannedSources.join(" · ")}</p>
              ) : null}
              <h4 className="protocol-news-links-title">근거 링크</h4>
              <div className="recent-list">
                {newsBundle.items.map((item, idx) => (
                  <a key={`${item.url}-${idx}`} className="recent-item" href={item.url} target="_blank" rel="noreferrer">
                    <span className="recent-main">{item.title}</span>
                    <span className="recent-sub">
                      {item.source} · {item.publishedAt ? new Date(item.publishedAt).toLocaleString() : "시간 정보 없음"}
                    </span>
                  </a>
                ))}
                {newsBundle.items.length === 0 ? <p className="recent-empty">표시할 링크가 없습니다. 요약·참고 허브만 확인해 주세요.</p> : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
