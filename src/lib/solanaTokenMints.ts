import type { AccountAssetSymbol } from "./api";

export const SOLANA_TOKEN_MINTS: Record<Extract<AccountAssetSymbol, "USDC" | "USDT" | "SOL" | "MSOL">, string> = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  SOL: "So11111111111111111111111111111111111111112",
  MSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"
};

export const SOLANA_TOKEN_DECIMALS: Record<keyof typeof SOLANA_TOKEN_MINTS, number> = {
  USDC: 6,
  USDT: 6,
  SOL: 9,
  MSOL: 9
};

export function resolveSolanaTokenMint(symbol: Extract<AccountAssetSymbol, "USDC" | "USDT" | "SOL" | "MSOL">): string {
  return SOLANA_TOKEN_MINTS[symbol];
}

export function resolveSolanaTokenDecimals(symbol: Extract<AccountAssetSymbol, "USDC" | "USDT" | "SOL" | "MSOL">): number {
  return SOLANA_TOKEN_DECIMALS[symbol];
}

export function resolveSolanaSymbolForMint(mint: string): Extract<AccountAssetSymbol, "USDC" | "USDT" | "SOL" | "MSOL"> | null {
  const lower = mint.toLowerCase();
  for (const [symbol, value] of Object.entries(SOLANA_TOKEN_MINTS)) {
    if (value.toLowerCase() === lower) {
      return symbol as Extract<AccountAssetSymbol, "USDC" | "USDT" | "SOL" | "MSOL">;
    }
  }
  return null;
}
