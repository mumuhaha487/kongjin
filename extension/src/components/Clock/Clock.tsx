import { useShallow } from "zustand/react/shallow";
import { motionTransition } from "../../lib/motion";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useStore } from "../../app/store";
import { spring, easeOut } from "../../lib/motion";
import { ANDROID } from "../../lib/build";
import { nextClockDelay } from "../../lib/clock-timer";
import { onPageVisibility, pageVisible } from "../../lib/visibility";
import { ambient, ambientEase } from "../../lib/ambient";
function Digit({ value }: { value: string }) {
  const reduce = useReducedMotion();
  return (
    <span className="digit">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: reduce ? 0 : "30%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: reduce ? 0 : "-30%", opacity: 0 }}
          transition={motionTransition({ duration: 0.32, ease: easeOut })}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
export function Clock() {
  useStore(
    useShallow((v) => [
      v.data.settings.hour24,
      v.data.settings.seconds,
      v.data.settings.greeting,
      v.data.settings.animated,
      v.data.settings.smoothFirst,
    ]),
  );
  const [now, setNow] = useState(new Date()),
    clock = useRef<HTMLDivElement>(null),
    s = useStore.getState().data.settings,
    profile = useStore((v) => v.data.profile),
    focused = useStore((v) => v.focused),
    reduce = useReducedMotion();
  useEffect(() => {
    if (!ANDROID || !clock.current) return;
    const spark = clock.current.querySelector<SVGElement>(".clock-spark"),
      colon = clock.current.querySelector<HTMLElement>(".colon");
    const off: (() => void)[] = [];
    if (spark)
      off.push(
        ambient.register(spark, (time) => {
          const phase = (time % 7000) / 7000;
          const value =
            phase <= 0.1143
              ? ambientEase(phase / 0.1143)
              : phase < 0.23
                ? 1 - ambientEase((phase - 0.1143) / 0.1157)
                : 0;
          spark.style.transform = `scale(${0.7 + 0.3 * value}) rotate(${15 * value}deg)`;
          spark.style.opacity = String(0.45 + 0.55 * value);
        }),
      );
    if (colon && !s.seconds)
      off.push(
        ambient.register(colon, (time) => {
          const phase = (time % 2000) / 1000;
          colon.style.opacity = String(
            1 - 0.65 * ambientEase(phase <= 1 ? phase : 2 - phase),
          );
        }),
      );
    return () => off.forEach((fn) => fn());
  }, [s.seconds]);
  useLayoutEffect(() => {
    const root = clock.current;
    if (!root || !s.seconds) return;
    const seconds = root.querySelector<HTMLElement>(".seconds");
    const canvas = document.createElement("canvas").getContext("2d");
    if (!seconds || !canvas) return;
    let active = true;
    const glyphTop = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const m = canvas.measureText("0");
      return (
        (parseFloat(style.lineHeight) -
          m.fontBoundingBoxAscent -
          m.fontBoundingBoxDescent) /
          2 +
        m.fontBoundingBoxAscent -
        m.actualBoundingBoxAscent
      );
    };
    const align = () => {
      if (active)
        root.style.setProperty(
          "--seconds-offset",
          `${glyphTop(root) - glyphTop(seconds)}px`,
        );
    };
    align();
    void document.fonts.ready.then(align);
    const observer = new ResizeObserver(align);
    observer.observe(root);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [s.seconds]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      if (!pageVisible()) return;
      setNow(new Date());
      timer = setTimeout(schedule, nextClockDelay(Date.now(), s.seconds));
    };
    schedule();
    const unsubscribe = onPageVisibility(schedule);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [s.seconds]);
  const h = now.getHours(),
    greet =
      h >= 5 && h < 11
        ? "早上好"
        : h < 13 && h >= 11
          ? "中午好"
          : h >= 13 && h < 18
            ? "下午好"
            : h >= 18 && h < 23
              ? "晚上好"
              : "夜深了",
    name = profile.nickname;
  const digits = `${String(s.hour24 ? h : h % 12 || 12).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return (
    <motion.section
      className="clock-section"
      animate={{
        scale: focused && !reduce ? 0.94 : 1,
        y: focused && !reduce ? -10 : 0,
        opacity: focused ? 0.75 : 1,
      }}
      transition={motionTransition(spring.smooth)}
      aria-label="时间与日期"
    >
      {ANDROID && (
        <div className="mobile-clock-summary">
          {s.greeting && (
            <span className="mobile-greet">{greet}{name ? "，" : ""}</span>
          )}
          {s.greeting && name && (
            <span className="mobile-nickname">{name}</span>
          )}
          <span className="mobile-summary-date">
            {s.greeting && " · "}
            {now.getMonth() + 1}月{now.getDate()}日 星期
            {"日一二三四五六"[now.getDay()]}
          </span>
        </div>
      )}
      {s.greeting && (
        <motion.div
          className="greeting"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={motionTransition({ duration: 0.52, ease: easeOut })}
          key={name || "guest"}
        >
          {Array.from(greet + (name ? `，${name}` : "")).map((c, i) => (
            <motion.span
              key={i}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={motionTransition({ delay: i * 0.02 })}
            >
              {c}
            </motion.span>
          ))}
        </motion.div>
      )}
      <motion.div
        ref={clock}
        className="clock"
        initial={{
          opacity: 0,
          y: 8,
          ...(ANDROID ? {} : { filter: "blur(6px)" }),
        }}
        animate={{
          opacity: 1,
          y: 0,
          ...(ANDROID ? {} : { filter: "blur(0px)" }),
        }}
        transition={motionTransition({
          delay: 0.06,
          duration: 0.64,
          ease: easeOut,
        })}
        aria-label={digits}
      >
        <svg
          className={`clock-spark ${s.animated && !s.smoothFirst && !reduce ? "spark-animated" : ""}`}
          aria-hidden="true"
          viewBox="0 0 24 24"
        >
          <path d="M12 0 C13 8 16 11 24 12 C16 13 13 16 12 24 C11 16 8 13 0 12 C8 11 11 8 12 0Z" />
        </svg>
        {Array.from(digits).map((c, i) =>
          c === ":" ? (
            <span key={i} className={`colon ${!s.seconds ? "breathe" : ""}`}>
              :
            </span>
          ) : (
            <Digit key={i} value={c} />
          ),
        )}
        {s.seconds && (
          <span className="seconds">
            {Array.from(String(now.getSeconds()).padStart(2, "0")).map(
              (c, i) => (
                <Digit key={i} value={c} />
              ),
            )}
          </span>
        )}
      </motion.div>
      <motion.div
        className="date"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={motionTransition({ delay: 0.14, duration: 0.52 })}
      >
        {now.getMonth() + 1}月{now.getDate()}日 · 星期
        {"日一二三四五六"[now.getDay()]}
      </motion.div>
    </motion.section>
  );
}
