// 机器人头图标字形（唯一定义处，各处派生共用）
export const NAVY = "#0b1020";

const BLUE = "#4f8cff";
const EYE = "#a8c6ff";
const GREEN = "#35d19a";

/** App 图标用的彩色机器人头（坐标空间 192x192） */
export const GLYPH = [
  '<line x1="96" y1="40" x2="96" y2="56" stroke="' + BLUE + '" stroke-width="7" stroke-linecap="round"/>',
  '<circle cx="96" cy="33" r="9" fill="' + GREEN + '"/>',
  '<rect x="30" y="84" width="14" height="34" rx="7" fill="' + BLUE + '"/>',
  '<rect x="148" y="84" width="14" height="34" rx="7" fill="' + BLUE + '"/>',
  '<rect x="46" y="54" width="100" height="88" rx="27" fill="' + BLUE + '"/>',
  '<rect x="60" y="70" width="72" height="56" rx="17" fill="' + NAVY + '"/>',
  '<circle cx="80" cy="96" r="9.5" fill="' + EYE + '"/>',
  '<circle cx="112" cy="96" r="9.5" fill="' + EYE + '"/>',
  '<rect x="82" y="112" width="28" height="6" rx="3" fill="' + GREEN + '"/>',
].join("");

/** 只有机器人头、无底色：启动页 / 网页左上角用它叠在深色底上 */
export const svgGlyph = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">' + GLYPH + "</svg>";

export const svgSquircle = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="44" fill="' + NAVY + '"/>' + GLYPH + "</svg>";
export const svgCircle = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><circle cx="96" cy="96" r="96" fill="' + NAVY + '"/>' + GLYPH + "</svg>";

/** Android 自适应前景：无底色，缩到安全区内 */
export const svgForeground = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">',
  '<g transform="translate(54 54) scale(0.44) translate(-96 -83)">',
  GLYPH,
  "</g></svg>",
].join("");

/**
 * 托盘单色图：比 App 图标更粗更大，保证 18px 实际尺寸下仍可辨。
 * 用 mask 把眼睛和嘴挖成透明——macOS 模板图靠 alpha 通道上色，按亮暗主题自动反色。
 * 导出为工厂函数的原因：mask 里的黑色是"不透明底"，不能连同图形颜色一起替换。
 */
export function traySvg(color) {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">',
    '<defs><mask id="m">',
    '<rect width="36" height="36" fill="#000"/>',
    '<circle cx="18" cy="5.2" r="3.1" fill="#fff"/>',
    '<rect x="16.3" y="7" width="3.4" height="5" rx="1.7" fill="#fff"/>',
    '<rect x="2" y="14.6" width="4.4" height="9" rx="2.2" fill="#fff"/>',
    '<rect x="29.6" y="14.6" width="4.4" height="9" rx="2.2" fill="#fff"/>',
    '<rect x="6.4" y="9.4" width="23.2" height="22" rx="7" fill="#fff"/>',
    '<circle cx="13.4" cy="19.4" r="3.2" fill="#000"/>',
    '<circle cx="22.6" cy="19.4" r="3.2" fill="#000"/>',
    '<rect x="13.6" y="25.2" width="8.8" height="2.4" rx="1.2" fill="#000"/>',
    "</mask></defs>",
    '<rect width="36" height="36" fill="' + (color || "#000") + '" mask="url(#m)"/>',
    "</svg>",
  ].join("");
}

/** Android 系统启动页用的方形图标：无底色、四周留白，避免被拉伸变形 */
export const svgSplashIcon = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">',
  '<g transform="translate(96 96) scale(0.8) translate(-96 -83)">',
  GLYPH,
  "</g></svg>",
].join("");

export const svgTray = traySvg("#000");
