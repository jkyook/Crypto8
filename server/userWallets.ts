import { getDb } from "./db";

export type UserWalletRow = {
  id: string;
  username: string;
  walletAddress: string;
  chain: string;
  provider: string;
  createdAt: string;
};

type RawWalletRow = {
  id: string;
  username: string;
  wallet_address: string;
  chain: string;
  provider: string;
  created_at: string;
};

function toWalletRow(row: RawWalletRow): UserWalletRow {
  return {
    id: row.id,
    username: row.username,
    walletAddress: row.wallet_address,
    chain: row.chain,
    provider: row.provider,
    createdAt: row.created_at
  };
}

export async function linkUserWallet(username: string, walletAddress: string, chain = "Solana", provider = "phantom"): Promise<UserWalletRow> {
  const db = getDb();
  const now = new Date().toISOString();
  const id = `uw_${Date.now()}_${walletAddress.slice(0, 6)}`;
  await db.$executeRawUnsafe(
    `
      INSERT OR IGNORE INTO user_wallets (id, username, wallet_address, chain, provider, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    id,
    username,
    walletAddress,
    chain,
    provider,
    now
  );
  const rows = await db.$queryRawUnsafe<RawWalletRow[]>(
    `
      SELECT id, username, wallet_address, chain, provider, created_at
      FROM user_wallets
      WHERE username = ? AND wallet_address = ?
      LIMIT 1
    `,
    username,
    walletAddress
  );
  if (!rows[0]) {
    throw new Error("wallet link failed");
  }
  return toWalletRow(rows[0]);
}

export async function listUserWallets(username: string): Promise<UserWalletRow[]> {
  const db = getDb();
  const rows = await db.$queryRawUnsafe<RawWalletRow[]>(
    `
      SELECT id, username, wallet_address, chain, provider, created_at
      FROM user_wallets
      WHERE username = ?
      ORDER BY created_at DESC
    `,
    username
  );
  return rows.map(toWalletRow);
}
