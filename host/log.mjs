const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level) {
  const min = LEVELS[level] || LEVELS.info;
  const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
  const fmt = (v) => {
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  };
  const write = (name, args) => {
    if ((LEVELS[name] || 0) < min) return;
    const line = "[" + stamp() + "] [" + name.toUpperCase() + "] " + args.map(fmt).join(" ");
    if (name === "error") console.error(line);
    else console.log(line);
  };
  return {
    debug: (...a) => write("debug", a),
    info: (...a) => write("info", a),
    warn: (...a) => write("warn", a),
    error: (...a) => write("error", a),
  };
}
