import { useEffect, useState } from "react";
import { fetchMarketAprSnapshot, fetchPoolApyHistoryFromCsv, type MarketAprSnapshot, type MarketPoolAprHistoryPoint, type MarketPoolAprHistorySeries } from "../lib/api";
import { MARKET_APR_REFRESH_MS } from "../lib/constants";

type UseMarketAprResult = {
  marketApr: MarketAprSnapshot | null;
  morphoApy: number | null;
  aprError: string;
  marketHistoryPoints: MarketPoolAprHistoryPoint[];
  marketHistorySeries: MarketPoolAprHistorySeries[];
  historyCsvDays: number;
  setHistoryCsvDays: (days: number) => void;
};

export function useMarketApr(selectedPoolLabels: string[]): UseMarketAprResult {
  const [marketApr, setMarketApr] = useState<MarketAprSnapshot | null>(null);
  const [aprError, setAprError] = useState("");
  const [marketHistoryPoints, setMarketHistoryPoints] = useState<MarketPoolAprHistoryPoint[]>([]);
  const [marketHistorySeries, setMarketHistorySeries] = useState<MarketPoolAprHistorySeries[]>([]);
  const [historyCsvDays, setHistoryCsvDays] = useState(90);
  const morphoApy = marketApr?.morpho ?? null;

  useEffect(() => {
    let cancelled = false;
    const loadAprAndHistory = async () => {
      try {
        setAprError("");
        const snapshot = await fetchMarketAprSnapshot();
        if (!cancelled) setMarketApr(snapshot);
      } catch (error) {
        if (!cancelled) {
          setAprError(error instanceof Error ? error.message : "실시간 이율 조회 실패");
          setMarketApr(null);
        }
      }
      try {
        const hist = await fetchPoolApyHistoryFromCsv({ days: historyCsvDays, pools: selectedPoolLabels });
        if (!cancelled) {
          setMarketHistoryPoints(hist.points);
          setMarketHistorySeries(hist.series);
        }
      } catch {
        if (!cancelled) {
          setMarketHistoryPoints([]);
          setMarketHistorySeries([]);
        }
      }
    };
    void loadAprAndHistory();
    const timer = window.setInterval(() => void loadAprAndHistory(), MARKET_APR_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [historyCsvDays, selectedPoolLabels]);

  return {
    marketApr,
    morphoApy,
    aprError,
    marketHistoryPoints,
    marketHistorySeries,
    historyCsvDays,
    setHistoryCsvDays
  };
}
