import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAVY, svgSquircle, svgForeground, svgTray, traySvg } from "./icon-art.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const CELL = 200;
const PAD = 30;
const ART = CELL - PAD * 2;

async function png(svg, size) {
  return sharp(Buffer.from(svg), { density: 900 }).resize(size, size).png().toBuffer();
}

async function cell(background, layers) {
  const composites = [];
  for (const layer of layers) {
    const buf = await png(layer.svg, layer.size);
    const clipped = layer.circle
      ? await sharp(buf).composite([{ input: await png('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#fff"/></svg>', layer.size), blend: "dest-in" }]).png().toBuffer()
      : buf;
    composites.push({ input: clipped, top: PAD, left: PAD });
  }
  return sharp({ create: { width: CELL, height: CELL, channels: 4, background } }).composite(composites).png().toBuffer();
}

async function main() {
  const cells = [];

  // 1) macOS App 图标
  cells.push(await cell("#2a2a2e", [{ svg: svgSquircle, size: ART }]));

  // 2) 托盘图：浅色菜单栏 → 系统用黑色
  cells.push(await cell("#f2f0ec", [{ svg: svgTray, size: ART }]));

  // 3) 托盘图：深色菜单栏 → 系统自动反色成白色（模拟真实观感）
  cells.push(await cell("#1b1b1d", [{ svg: traySvg("#fff"), size: ART }]));

  // 4) Android 自适应图标：真实遮罩（圆形可见区约为画布的 72/108）
  const mask = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"><circle cx="54" cy="54" r="36" fill="' + NAVY + '"/></svg>';
  cells.push(await cell("#2a2a2e", [
    { svg: mask, size: ART },
    { svg: svgForeground, size: ART, circle: true },
  ]));

  // 5) 托盘图在真实 18px 下放大（nearest），检查小尺寸可辨性
  const small = await png(traySvg("#fff"), 18);
  const strip = await sharp({ create: { width: 18, height: 18, channels: 4, background: "#1b1b1d" } })
    .composite([{ input: small }]).png().toBuffer();
  cells.push(await sharp(strip).resize(CELL, CELL, { kernel: "nearest" }).png().toBuffer());

  await sharp({ create: { width: CELL * cells.length, height: CELL, channels: 4, background: "#2a2a2e" } })
    .composite(cells.map((input, i) => ({ input, left: i * CELL, top: 0 })))
    .png().toFile(path.join(root, "docs", "icon-preview.png"));

  console.log("预览: docs/icon-preview.png");
  console.log("顺序: App图标 | 托盘(浅底=黑) | 托盘(深底=白) | Android自适应 | 托盘18px放大");
}

main().catch((error) => { console.error(error); process.exit(1); });
