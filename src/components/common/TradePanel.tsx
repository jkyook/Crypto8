export function TradePanel() {
  return (
    <section className="card">
      <p>우선 외부 DeFi를 사용해 토큰 교환을 진행합니다.</p>
      <div className="button-row">
        <button onClick={() => window.open("https://www.orca.so/pools", "_blank", "noopener,noreferrer")}>Orca 열기</button>
        <button onClick={() => window.open("https://app.uniswap.org/", "_blank", "noopener,noreferrer")}>Uniswap 열기</button>
      </div>
    </section>
  );
}
