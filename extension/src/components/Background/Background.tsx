import { useShallow } from "zustand/react/shallow";
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { useStore } from "../../app/store";
import { imageFile, storage } from "../../lib/storage";
import { ANDROID, STORE } from "../../lib/build";
import { afterPaintIdle } from "../../lib/after-paint";
import { onPageVisibility, pageVisible } from "../../lib/visibility";
import { drawBackground, orbitFrames, stars } from "./drawing";
import { ambient, ambientEase } from "../../lib/ambient";
export function Background() {
  useStore(
    useShallow((v) => [
      v.data.settings.background,
      v.data.settings.imageUrl,
      "backgroundImage" in v.data.settings
        ? v.data.settings.backgroundImage
        : undefined,
      v.data.settings.grain,
      v.data.settings.animated,
      v.data.settings.smoothFirst,
      v.data.settings.theme,
      v.data.settings.accent,
    ]),
  );
  const s = useStore.getState().data.settings,
    reduce = useReducedMotion(),
    root = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    orbit = useRef<HTMLCanvasElement>(null),
    starLayer = useRef<HTMLDivElement>(null),
    clouds = useRef<(HTMLCanvasElement | null)[]>([]),
    glint = useRef<HTMLDivElement>(null),
    [local, setLocal] = useState(""),
    [revision, setRevision] = useState(0);
  const scenic = s.background === "kongjing";
  useEffect(() => {
    if (!ANDROID) return;
    ambient.configure({ enabled: s.animated && !s.smoothFirst && !reduce });
    const off: (() => void)[] = [];
    if (scenic) {
      clouds.current.forEach((node, i) => {
        if (node)
          off.push(
            ambient.register(node, (time) => {
              const duration = [240000, 180000, 135000][i];
              const phase =
                ((time + [0, 60000, 90000][i]) % duration) / duration;
              node.style.transform = `translateX(${-50 * phase}%)`;
            }),
          );
      });
      if (starLayer.current) {
        const node = starLayer.current;
        off.push(
          ambient.register(node, (time) => {
            const phase = (time % 6000) / 3000;
            node.style.opacity = String(
              1 - 0.8 * ambientEase(phase <= 1 ? phase : 2 - phase),
            );
          }),
        );
      }
    }
    return () => off.forEach((fn) => fn());
  }, [scenic, s.animated, s.smoothFirst, reduce]);
  useEffect(() => {
    if (STORE) return;
    return storage.subscribe((key) => {
      if (key === "background-revision") setRevision((n) => n + 1);
    });
  }, []);
  useEffect(() => {
    if (s.background !== "image" || s.imageUrl !== "local") return;
    let url = "",
      disposed = false;
    const load = () => {
      void imageFile().then((blob) => {
        if (blob && !disposed) {
          url = URL.createObjectURL(blob);
          setLocal(url);
        }
      });
    };
    const cancel = STORE ? (load(), () => {}) : afterPaintIdle(load);
    return () => {
      disposed = true;
      cancel();
      URL.revokeObjectURL(url);
    };
  }, [
    s.background,
    s.imageUrl,
    "backgroundImage" in s ? s.backgroundImage : undefined,
    revision,
  ]);
  useEffect(() => {
    let generation = 0,
      animation: Animation | undefined;
    const draw = () => {
      const stamp = ++generation,
        width = innerWidth,
        height = innerHeight;
      const light = document.documentElement.dataset.theme === "light";
      const accent = getComputedStyle(root.current!)
        .getPropertyValue("--accent")
        .trim();
      void drawBackground(
        canvas.current!,
        orbit.current,
        clouds.current.filter((c): c is HTMLCanvasElement => !!c),
        width,
        height,
        Math.min(devicePixelRatio, ANDROID ? 1.5 : 2),
        {
          light,
          accent,
          grain: s.grain,
          scenic,
          solid: s.background === "solid",
          android: ANDROID,
        },
        () => generation === stamp,
      );
      animation?.cancel();
      if (glint.current && s.animated && !s.smoothFirst && !reduce) {
        animation = glint.current.animate(orbitFrames(width, height), {
          duration: 40000,
          iterations: Infinity,
        });
        if (!pageVisible()) animation.pause();
      }
    };
    draw();
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-accent"],
    });
    window.addEventListener("resize", draw);
    const visible = () => {
      if (pageVisible()) animation?.play();
      else animation?.pause();
    };
    const unsubscribe = onPageVisibility(visible);
    return () => {
      generation++;
      animation?.cancel();
      observer.disconnect();
      window.removeEventListener("resize", draw);
      unsubscribe();
    };
  }, [scenic, s.background, s.grain, s.animated, s.smoothFirst, reduce]);
  useEffect(() => {
    document.documentElement.classList.toggle(
      "background-static",
      !s.animated || s.smoothFirst || !!reduce,
    );
    // No pointer listener or rAF is installed for touch hardware.
    if (
      ANDROID ||
      matchMedia("(any-pointer: coarse)").matches ||
      reduce ||
      !s.animated ||
      s.smoothFirst
    )
      return;
    let frame = 0,
      movedAt = 0,
      x = 0,
      y = 0,
      tx = 0,
      ty = 0;
    const tick = () => {
      if (!pageVisible() || performance.now() - movedAt >= 200) {
        frame = 0;
        return;
      }
      x += (tx - x) * 0.06;
      y += (ty - y) * 0.06;
      if (starLayer.current)
        starLayer.current.style.transform = `translate(${x}px,${y}px)`;
      frame = requestAnimationFrame(tick);
    };
    const move = (e: PointerEvent) => {
      if (!pageVisible() || e.pointerType === "touch") return;
      movedAt = performance.now();
      tx = (e.clientX / innerWidth - 0.5) * 12;
      ty = (e.clientY / innerHeight - 0.5) * 12;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const unsubscribe = onPageVisibility(() => {
      if (!pageVisible()) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    });
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      window.removeEventListener("pointermove", move);
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, [s.animated, s.smoothFirst, reduce]);
  return (
    <div
      ref={root}
      className="background kongjing-background"
      aria-hidden="true"
    >
      <canvas ref={canvas} className="static-sky" />
      {scenic && (
        <>
          <div ref={starLayer} className="twinkle-layer">
            {stars.slice(0, ANDROID ? 4 : 8).map((star, i) => (
              <div
                key={i}
                className="star-twinkle"
                style={{
                  left: (star.x / 1440) * 100 + "%",
                  top: (star.y / 900) * 100 + "%",
                  opacity: star.opacity,
                  animationDuration: 3 + (i * 3) / 7 + "s",
                  animationDelay: -i * 0.7 + "s",
                }}
              />
            ))}
          </div>
          <canvas ref={orbit} className="orbit-canvas" />
          {!ANDROID && <div ref={glint} className="orbit-glint-sprite" />}
          <div className="cloud-sea">
            {[0, 1, 2].map((i) => (
              <canvas
                key={i}
                ref={(el) => {
                  clouds.current[i] = el;
                }}
                className={"cloud-wave wave-" + i}
              />
            ))}
          </div>
        </>
      )}
      {s.background === "image" && (
        <div className="image-layer">
          <img src={s.imageUrl === "local" ? local : s.imageUrl} alt="" />
          <div />
        </div>
      )}
    </div>
  );
}
