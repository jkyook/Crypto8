export function TradeControls({
  onDeposit,
  onWithdraw,
  disabled,
  size = "compact"
}: {
  onDeposit: () => void;
  onWithdraw: () => void;
  disabled?: boolean;
  size?: "compact" | "large";
}) {
  return (
    <div className={`inline-trade-controls inline-trade-controls--${size}`} aria-label="입금 인출">
      <button type="button" className="inline-trade-btn inline-trade-btn-plus" onClick={onDeposit} disabled={disabled} aria-label="입금">
        +
      </button>
      <button type="button" className="inline-trade-btn inline-trade-btn-minus" onClick={onWithdraw} disabled={disabled} aria-label="인출">
        -
      </button>
    </div>
  );
}
