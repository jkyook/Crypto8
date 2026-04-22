import type { DepositPosition, ProtocolDetailRow } from "../types/portfolio";
import { WITHDRAW_EPSILON_USD } from "./constants";
import { inferProtocolChain } from "./protocolChain";

/**
 * LIFO 방식으로 예치 포지션을 amountUsd 만큼 차감.
 * 최근 예치부터 먼저 차감하며, 남은 잔액이 없는 포지션은 제거한다.
 */
export function applyLifoWithdraw(positions: DepositPosition[], amountUsd: number): DepositPosition[] {
  let remaining = Math.max(0, amountUsd);
  const sorted = [...positions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const kept: DepositPosition[] = [];
  for (const p of sorted) {
    if (remaining <= 0) {
      kept.push(p);
      continue;
    }
    if (p.amountUsd <= remaining) {
      remaining -= p.amountUsd;
    } else {
      kept.push({ ...p, amountUsd: p.amountUsd - remaining });
      remaining = 0;
    }
  }
  return kept;
}

/**
 * 특정 프로토콜/체인/풀 노출분만 선택적으로 차감.
 * 포지션 내부의 protocolMix weight를 재정규화하며,
 * 차감 후 amountUsd가 오차 이하가 되면 포지션을 제거한다.
 */
export function applyTargetedWithdraw(
  positions: DepositPosition[],
  amountUsd: number,
  target: Pick<ProtocolDetailRow, "name" | "chain" | "pool">
): DepositPosition[] {
  let remaining = amountUsd;
  const next: DepositPosition[] = [];
  const matchesTarget = (mix: { name: string; pool?: string }) =>
    mix.name.toLowerCase() === target.name.toLowerCase() &&
    inferProtocolChain(mix.name, mix.pool).toLowerCase() === target.chain.toLowerCase() &&
    (mix.pool ?? "").trim().toLowerCase() === target.pool.trim().toLowerCase();

  for (const position of positions) {
    if (remaining <= 0) {
      next.push(position);
      continue;
    }
    const absoluteMix = position.protocolMix.map((mix) => ({
      mix,
      amountUsd: position.amountUsd * mix.weight
    }));
    let withdrawnFromPosition = 0;
    for (const item of absoluteMix) {
      if (remaining <= 0) break;
      if (!matchesTarget(item.mix)) continue;
      const take = Math.min(item.amountUsd, remaining);
      item.amountUsd -= take;
      withdrawnFromPosition += take;
      remaining -= take;
    }
    if (withdrawnFromPosition <= 0) {
      next.push(position);
      continue;
    }
    const nextAmount = position.amountUsd - withdrawnFromPosition;
    if (nextAmount <= WITHDRAW_EPSILON_USD) continue;
    next.push({
      ...position,
      amountUsd: nextAmount,
      protocolMix: absoluteMix
        .filter((item) => item.amountUsd > WITHDRAW_EPSILON_USD)
        .map((item) => ({
          ...item.mix,
          weight: item.amountUsd / nextAmount
        }))
    });
  }
  return next;
}

/**
 * 특정 상품(productName) 포지션만 LIFO 없이 순차 차감.
 * 동일 productName의 포지션만 대상이 된다.
 */
export function applyProductWithdraw(
  positions: DepositPosition[],
  amountUsd: number,
  productName: string
): DepositPosition[] {
  let remaining = amountUsd;
  const kept: DepositPosition[] = [];
  for (const position of positions) {
    if (remaining <= 0 || position.productName !== productName) {
      kept.push(position);
      continue;
    }
    if (position.amountUsd <= remaining) {
      remaining -= position.amountUsd;
    } else {
      kept.push({ ...position, amountUsd: position.amountUsd - remaining });
      remaining = 0;
    }
  }
  return kept;
}
