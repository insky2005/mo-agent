export function isJson(options) {
  return Boolean(options.json && options.json.length);
}

export function emit(options, payload, human) {
  if (isJson(options)) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  process.stdout.write((typeof human === "function" ? human(payload) : String(human ?? "")) + "\n");
}

export function table(rows, headers) {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) => Math.max(...all.map((row) => String(row[column] ?? "").length)));
  return all
    .map((row) => headers.map((_, column) => String(row[column] ?? "").padEnd(widths[column])).join("  ").trimEnd())
    .join("\n");
}

/** 按终端显示宽度补空格：中日韩字符占两格，避免中文列错位 */
export function padDisplay(text, width) {
  const value = String(text);
  let used = 0;
  for (const ch of value) used += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return value + " ".repeat(Math.max(0, width - used));
}
