// Rasterized only on size / palette changes; all continuous movement is composited.
export const waves = [
  "M0 120 C180 90 320 100 480 120 C660 142 820 140 980 116 C1140 92 1260 150 1440 120",
  "M0 170 C160 150 330 146 500 166 C680 188 860 186 1020 166 C1180 146 1280 190 1440 170",
  "M0 222 C200 206 380 204 560 218 C740 232 920 232 1100 218 C1240 208 1240 238 1440 222",
];
let seed = 7;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
export const stars = Array.from({ length: 110 }, () => ({
  x: random() * 1440,
  y: random() * 620,
  opacity: 0.25 + random() * 0.65,
  r: random() < 0.2 ? 1.3 : 0.7,
}));
function context(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  dpr: number,
) {
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(canvas.width / width, canvas.height / height);
  return ctx;
}
const svgImage = (svg: string) =>
  new Promise<HTMLImageElement>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
export async function drawBackground(
  canvas: HTMLCanvasElement,
  orbit: HTMLCanvasElement | null,
  clouds: HTMLCanvasElement[],
  width: number,
  height: number,
  dpr: number,
  options: {
    light: boolean;
    accent: string;
    grain: boolean;
    scenic: boolean;
    solid: boolean;
    android: boolean;
  },
  current: () => boolean,
) {
  const { light, accent, grain, scenic } = options;
  const vmax = Math.max(width, height);
  const sky = light
    ? '<stop stop-color="#d6e5fa"/><stop offset=".36" stop-color="#e7effa"/><stop offset=".66" stop-color="#f1f5fa"/><stop offset="1" stop-color="#f4f6fa"/>'
    : '<stop stop-color="#04070f"/><stop offset=".46" stop-color="#071027"/><stop offset=".76" stop-color="#0a1531"/><stop offset="1" stop-color="#0c1836"/>';
  const circles =
    scenic && !light
      ? stars
          .slice(options.android ? 4 : 8)
          .map((s) => {
            const x = (s.x * width) / 1440,
              y = (s.y * height) / 900;
            const mask =
              0.2 +
              0.8 *
                Math.min(
                  1,
                  Math.hypot((x - width / 2) / 380, (y - height * 0.4) / 300),
                );
            return `<ellipse cx="${x}" cy="${y}" rx="${(s.r * width) / 1440}" ry="${(s.r * height) / 900}" fill="#dce8ff" opacity="${s.opacity * mask}"/>`;
          })
          .join("")
      : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>
    <linearGradient id="sky" x2="0" y2="1">${sky}</linearGradient>
    <radialGradient id="sun"><stop stop-color="${light ? "#fff" : "#6ea0ff"}" stop-opacity="${light ? 0.85 : 0.14}"/><stop offset=".7" stop-color="${light ? "#fff" : "#6ea0ff"}" stop-opacity="0"/></radialGradient>
    <radialGradient id="accent"><stop stop-color="${accent}" stop-opacity=".12"/><stop offset=".7" stop-color="${accent}" stop-opacity="0"/></radialGradient>
    <filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/></filter>
    <pattern id="grain" width="160" height="160" patternUnits="userSpaceOnUse"><path fill="#fff" filter="url(#n)" d="M0 0h160v160H0z"/></pattern>
    </defs><path fill="url(#sky)" d="M0 0h${width}v${height}H0z"/>
    ${scenic ? `<ellipse cx="${width * 0.8}" cy="${height * 0.08}" rx="${vmax * 0.4}" ry="${vmax * 0.4}" fill="url(#sun)"/><ellipse cx="${width * 0.12}" cy="${height * 0.18}" rx="${vmax * 0.55}" ry="${vmax * 0.45}" fill="url(#accent)"/>${circles}` : ""}
    </svg>`;
  const [image, noise] = await Promise.all([
    svgImage(svg),
    grain
      ? svgImage(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/></filter><pattern id="grain" width="160" height="160" patternUnits="userSpaceOnUse"><path fill="#fff" filter="url(#n)" d="M0 0h160v160H0z"/></pattern></defs><path fill="url(#grain)" d="M0 0h${width}v${height}H0z"/></svg>`,
        )
      : undefined,
  ]);
  if (!current()) return;
  const skyContext = context(canvas, width, height, dpr);
  skyContext.drawImage(image, 0, 0, width, height);
  if (noise) {
    // Same prototype grain blend, flattened once rather than DOM-wide blending.
    skyContext.globalCompositeOperation = "overlay";
    skyContext.globalAlpha = light ? 0.03 : 0.05;
    skyContext.drawImage(noise, 0, 0, width, height);
    skyContext.globalAlpha = 1;
    skyContext.globalCompositeOperation = "source-over";
  }
  if (orbit) {
    const ctx = context(orbit, width, height, dpr);
    ctx.scale(width / 1440, height / 900);
    ctx.save();
    ctx.translate(720, 300);
    ctx.rotate((-8 * Math.PI) / 180);
    ctx.beginPath();
    ctx.ellipse(0, 0, 1000, 190, 0, 0, Math.PI * 2);
    ctx.strokeStyle = light
      ? "rgba(255,255,255,.8075)"
      : "rgba(150,190,255,.221)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    ctx.globalCompositeOperation = "destination-in";
    const fade = ctx.createLinearGradient(0, 0, 0, 900);
    fade.addColorStop(0, "#fff");
    fade.addColorStop(0.42, "#fff");
    fade.addColorStop(0.58, "transparent");
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, 1440, 900);
  }
  clouds.forEach((cloud, i) => {
    const ctx = context(
      cloud,
      width * 2,
      height * (options.android ? 0.22 : 0.3),
      dpr,
    );
    ctx.scale(width / 1440, (height * (options.android ? 0.22 : 0.3)) / 270);
    for (const x of [0, 1440]) {
      ctx.save();
      ctx.translate(x, 0);
      ctx.beginPath();
      ctx.rect(0, 0, 1440, 270);
      ctx.clip();
      ctx.fillStyle = (
        light
          ? ["#dde8f8", "#e8f0fa", "#f2f6fb"]
          : ["#0c1834", "#0f1d3d", "#122347"]
      )[i];
      ctx.fill(new Path2D(waves[i] + " L1440 270 L0 270Z"));
      if (i === 0) {
        ctx.strokeStyle = light
          ? "rgba(255,255,255,.9)"
          : "rgba(150,190,255,.1)";
        ctx.lineWidth = 1.5;
        ctx.stroke(new Path2D(waves[i]));
      }
      ctx.restore();
    }
  });
}
// 60 samples, plus the closing sample; no JS animation loop or offset-path.
export function orbitFrames(width: number, height: number): Keyframe[] {
  return Array.from({ length: 61 }, (_, i) => {
    const angle = (i / 60) * Math.PI * 2,
      rotation = (-8 * Math.PI) / 180;
    const x = 1000 * Math.cos(angle),
      y = 190 * Math.sin(angle);
    const px =
      ((720 + x * Math.cos(rotation) - y * Math.sin(rotation)) * width) / 1440;
    const py =
      ((300 + x * Math.sin(rotation) + y * Math.cos(rotation)) * height) / 900;
    const tangent = Math.atan2(
      ((190 * Math.cos(angle) * Math.cos(rotation) -
        1000 * Math.sin(angle) * Math.sin(rotation)) *
        height) /
        900,
      ((-1000 * Math.sin(angle) * Math.cos(rotation) -
        190 * Math.cos(angle) * Math.sin(rotation)) *
        width) /
        1440,
    );
    return {
      transform: `translate(${px}px,${py}px) rotate(${tangent}rad)`,
      opacity:
        py < height * 0.42
          ? 0.9
          : py < height * 0.58
            ? (0.9 * (height * 0.58 - py)) / (height * 0.16)
            : 0,
    };
  });
}
