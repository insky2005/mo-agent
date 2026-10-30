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
