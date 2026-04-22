import type { AuthSession } from "./api";

export type MenuKey =
  | "my"
  | "products"
  | "trade"
  | "portfolio"
  | "auth"
  | "wallet"
  | "execution"
  | "operationsLog"
  | "activity"
  | "consensus"
  | "consultant"
  | "signupHistory";

export type UserRole = AuthSession["role"];

export type MenuItem = {
  key: MenuKey;
  label: string;
  icon: string;
  group: "operation" | "strategy" | "governance";
  roles: UserRole[];
};

export type TopNavGroupKey = "more";

export const PRIMARY_NAV_ORDER: MenuKey[] = ["my", "products", "portfolio", "execution"];

export const PRIMARY_NAV_LABEL: Partial<Record<MenuKey, string>> = {
  my: "Dashboard",
  products: "Pools",
  portfolio: "Positions",
  execution: "Execution",
  trade: "Swap"
};

export const MENU_ITEMS: MenuItem[] = [
  { key: "my", label: "내 현황", icon: "🙋", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "products", label: "예치상품", icon: "🧺", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "trade", label: "Trade", icon: "🔄", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "portfolio", label: "Portfolio", icon: "📊", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "wallet", label: "지갑/자산", icon: "👛", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "execution", label: "예치 실행", icon: "🧭", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "operationsLog", label: "수익/운영 이력", icon: "📜", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "activity", label: "활동 피드", icon: "🕘", group: "operation", roles: ["orchestrator", "security", "viewer"] },
  { key: "consultant", label: "컨설턴트 인사이트", icon: "🧠", group: "governance", roles: ["orchestrator", "security"] },
  { key: "signupHistory", label: "회원가입 내역", icon: "📋", group: "governance", roles: ["orchestrator"] },
  { key: "auth", label: "로그인 · 계정", icon: "🔐", group: "governance", roles: ["orchestrator", "security", "viewer"] },
  { key: "consensus", label: "에이전트 합의", icon: "🤝", group: "governance", roles: ["orchestrator", "security", "viewer"] }
];
