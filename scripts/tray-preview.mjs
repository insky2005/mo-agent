import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRAY_CANDIDATES } from "./tray-icons.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const SIZE = 140;
const PAD = 26;

async function tile(svg, dark) {
  const bg = dark ? "#1b1b1d" : "#f2f0ec";
  const fg = dark ? "#ffffff" : "#000000";
  const glyph = await sharp(Buffer.from(svg.replace(/#000000|#000/g, fg)), { density: 600 })
    .resize(SIZE - PAD * 2, SIZE - PAD * 2).png().toBuffer();
  return sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: bg } })
    .composite([{ input: glyph, top: PAD, left: PAD }]).png().toBuffer();
}

async function main() {
  const entries = Object.entries(TRAY_CANDIDATES);
  const tiles = [];
  for (const dark of [false, true]) {
    for (const [, item] of entries) tiles.push(await tile(item.svg, dark));
  }
  const COLS = entries.length;
  const composite = tiles.map((input, index) => ({
    input,
    left: (index % COLS) * SIZE,
    top: Math.floor(index / COLS) * SIZE,
  }));
  const target = path.join(root, "docs", "tray-candidates.png");
  await sharp({ create: { width: SIZE * COLS, height: SIZE * 2, channels: 4, background: "#888888" } })
    .composite(composite).png().toFile(target);
  console.log("候选图: docs/tray-candidates.png（上排浅色底、下排深色底）");
  console.log("顺序: " + entries.map(([id, c]) => id + "(" + c.note + ")").join("  |  "));
}

main().catch((error) => { console.error(error); process.exit(1); });
