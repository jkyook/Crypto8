/**
 * 전역 상수 모음 — 매직 넘버/매직 문자열 한 곳에서 관리.
 * 개별 값을 바꿀 때 파급 범위를 쉽게 추적하기 위한 목적.
 */

/** 인출 계산 시 위상오차 허용 (부동소수 비교용). */
export const WITHDRAW_EPSILON_USD = 0.000001;

/** 포트폴리오 상단 알림 자동 소멸까지의 시간 (ms). */
export const PORTFOLIO_NOTICE_AUTO_DISMISS_MS = 8_000;

/** 시장 APR 스냅샷 재조회 주기 (ms) — 10분. */
export const MARKET_APR_REFRESH_MS = 10 * 60 * 1000;

/** 인출 완료 토스트 유지 시간 (ms). */
export const WITHDRAW_DONE_TOAST_MS = 5_000;

/** 기본 상품 targetApr로 사용하는 8% (0.08). */
export const DEFAULT_TARGET_APR = 0.08;

/** Orca live 실행 시 최소 배분 금액(USD). */
export const ORCA_MIN_LIVE_ALLOCATION_USD = 25;

/** APR을 기간 수익률로 환산할 때 기준으로 쓰는 연간 일수. */
export const APR_DAYS_PER_YEAR = 365;

/** 비로그인 사용자의 가상 출금 장부 로컬 스토리지 키. */
export const GUEST_WITHDRAW_LEDGER_KEY = "crypto8_withdraw___guest__";

/** 포트폴리오 도넛 차트 기본 색상. */
export const PORTFOLIO_DONUT_COLORS = ["#8b7bff", "#3bd4ff", "#47d9a8", "#ffb86b"] as const;

/**
 * 프로토콜 노출표에서 기본 정렬 우선순위.
 * 인덱스가 낮을수록 상단에 위치.
 */
export const PROTOCOL_SORT_ORDER = ["Aave", "Uniswap", "Orca"] as const;
