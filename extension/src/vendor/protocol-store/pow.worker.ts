import { solvePow } from "./pow.ts";
globalThis.onmessage = async (e) => {
  try {
    globalThis.postMessage(await solvePow(e.data));
  } catch (error) {
    globalThis.postMessage({
      error: error instanceof Error ? error.message : "NETWORK",
    });
  }
};
