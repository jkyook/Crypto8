/** 오늘 기준 다음 분기 시작일(1/4/7/10월 1일). */
export function getNextQuarterStart(date = new Date()): Date {
  const y = date.getFullYear();
  const m = date.getMonth();
  const q = Math.floor(m / 3);
  let nextM = (q + 1) * 3;
  let nextY = y;
  if (nextM >= 12) {
    nextM = 0;
    nextY = y + 1;
  }
  return new Date(nextY, nextM, 1);
}
