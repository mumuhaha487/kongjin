import {
  createElement,
  forwardRef,
  useEffect,
  useState,
  type ComponentType,
} from "react";
import { motion, type HTMLMotionProps } from "motion/react";
import { ANDROID } from "./build";
// Conservative leases: at most eight mounted projection nodes can animate.
// Remaining nodes use normal layout immediately, retaining enter/tap springs.
export class LayoutBudget {
  private leases = new Set<symbol>();
  acquire(id: symbol) {
    if (this.leases.size >= 8) return false;
    this.leases.add(id);
    return true;
  }
  release(id: symbol) {
    this.leases.delete(id);
  }
}
const budget = new LayoutBudget();
function bounded<T extends "div" | "span" | "a" | "button">(tag: T) {
  const Component = motion[tag] as ComponentType<HTMLMotionProps<T>>;
  return forwardRef<HTMLElementTagNameMap[T], HTMLMotionProps<T>>(
    function Bounded(raw, ref) {
      const props = raw as HTMLMotionProps<T>;
      const eligible = !!props.layout || !!props.layoutId;
      const [granted, setGranted] = useState(!ANDROID);
      useEffect(() => {
        if (!ANDROID || !eligible) return;
        const id = Symbol();
        setGranted(budget.acquire(id));
        return () => budget.release(id);
      }, [eligible]);
      return createElement(Component, {
        ...props,
        ref,
        layout: granted ? props.layout : false,
        layoutId: granted ? props.layoutId : undefined,
      } as HTMLMotionProps<T>);
    },
  );
}
export const LayoutDiv = bounded("div");
export const LayoutSpan = bounded("span");
export const LayoutAnchor = bounded("a");
export const LayoutButton = bounded("button");
