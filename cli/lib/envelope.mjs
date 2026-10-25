/**
 * 派单信封：执行者拿到的全部上下文。
 * 卡片全文内嵌，路径只用于回执落盘。见 docs/spec/workbench-flow.md §7.2。
 */
export function buildEnvelope({ meta, body, root, receiptFile, knowledge, workdir }) {
  const lines = [
    "你是执行者。按下面的任务卡交付，不要修改任务卡本身。",
    "",
    "--- 任务卡 ---",
    "id: " + meta.id,
    "项目: " + (meta.name ? meta.name + " (" + meta.project + ")" : meta.project),
    "标题: " + meta.title,
    "工作目录: " + (workdir || root),
    "",
    body.trim(),
    "",
    "--- 回执要求 ---",
    "完成后必须做三件事，缺一视为未完成：",
    "1. 把回执写到：" + receiptFile,
    "2. 逐条对照验收标准，把结果填进 verify",
    "3. 输出一行：RECEIPT_WRITTEN " + receiptFile,
    "",
    "回执 JSON 模板：",
    JSON.stringify(
      {
        taskId: meta.id,
        status: "done|partial|failed|blocked",
        summary: "一句话结论",
        artifacts: [{ path: "相对项目根的路径", kind: "file" }],
        verify: [{ cmd: "跑过的命令", exit: 0 }],
        deviations: ["没按卡来的地方"],
        pitfalls: [{ symptom: "", trigger: "", cause: "", fix: "" }],
        needs: ["需要人确认的事"],
      },
      null,
      2,
    ),
    "",
    // §7.2：命中的偏好/避坑直接嵌进来，执行者不用再去读文件
    ...(knowledge ? [knowledge.trim(), ""] : []),
    "环境变量：MO_TASK_ID / MO_PROJECT / MO_PROJECT_ROOT / MO_RECEIPT",
    "",
  ];
  return lines.join("\n");
}

/** 45m / 30s / 2h → 毫秒；无法解析时用默认值 */
export function parseDuration(value, fallbackMs = 45 * 60 * 1000) {
  if (value === undefined || value === null || value === true) return fallbackMs;
  const text = String(value).trim();
  const matched = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(text);
  if (!matched) return fallbackMs;
  const amount = Number(matched[1]);
  const unit = (matched[2] || "m").toLowerCase();
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60 * 1000 : 60 * 60 * 1000;
  return Math.round(amount * factor);
}
