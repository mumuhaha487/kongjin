import type { Transition } from "motion/react";
import { spring as springGenerator } from "motion";

export const spring = {
  snappy: { type: "spring", stiffness: 520, damping: 38, mass: 1 },
  smooth: { type: "spring", stiffness: 300, damping: 32, mass: 1 },
  gentle: { type: "spring", stiffness: 170, damping: 26, mass: 1 },
} as const;
export const easeOut = [0.22, 1, 0.36, 1] as const;
export const easeIn = [0.55, 0, 1, 0.45] as const;
// The shared projection uses this same spring. Reveal at 60% of its travel.
const sharedResponse = springGenerator({ ...spring.smooth, keyframes: [0, 1] });
let sharedMilliseconds = 0;
while (sharedResponse.next(sharedMilliseconds).value < 0.6)
  sharedMilliseconds++;
export const sharedContentDelay = sharedMilliseconds / 1000;

export function motionTransition(value: Transition): Transition {
  return typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
    ? { type: "tween", duration: 0.15, delay: 0, ease: "linear" }
    : value;
}
