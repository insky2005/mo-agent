/**
 * 极简参数解析：--key value / --key=value / --flag / 位置参数。
 * 重复出现的关键字会聚成数组。
 */
export function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      let key;
      let value;
      if (eq > 0) {
        key = token.slice(2, eq);
        value = token.slice(eq + 1);
      } else {
        key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i += 1;
        } else {
          value = true;
        }
      }
      (options[key] ||= []).push(value);
    } else {
      positional.push(token);
    }
  }
  return { positional, options };
}

export function one(options, key, fallback) {
  const values = options[key];
  if (!values || !values.length) return fallback;
  return values[values.length - 1];
}

export function all(options, key) {
  const values = options[key];
  if (!values) return [];
  return values.flatMap((value) => (value === true ? [true] : [String(value)]));
}

export function has(options, key) {
  return Boolean(options[key] && options[key].length);
}
