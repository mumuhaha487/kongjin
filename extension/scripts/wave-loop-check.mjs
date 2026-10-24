import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";

// Sample the rendered CSS animation endpoints, including the rear outline.
export async function verifyWaveLoops(page) {
  await mkdir("tests/wave-seams", { recursive: true });
  const results = [];
  const cleanup = await page.addStyleTag({
    content: `#stage,.topbar,.static-sky,.orbit-canvas,.twinkle-layer,.orbit-glint-sprite,.sync-status{visibility:hidden!important}.cloud-wave{visibility:hidden}`,
  });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.classList.remove("background-static");
    }, theme);
    await page.waitForTimeout(200);
    for (let layer = 0; layer < 3; layer++) {
      await page.locator(".cloud-wave").evaluateAll((waves, layer) => {
        for (const [i, wave] of waves.entries()) {
          wave.style.visibility = i === layer ? "visible" : "hidden";
          const animation = wave.getAnimations()[0];
          animation.pause();
          animation.effect.updateTiming({
            delay: 0,
            iterations: 1,
            fill: "both",
          });
          animation.currentTime = 0;
        }
      }, layer);
      const pixels = [];
      const transforms = [];
      const fill = await page
        .locator(".cloud-wave")
        .nth(layer)
        .evaluate((canvas) => [...canvas.getContext('2d').getImageData(0,canvas.height-1,1,1).data].slice(0,3));
      for (const progress of [0, 1]) {
        transforms.push(
          await page
            .locator(".cloud-wave")
            .nth(layer)
            .evaluate((wave, progress) => {
              const animation = wave.getAnimations()[0];
              animation.currentTime =
                Number(animation.effect.getTiming().duration) * progress;
              return new DOMMatrix(getComputedStyle(wave).transform).e;
            }, progress),
        );
        const png = await page.locator(".cloud-sea").screenshot({
          path: `tests/wave-seams/${theme}-${layer}-${progress * 100}.png`,
          animations: "allow",
        });
        pixels.push(await sharp(png).ensureAlpha().raw().toBuffer());
        // Prove this is the visible wave fill, not two identical empty frames.
        assert.deepEqual([...pixels.at(-1).subarray(-4, -1)], fill);
      }
      assert.equal(transforms[0], 0);
      assert.equal(transforms[1], -1440);
      assert.equal(pixels[0].length, pixels[1].length);
      let max = 0,
        sum = 0;
      for (let i = 0; i < pixels[0].length; i++) {
        const difference = Math.abs(pixels[0][i] - pixels[1][i]);
        max = Math.max(max, difference);
        sum += difference;
      }
      results.push({
        theme,
        layer,
        transforms,
        maxChannelDifference: max / 255,
        meanChannelDifference: sum / pixels[0].length / 255,
      });
      assert.ok(
        max / 255 < 1 / 255,
        `${theme} wave ${layer} jumps by ${max}/255`,
      );
    }
  }
  await cleanup.evaluate((element) => element.remove());
  await writeFile(
    "tests/wave-loop-result.json",
    JSON.stringify(
      {
        passed: true,
        method:
          "DPR2 browser screenshots of each isolated layer at actual CSS animation 0% and 100%; max absolute RGBA channel difference <1/255",
        results,
      },
      null,
      2,
    ),
  );
  return results;
}
