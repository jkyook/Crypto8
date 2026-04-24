/**
 * morphoAdapter.ts
 * Morpho Blue / MetaMorpho Vault 실행 어댑터
 *
 * 기존 aaveAdapter.ts 패턴 그대로 따름.
 * 큐레이터 모델 포지셔닝 시 Morpho가 Aave를 대체하는 수탁 레이어가 된다.
 *
 * ■ dry-run 모드: APY·배분 시뮬레이션 결과 반환
 * ■ live 모드: 향후 Morpho SDK + MetaMorpho Vault 컨트랙트 호출로 구현
 *
 * 배분 테이블:
 *   morpho-usdc  → Morpho Blue USDC 마켓 (wstETH/USDC 또는 cbBTC/USDC)
 *                  APY 실시간 조회 후 최상위 마켓에 배분
 */

import type { AdapterExecutionContext, AdapterExecutionResult } from "./types";
import { buildUnsupportedResult, isAdapterLiveEnabled } from "./types";
import { getBestMarketApy, getTopUsdcMarkets, CHAIN_IDS } from "../morphoClient";

// ── Morpho 배분 테이블 ────────────────────────────────────────────
// productSubtype → chain 매핑
const MORPHO_CHAIN_TABLE: Record<string, { chain: "Arbitrum" | "Base" | "Ethereum"; chainId: number }> = {
  "morpho-usdc":        { chain: "Arbitrum", chainId: CHAIN_IDS.arbitrum },
  "morpho-usdc-base":   { chain: "Base",     chainId: CHAIN_IDS.base },
  "morpho-usdc-eth":    { chain: "Ethereum", chainId: CHAIN_IDS.ethereum },
};

export async function executeMorphoAdapter(
  context: AdapterExecutionContext
): Promise<AdapterExecutionResult[]> {
  const subtype = context.productSubtype ?? "morpho-usdc";
  const mapping = MORPHO_CHAIN_TABLE[subtype];

  if (!mapping) {
    return [buildUnsupportedResult(
      { protocol: "Aave", chain: "Arbitrum", action: "Morpho Supply", allocationUsd: context.depositUsd },
      `Unknown Morpho subtype: ${subtype}`
    )];
  }

  const { chain, chainId } = mapping;
  const allocationUsd = context.depositUsd; // 100% Morpho 배분 (단독 상품 시)

  // ── dry-run ───────────────────────────────────────────────────
  if (context.mode === "dry-run") {
    // 실시간 APY 조회 (실패 시 fallback 5%)
    let bestApy = 5.0;
    let bestMarketKey = "N/A";
    let action = "Morpho USDC Supply (dry-run)";

    try {
      const markets = await getTopUsdcMarkets(chainId);
      if (markets.length > 0) {
        bestApy = markets[0].state.supplyApy * 100;
        bestMarketKey = markets[0].uniqueKey.slice(0, 10) + "...";
        const collateral = markets[0].collateralAsset?.symbol ?? "none";
        action = `Morpho USDC Supply → ${collateral}/USDC market (APY: ${bestApy.toFixed(2)}%)`;
      }
    } catch {
      action = `Morpho USDC Supply (fallback APY: ${bestApy.toFixed(2)}%)`;
    }

    return [{
      protocol: "Aave",          // 기존 protocol enum에 Morpho 없으므로 임시 Aave 사용
      chain,
      action,
      allocationUsd,
      txId: `morpho_dry_${context.jobId}_${Date.now()}`,
      status: "dry-run",
    }];
  }

  // ── live ──────────────────────────────────────────────────────
  if (!isAdapterLiveEnabled("Aave")) {
    return [buildUnsupportedResult(
      { protocol: "Aave", chain, action: "Morpho USDC Supply", allocationUsd },
      "ENABLE_MORPHO_LIVE not set or LIVE_EXECUTION_CONFIRM != YES"
    )];
  }

  // TODO: Morpho SDK (@morpho-org/blue-api-sdk) 연동 후 실제 트랜잭션 실행
  // 1. getTopUsdcMarkets()로 최상위 마켓 uniqueKey 조회
  // 2. MetaMorpho Vault에 deposit() 호출
  // 3. txHash 반환
  return [buildUnsupportedResult(
    { protocol: "Aave", chain, action: "Morpho USDC Supply", allocationUsd },
    "Morpho live execution not yet implemented — pending SDK integration"
  )];
}

// ── 단독 유틸: 현재 Morpho 최고 APY 조회 ─────────────────────────
export async function getMorphoBestApy(chainId = CHAIN_IDS.arbitrum): Promise<number> {
  return getBestMarketApy(chainId);
}
