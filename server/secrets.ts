import { readFileSync } from "fs";

function normalizePrivateKey(value: string, source: string): `0x${string}` {
  const key = value.trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) {
    throw new Error(`${source} must be a 32-byte hex private key with 0x prefix`);
  }
  return key as `0x${string}`;
}

/**
 * Live 서명 키는 모듈 로드 시점에 들고 있지 않고, 서명 직전에만 읽는다.
 * 운영 환경에서는 AWS Secrets Manager/Vault Agent/KMS 복호화 결과를 파일로 마운트하고
 * `ARBITRUM_EXECUTOR_PRIVATE_KEY_FILE`에 경로를 넣는 방식을 기본으로 한다.
 */
export async function loadArbitrumExecutorPrivateKey(): Promise<`0x${string}`> {
  const filePath = process.env.ARBITRUM_EXECUTOR_PRIVATE_KEY_FILE?.trim();
  if (filePath) {
    return normalizePrivateKey(readFileSync(filePath, "utf8"), "ARBITRUM_EXECUTOR_PRIVATE_KEY_FILE");
  }

  const envKey = process.env.ARBITRUM_EXECUTOR_PRIVATE_KEY;
  const allowInsecureEnvKey = process.env.ALLOW_INSECURE_ENV_PRIVATE_KEY === "true" || process.env.NODE_ENV !== "production";
  if (envKey && allowInsecureEnvKey) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[secrets] ALLOW_INSECURE_ENV_PRIVATE_KEY=true: production is reading executor key from env");
    }
    return normalizePrivateKey(envKey, "ARBITRUM_EXECUTOR_PRIVATE_KEY");
  }

  throw new Error(
    "live uniswap execution requires ARBITRUM_EXECUTOR_PRIVATE_KEY_FILE backed by a secret manager or ALLOW_INSECURE_ENV_PRIVATE_KEY=true"
  );
}
