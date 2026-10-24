export type BridgeResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };
export type BridgeHandler = (
  method: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
export function createNativeDispatcher(
  handler: BridgeHandler,
  reply: (id: string, json: string) => void,
  timeout = 5000,
) {
  return async (
    id: string,
    method: string,
    argsJson: string,
  ): Promise<BridgeResult> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: BridgeResult;
    try {
      const args: unknown = JSON.parse(argsJson);
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw Error("INVALID_ARGS");
      const data = await Promise.race([
        handler(method, args as Record<string, unknown>),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("TIMEOUT")), timeout);
        }),
      ]);
      result = { ok: true, data };
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      };
    } finally {
      clearTimeout(timer);
    }
    try {
      reply(id, JSON.stringify(result));
    } catch {
      /* no native host in preview */
    }
    return result;
  };
}
