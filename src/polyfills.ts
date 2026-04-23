import { Buffer } from "buffer";

type BrowserProcess = {
  env: Record<string, string | undefined>;
};

const globalTarget = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
  process?: BrowserProcess;
};

if (typeof globalTarget.Buffer === "undefined") {
  globalTarget.Buffer = Buffer;
}

if (typeof globalTarget.global === "undefined") {
  globalTarget.global = globalThis;
}

if (typeof globalTarget.process === "undefined") {
  globalTarget.process = { env: {} };
}

globalTarget.process.env.NODE_ENV ??= import.meta.env.MODE;
globalTarget.process.env.ANCHOR_BROWSER ??= "true";
