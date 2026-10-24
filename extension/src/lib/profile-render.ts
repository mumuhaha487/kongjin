import type { ProfilerOnRenderCallback } from "react";
// Only the separate QA profiling renderer calls this. No production counters.
export const profileRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
) => {
  if (import.meta.env.MODE !== "qa") return;
  const target = window as unknown as { kjProfile?: unknown[] };
  target.kjProfile?.push({ id, phase, actualDuration });
};
