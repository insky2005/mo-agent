import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAVY, svgSquircle, svgCircle, svgForeground, svgGlyph, svgSplashIcon, svgTray } from "./icon-art.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const ICONSET = path.join(root, "desktop", "icon.iconset");
const TRAY_OUT = path.join(root, "desktop", "src", "mainview", "tray.png");
const PWA_SVG = path.join(root, "app", "web", "icon.svg");
const RES = path.join(root, "app", "android", "app", "src", "main", "res");

const MAC_SIZES = [
  ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
];

const ANDROID = [
  ["mdpi", 48, 108],
  ["hdpi", 72, 162],
  ["xhdpi", 96, 216],
  ["xxhdpi", 144, 324],
  ["xxxhdpi", 192, 432],
];

async function render(svg, size, out) {
  await sharp(Buffer.from(svg), { density: 900 }).resize(size, size).png().toFile(out);
}

async function png(svg, size) {
  return sharp(Buffer.from(svg), { density: 900 }).resize(size, size).png().toBuffer();
}

/** 启动页：沿用原文件的像素尺寸重绘，避免猜错各密度的规格 */
async function regenerateSplashes() {
  const files = [];
  for (const dir of fs.readdirSync(RES)) {
    if (!dir.startsWith("drawable")) continue;
    const file = path.join(RES, dir, "splash.png");
    if (fs.existsSync(file)) files.push(file);
  }
  for (const file of files) {
    const meta = await sharp(file).metadata();
    const width = meta.width;
    const height = meta.height;
    if (!width || !height) continue;
    const head = Math.round(Math.min(width, height) * 0.34);
    const glyph = await png(svgGlyph, head);
    await sharp({ create: { width, height, channels: 4, background: NAVY } })
      .composite([{ input: glyph, gravity: "centre" }])
      .png()
      .toFile(file);
  }
  return files.length;
}

async function main() {
  fs.mkdirSync(ICONSET, { recursive: true });
  for (const [name, size] of MAC_SIZES) {
    await render(svgSquircle, size, path.join(ICONSET, name));
  }
  console.log("macOS 图标: desktop/icon.iconset（" + MAC_SIZES.length + " 个尺寸）");

  fs.mkdirSync(path.dirname(TRAY_OUT), { recursive: true });
  await render(svgTray, 36, TRAY_OUT);
  console.log("托盘单色图: desktop/src/mainview/tray.png");

  fs.writeFileSync(PWA_SVG, svgSquircle + "\n");
  console.log("PWA 图标: app/web/icon.svg");

  let androidDirs = 0;
  for (const [density, legacy, foreground] of ANDROID) {
    const dir = path.join(RES, "mipmap-" + density);
    if (!fs.existsSync(dir)) continue;
    await render(svgSquircle, legacy, path.join(dir, "ic_launcher.png"));
    await render(svgCircle, legacy, path.join(dir, "ic_launcher_round.png"));
    await render(svgForeground, foreground, path.join(dir, "ic_launcher_foreground.png"));
    androidDirs += 1;
  }
  console.log("Android 图标: " + androidDirs + " 个密度");

  // Android 12+ 系统启动页的方形图标（否则它会把全屏图塞进图标槽位拉扁）
  await render(svgSplashIcon, 512, path.join(RES, "drawable", "splash_icon.png"));
  console.log("Android 启动图标: res/drawable/splash_icon.png");

  const splashCount = await regenerateSplashes();
  console.log("Android 启动页: " + splashCount + " 张（按原尺寸重绘）");
  console.log("重新打包：scripts/build-desktop.sh 与 scripts/build-android.sh");
}

main().catch((error) => { console.error(error); process.exit(1); });

