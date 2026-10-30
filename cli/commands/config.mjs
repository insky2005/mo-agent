import { MoError } from "../../core/errors.mjs";
import { emit, table } from "../lib/output.mjs";
import { moHome } from "../lib/paths.mjs";
import { defaultMemoryDir } from "../lib/knowledge.mjs";
import { CONFIG_KEYS, configKey, effectiveConfig, readGlobalConfig, writeGlobalConfig } from "../lib/config.mjs";

/**
 * mo config —— 只读写 ~/.mo-agent/config.json。
 * 不碰环境变量、不碰 shell rc；环境变量的覆盖只在 list 的来源里体现。
 */

const USAGE = "可用：list / get <键> / set <键> <值> / unset <键>";

const SOURCE_LABEL = { default: "默认", file: "config.json", env: "环境变量" };

function sourceLabel(source) {
  return SOURCE_LABEL[source] || source;
}

function display(value, key, home) {
  if (value !== "") return String(value);
  if (key === "memoryPath") return "空 → " + defaultMemoryDir(home);
  return "（默认目录）";
}

export function configCommand(ctx, args) {
  const sub = args.positional[0] || "list";
  const home = moHome();
  if (sub === "list") return listCommand(args, home);
  if (sub === "get") return getCommand(args, home);
  if (sub === "set") return setCommand(args, home);
  if (sub === "unset") return unsetCommand(args, home);
  throw new MoError("E_USAGE", "未知子命令：config " + sub + "（" + USAGE + "）");
}

function listCommand(args, home) {
  const effective = effectiveConfig({ home });
  const config = CONFIG_KEYS.map((spec) => ({
    key: spec.key,
    value: effective[spec.key].value,
    source: effective[spec.key].source,
    default: spec.default,
  }));

  emit(args.options, { config }, () =>
    table(
      config.map((item) => [item.key, display(item.value, item.key, home), sourceLabel(item.source), display(item.default, item.key, home)]),
      ["键", "值", "来源", "默认"],
    )
      .replace(/[ \t]+$/gm, "")
      + "\n\n修改：mo config set <键> <值>；恢复默认：mo config unset <键>");
  return 0;
}

function requireKey(args, position) {
  const key = args.positional[position];
  if (!key) throw new MoError("E_USAGE", "缺少配置键", { hint: USAGE });
  if (!configKey(key)) {
    const keys = CONFIG_KEYS.map((spec) => spec.key).join(" / ");
    throw new MoError("E_USAGE", "未知配置键：" + key, { hint: "可用：" + keys + "；mo config list 查看全部" });
  }
  return key;
}

function getCommand(args, home) {
  const key = requireKey(args, 1);
  const { value, source } = effectiveConfig({ home })[key];
  emit(args.options, { key, value, source, default: configKey(key).default }, () =>
    display(value, key, home) + "\n  （来源：" + sourceLabel(source) + "）");
  return 0;
}

function setCommand(args, home) {
  const key = requireKey(args, 1);
  const raw = args.positional[2];
  if (raw === undefined) {
    throw new MoError("E_USAGE", "缺少值：mo config set " + key + " <值>", {
      hint: "取值范围：" + configKey(key).range,
    });
  }

  let result;
  try {
    result = writeGlobalConfig({ home, patch: { [key]: raw } });
  } catch (error) {
    if (error instanceof MoError && error.code === "E_USAGE") {
      throw new MoError("E_USAGE", error.message, { hint: "取值范围：" + configKey(key).range });
    }
    throw error;
  }
  const effective = effectiveConfig({ home })[key];

  emit(
    args.options,
    { ok: true, key, value: effective.value, source: effective.source, file: result.file },
    () =>
      "✓ " + key + " = " + display(effective.value, key, home) + "\n" +
      "  文件   " + result.file +
      (effective.source === "env" ? "\n  注意：环境变量 " + configKey(key).env + " 仍然覆盖它" : ""),
  );
  return 0;
}

function unsetCommand(args, home) {
  const key = requireKey(args, 1);
  const result = writeGlobalConfig({ home, patch: { [key]: undefined } });
  const effective = effectiveConfig({ home })[key];
  const spec = configKey(key);

  emit(
    args.options,
    { ok: true, key, value: effective.value, source: effective.source, file: result.file },
    () =>
      "✓ 已移除 " + key + "（回到默认：" + display(spec.default, key, home) + "）\n" +
      "  文件   " + result.file +
      (effective.source === "env" ? "\n  注意：环境变量 " + spec.env + " 仍在生效" : ""),
  );
  return 0;
}