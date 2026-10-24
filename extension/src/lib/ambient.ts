// One Android-only clock, no layout reads. Interactions use their own 60Hz animations.
export class AmbientClock {
  private timer?: ReturnType<typeof setTimeout>;
  private previous = 0;
  private activity = 0;
  private phase = 0;
  private enabled = true;
  private visible = true;
  private paused = false;
  private layers = new Map<Element, (time: number) => void>();
  constructor(private now = () => performance.now()) {
    this.activity = this.previous = now();
  }
  // Integral of the speed: 1 until 20s, then linear deceleration over 1.2s.
  private elapsed(at: number) {
    const t = Math.max(0, at - this.activity);
    if (t <= 20000) return t;
    const ramp = Math.min(1200, t - 20000);
    return 20000 + ramp - (ramp * ramp) / 2400;
  }
  private advance(at: number) {
    if (this.enabled && this.visible && !this.paused)
      this.phase += Math.max(0, this.elapsed(at) - this.elapsed(this.previous));
    this.previous = at;
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (
      !this.enabled ||
      !this.visible ||
      this.paused ||
      !this.layers.size ||
      this.now() - this.activity >= 21200
    )
      return;
    this.timer = setTimeout(
      () => {
        this.advance(this.now());
        this.layers.forEach((draw) => draw(this.phase));
        this.schedule();
      },
      1000 / 30 + 1,
    ); // never exceed 30 callbacks/sec, including timer rounding
  }
  register(node: Element, draw: (time: number) => void) {
    if (!this.layers.has(node) && this.layers.size >= 6)
      throw Error("Ambient layer budget exceeded");
    this.layers.set(node, draw);
    draw(this.phase);
    if (!this.timer) this.schedule();
    return () => {
      this.layers.delete(node);
      if (!this.layers.size) this.schedule();
    };
  }
  wake() {
    const at = this.now();
    this.advance(at);
    this.activity = this.previous = at;
    this.schedule();
  }
  configure(options: {
    enabled?: boolean;
    visible?: boolean;
    paused?: boolean;
  }) {
    const at = this.now();
    this.advance(at);
    if (options.enabled !== undefined) this.enabled = options.enabled;
    if (options.visible !== undefined) this.visible = options.visible;
    if (options.paused !== undefined) this.paused = options.paused;
    this.schedule();
  }
  snapshot() {
    return {
      phase: this.phase,
      layers: this.layers.size,
      running: !!this.timer,
      frozen: this.now() - this.activity >= 21200,
    };
  }
}
export const ambient = new AmbientClock();

// CSS cubic-bezier(.65,0,.35,1), shared with the original scenery keyframes.
export function ambientEase(x: number) {
  let low = 0,
    high = 1;
  for (let i = 0; i < 12; i++) {
    const t = (low + high) / 2;
    const bx =
      3 * (1 - t) ** 2 * t * 0.65 + 3 * (1 - t) * t * t * 0.35 + t ** 3;
    if (bx < x) low = t;
    else high = t;
  }
  const t = (low + high) / 2;
  return 3 * t * t - 2 * t * t * t;
}
