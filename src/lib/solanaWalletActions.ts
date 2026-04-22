import Decimal from "decimal.js";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import type { ISolanaChain } from "@phantom/chain-interfaces";
import { executeJupiterExactInSwap } from "./solanaJupiterSwap";
import { getSolanaRpcCandidates, type OnChainTokenRow } from "./solanaChainAssets";
import { resolveSolanaSymbolForMint, resolveSolanaTokenMint } from "./solanaTokenMints";

export type WalletActionNetwork = "mainnet" | "devnet";

export type WalletAssetChoice = {
  kind: "native" | "spl";
  mint: string;
  symbol: string;
  label: string;
  decimals: number;
  amount: number;
};

export type WalletActionConnection = {
  connection: Connection;
  rpcUsed: string;
};

function normalizePublicKey(value: unknown): string {
  if (!value) {
    throw new Error("Solana wallet is not connected");
  }
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "object") {
    const candidate = value as { toBase58?: () => string; toString?: () => string };
    const base58 = candidate.toBase58?.();
    if (typeof base58 === "string" && base58.length > 0) return base58;
    const asString = candidate.toString?.();
    if (typeof asString === "string" && asString.length > 0 && asString !== "[object Object]") return asString;
  }
  throw new Error("Invalid public key input");
}

export function resolveWalletPublicKey(value: unknown): PublicKey {
  return new PublicKey(normalizePublicKey(value));
}

export function buildWalletAssetChoices(input: {
  solBalance: number | null;
  tokenRows: OnChainTokenRow[];
}): WalletAssetChoice[] {
  const rows: WalletAssetChoice[] = [];
  if (typeof input.solBalance === "number" && Number.isFinite(input.solBalance) && input.solBalance > 0) {
    rows.push({
      kind: "native",
      mint: resolveSolanaTokenMint("SOL"),
      symbol: "SOL",
      label: "SOL (네이티브)",
      decimals: 9,
      amount: input.solBalance
    });
  }
  input.tokenRows.forEach((row) => {
    const symbol = resolveSolanaSymbolForMint(row.mint) ?? row.symbol;
    if (row.amount <= 0) return;
    rows.push({
      kind: row.mint === resolveSolanaTokenMint("SOL") ? "spl" : "spl",
      mint: row.mint,
      symbol,
      label: `${row.symbol} · ${row.mint.slice(0, 4)}…${row.mint.slice(-4)}`,
      decimals: row.decimals,
      amount: row.amount
    });
  });
  return rows;
}

export async function createWalletActionConnection(network: WalletActionNetwork): Promise<WalletActionConnection> {
  const rpcCandidates = getSolanaRpcCandidates(network, network !== "devnet");
  let lastError = "";
  for (const rpcUrl of rpcCandidates) {
    try {
      const connection = new Connection(rpcUrl, { commitment: "confirmed" });
      await connection.getLatestBlockhash("confirmed");
      return { connection, rpcUsed: rpcUrl };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError || "지갑 RPC 연결에 실패했습니다.");
}

function parseAmountToRaw(amount: string, decimals: number): bigint {
  const normalized = amount.trim();
  if (!normalized) {
    throw new Error("금액을 입력하세요.");
  }
  const dec = new Decimal(normalized);
  if (!dec.isFinite() || dec.lte(0)) {
    throw new Error("금액은 0보다 커야 합니다.");
  }
  return BigInt(dec.mul(new Decimal(10).pow(decimals)).floor().toFixed(0));
}

async function signAndSendTransaction(connection: Connection, wallet: ISolanaChain, tx: Transaction): Promise<string> {
  const signer = wallet as Partial<ISolanaChain> & {
    signAndSendTransaction?: (transaction: Transaction) => Promise<{ signature: string }>;
    signTransaction?: (transaction: Transaction) => Promise<Transaction>;
  };
  if (typeof signer.signAndSendTransaction === "function") {
    const result = await signer.signAndSendTransaction(tx);
    return result.signature;
  }
  if (typeof signer.signTransaction !== "function") {
    throw new Error("지갑 서명을 사용할 수 없습니다.");
  }
  const signed = await signer.signTransaction(tx);
  const raw = signed.serialize();
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  return signature;
}

export async function sendSolanaAsset(input: {
  wallet: ISolanaChain;
  connection: Connection;
  recipient: string;
  choice: WalletAssetChoice;
  amount: string;
}): Promise<{ signature: string; rawAmount: bigint }> {
  const owner = resolveWalletPublicKey(input.wallet.publicKey);
  const recipient = resolveWalletPublicKey(input.recipient);
  const amountRaw = parseAmountToRaw(input.amount, input.choice.decimals);
  if (input.choice.kind === "native") {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: recipient,
        lamports: Number(amountRaw)
      })
    );
    const { blockhash, lastValidBlockHeight } = await input.connection.getLatestBlockhash("confirmed");
    tx.feePayer = owner;
    tx.recentBlockhash = blockhash;
    const signature = await signAndSendTransaction(input.connection, input.wallet, tx);
    await input.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    return { signature, rawAmount: amountRaw };
  }

  const mint = new PublicKey(input.choice.mint);
  const sourceAta = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const destinationAta = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const tx = new Transaction();
  const destInfo = await input.connection.getAccountInfo(destinationAta, "confirmed");
  if (!destInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        owner,
        destinationAta,
        recipient,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  tx.add(
    createTransferCheckedInstruction(
      sourceAta,
      mint,
      destinationAta,
      owner,
      amountRaw,
      input.choice.decimals,
      [],
      TOKEN_PROGRAM_ID
    )
  );
  const { blockhash, lastValidBlockHeight } = await input.connection.getLatestBlockhash("confirmed");
  tx.feePayer = owner;
  tx.recentBlockhash = blockhash;
  const signature = await signAndSendTransaction(input.connection, input.wallet, tx);
  await input.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return { signature, rawAmount: amountRaw };
}

export async function swapSolanaAsset(input: {
  wallet: ISolanaChain;
  connection: Connection;
  from: WalletAssetChoice;
  toMint: string;
  amount: string;
}): Promise<{ signature: string; rawAmount: bigint }> {
  const owner = resolveWalletPublicKey(input.wallet.publicKey);
  const amountRaw = parseAmountToRaw(input.amount, input.from.decimals);
  const sourceMint = input.from.mint;
  const result = await executeJupiterExactInSwap({
    connection: input.connection,
    wallet: input.wallet,
    inputMint: sourceMint,
    outputMint: input.toMint,
    amountRaw,
    slippageBps: 100,
    label: `${input.from.symbol}→${resolveSolanaSymbolForMint(input.toMint) ?? input.toMint}`
  });
  void owner;
  return { signature: result.signature, rawAmount: amountRaw };
}
