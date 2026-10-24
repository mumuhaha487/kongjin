import { beforeEach, expect, it, vi } from "vitest";
import { STORE } from "../src/lib/build";
import { memoryStorage } from "../src/lib/storage";
import { defaults } from "../src/lib/model";
import { initialStatus, type SyncStatus } from "../src/features/pairing/types";

const mock = vi.hoisted(() => ({
  listeners: new Map<string, (value: unknown) => void>(),
  status: {} as SyncStatus,
  init: vi.fn(async () => {}),
  retry: vi.fn(async () => {}),
  retryJoin: vi.fn(async () => {}),
  leave: vi.fn(async () => {}),
  cancel: vi.fn(),
  done: undefined as undefined | ((error: Error) => void),
}));
vi.mock("@kongjing/protocol", () => ({
  KongjingSync: class {
    on(event: string, fn: (value: unknown) => void) {
      mock.listeners.set(event, fn);
    }
    status() {
      return mock.status;
    }
    init = mock.init;
    leave = mock.leave;
    retryJoin = mock.retryJoin;
    async join() {
      return {
        sas: Promise.resolve({ sas: "123456", inviterName: "A" }),
        confirm: async () => {},
        cancel: mock.cancel,
        retry: mock.retry,
        done: new Promise<void>((_resolve, reject) => {
          mock.done = reject;
        }),
      };
    }
  },
}));
vi.mock("../src/features/continuity/service", () => ({
  attachContinuity: async () => ({}),
}));
vi.mock("../src/features/continuity/desktop", () => ({
  installDesktopContinuity: vi.fn(),
}));
vi.mock("../src/features/pairing/engine", async () => {
  const { KongjingSync } = await import("@kongjing/protocol");
  return {
    createEngine: () =>
      Object.assign(new KongjingSync({} as never), {
        preferences: () => ({}),
        setForeground: () => {},
      }),
  };
});
import { PairController } from "../src/features/pairing/controller";

const test = it.skipIf(STORE);
function dispatch(phase?: "completing" | "failed", paired = true) {
  mock.status = { ...initialStatus(), paired, joinPhase: phase };
  mock.listeners.get("status")?.(mock.status);
}
function fixture() {
  return new PairController(
    async () => defaults(),
    async () => {},
    () => {},
    undefined,
    memoryStorage(),
  );
}
beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://localhost/" });
  vi.clearAllMocks();
  mock.listeners.clear();
  mock.status = initialStatus();
  mock.init.mockImplementation(async () => {});
  mock.retry.mockImplementation(async () => {
    dispatch("completing");
    dispatch();
  });
  mock.retryJoin.mockImplementation(async () => {
    dispatch("completing");
    dispatch();
  });
  mock.leave.mockImplementation(async () => {
    dispatch(undefined, false);
  });
});
test("welcome completion, retry exhaustion and success map to three UI states; generic errors never replace the recoverable view", async () => {
  const controller = fixture();
  await controller.init();
  await controller.command("join", { code: "0123456789" });
  dispatch("completing");
  expect(controller.pair.view).toBe("completing");
  dispatch("failed");
  mock.done!(Error("NETWORK"));
  await Promise.resolve();
  expect(controller.pair.view).toBe("join-failed");
  await controller.command("intro");
  expect(controller.pair.view).toBe("join-failed");
  await controller.command("retry-join");
  expect(mock.retry).toHaveBeenCalledOnce();
  expect(mock.retryJoin).not.toHaveBeenCalled();
  expect(controller.pair.view).toBe("success");
});
test("restored init exposes completing before its retry settles and permits retryJoin after failure", async () => {
  let rejectInit!: (error: Error) => void;
  mock.init.mockImplementation(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectInit = reject;
        dispatch("completing");
      }),
  );
  const controller = fixture();
  await controller.init();
  expect(controller.pair.view).toBe("completing");
  dispatch("failed");
  rejectInit(Error("NETWORK"));
  await Promise.resolve();
  expect(controller.pair.view).toBe("join-failed");
  await controller.command("retry-join");
  expect(mock.retryJoin).toHaveBeenCalledOnce();
  expect(mock.retry).not.toHaveBeenCalled();
  expect(controller.pair.view).toBe("success");
});
test("closing a pending view preserves credentials; explicit cancel clears the pending group and ignores the old done rejection", async () => {
  const controller = fixture();
  await controller.init();
  await controller.command("join", { code: "0123456789" });
  dispatch("failed");
  await controller.command("detach");
  expect(mock.cancel).not.toHaveBeenCalled();
  expect(controller.pair.view).toBe("join-failed");
  await controller.command("cancel");
  mock.done!(Error("CANCELLED"));
  await Promise.resolve();
  expect(mock.cancel).toHaveBeenCalledOnce();
  expect(mock.leave).toHaveBeenCalledOnce();
  expect(controller.status.joinPhase).toBeUndefined();
  expect(controller.pair.view).toBe("intro");
});
test("cancel while manual retry is in flight cannot resurrect a failure view", async () => {
  const controller = fixture();
  await controller.init();
  dispatch("failed");
  let rejectRetry!: (error: Error) => void;
  mock.retryJoin.mockImplementation(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectRetry = reject;
        dispatch("completing");
      }),
  );
  const retry = controller.command("retry-join");
  await controller.command("cancel");
  rejectRetry(Error("CANCELLED"));
  await retry;
  expect(controller.pair.view).toBe("intro");
  expect(controller.status.joinPhase).toBeUndefined();
});
