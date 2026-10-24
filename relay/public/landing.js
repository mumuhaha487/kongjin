const scheme = matchMedia("(prefers-color-scheme: dark)");
const theme = () =>
  document.documentElement.classList.toggle("dark", scheme.matches);
theme();
scheme.addEventListener("change", theme);
let seed = 7;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const stars = document.getElementById("stars");
if (stars) {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 110; i++) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    for (const [key, value] of Object.entries({
      cx: rand() * 1440,
      cy: rand() * 620,
      opacity: 0.25 + rand() * 0.65,
      r: rand() < 0.2 ? 1.3 : 0.7,
      fill: "#DCE8FF",
    })) circle.setAttribute(key, String(value));
    fragment.append(circle);
  }
  stars.append(fragment);
}
const pause = () =>
  document.documentElement.classList.toggle("paused", document.hidden);
pause();
document.addEventListener("visibilitychange", pause);
