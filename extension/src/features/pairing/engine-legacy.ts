// Frozen store build: never resolve or bundle the v3 implementation.
import { KongjingSync } from "@kongjing/protocol";
import type { AppData } from "../../lib/model";
import type { SyncOptions } from "./types";
export const createEngine = (options: SyncOptions<AppData>) => new KongjingSync(options);
