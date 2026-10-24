import sharp from "sharp";
import { readdir } from "node:fs/promises";
const root = "../docs/v5-perf/screenshots";
for (const theme of ["dark", "light"]) {
  const files = (await readdir(root))
    .filter((f) => f.startsWith("round2-overflow-") && f.endsWith(theme + ".png"))
    .sort();
  const cellWidth = 280,
    cellHeight = theme === "dark" ? 526 : 650;
  for (let offset = 0; offset < files.length; offset += 8) {
    const cells = [];
    for (const [i, file] of files.slice(offset, offset + 8).entries()) {
      const image = await sharp(root + "/" + file)
        .resize({ width: cellWidth })
        .png()
        .toBuffer();
      const title = file
        .replace(/^round2-overflow-/, "")
        .replace(/-(360|412)-(100|130)-(light|dark)\.png$/, "");
      const label = await sharp(
        Buffer.from(
          `<svg width="280" height="26"><rect width="100%" height="100%" fill="#fff"/><text x="6" y="18" font-family="Arial" font-size="13" fill="#111">${title}</text></svg>`,
        ),
      )
        .png()
        .toBuffer();
      cells.push({
        input: label,
        left: (i % 4) * cellWidth,
        top: Math.floor(i / 4) * cellHeight,
      });
      cells.push({
        input: image,
        left: (i % 4) * cellWidth,
        top: Math.floor(i / 4) * cellHeight + 26,
      });
    }
    const path = `${root}/round2-review-${theme}-${offset / 8 + 1}.png`;
    await sharp({
      create: {
        width: cellWidth * 4,
        height: cellHeight * 2,
        channels: 3,
        background: "#ddd",
      },
    })
      .composite(cells)
      .png()
      .toFile(path);
    console.log(path);
  }
}
