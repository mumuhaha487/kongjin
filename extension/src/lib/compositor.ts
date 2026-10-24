import { spring as response } from "motion";
import { spring } from "./motion";
const positions = new WeakMap<
  HTMLElement,
  { x: number; scale: number; animation?: Animation }
>();

// Physical spring samples preserve the design parameters and run as native
// transform keyframes. No main-thread rAF/style writes during the transition.
export function stageAnimation(
  node: HTMLElement,
  x: number,
  scale: number,
  opening: boolean,
  opacity = 1,
) {
  const previous = positions.get(node) || { x: 0, scale: 1 };
  const interrupted = previous.animation?.playState === "running";
  const matrix = interrupted
    ? new DOMMatrix(getComputedStyle(node).transform)
    : undefined;
  const targetX = (innerWidth * x) / 100;
  const startX = matrix?.e ?? previous.x,
    startScale = matrix?.a ?? previous.scale;
  if (startX === targetX && startScale === scale) return () => {};
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const frames: Keyframe[] = [];
  const generator = response({ ...spring.smooth, keyframes: [0, 1] });
  let duration = 280;
  for (let t = 0; t <= 2000; t += 1000 / 60) {
    const step = generator.next(t);
    const progress = opening ? step.value : Math.min(t / 280, 1);
    frames.push({
      transform: `translateX(${startX + (targetX - startX) * progress}px) scale(${startScale + (scale - startScale) * progress})`,
    });
    if (opening ? step.done : t >= 280) {
      duration = t;
      break;
    }
  }
  const transform = `translateX(${targetX}px) scale(${scale})`;
  const closingFrames = [
    { transform: `translateX(${startX}px) scale(${startScale})` },
    { transform },
  ];
  node.style.willChange = "transform";
  const animation = node.animate(
    reduced
      ? [{ opacity: Number(getComputedStyle(node).opacity) }, { opacity }]
      : opening
        ? frames
        : closingFrames,
    {
      duration: reduced ? 150 : opening ? duration : 280,
      easing: !opening && !reduced ? "cubic-bezier(.25,.1,.35,1)" : "linear",
      fill: "forwards",
    },
  );
  node.style.transform = reduced ? "none" : transform;
  if (reduced) node.style.opacity = String(opacity);
  positions.set(node, { x: targetX, scale, animation });
  void animation.finished
    .then(() => {
      node.style.willChange = "";
      animation.cancel();
    })
    .catch(() => {});
  return () => animation.cancel();
}
