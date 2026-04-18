/** 시장 APR 행(aave/uniswap/orca)에 프로토콜 mix 가중을 적용한 연 APR(소수). */
export function blendedAprDecimalFromMix(
  row: { aave: number; uniswap: number; orca: number },
  protocolMix: Array<{ name: string; weight: number }>
): number {
  return protocolMix.reduce((acc, item) => {
    const key = item.name.toLowerCase();
    const dec = key.includes("aave") ? row.aave : key.includes("uniswap") ? row.uniswap : row.orca;
    return acc + dec * item.weight;
  }, 0);
}
