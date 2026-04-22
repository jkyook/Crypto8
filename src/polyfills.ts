import { Buffer } from "buffer";

const globalBufferTarget = globalThis as typeof globalThis & { Buffer?: typeof Buffer };

if (typeof globalBufferTarget.Buffer === "undefined") {
  globalBufferTarget.Buffer = Buffer;
}
