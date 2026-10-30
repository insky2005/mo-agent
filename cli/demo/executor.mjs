#!/usr/bin/env node
/**
 * 演示用执行者：读 MO_RECEIPT 环境变量，写一份合法回执，并在项目里产出一个文件。
 * 不调用任何模型、不联网，用于手动测试流程。
 */
import fs from "node:fs";
import path from "node:path";

const receiptFile = process.env.MO_RECEIPT;
if (!receiptFile) {
  console.error("缺少 MO_RECEIPT：这个脚本应由 mo 派单时启动");
  process.exit(2);
}

const root = process.env.MO_PROJECT_ROOT || process.cwd();
const artifact = "demo-output.txt";
fs.writeFileSync(path.join(root, artifact), "hello from demo executor\n");

fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
fs.writeFileSync(
  receiptFile,
  JSON.stringify(
    {
      taskId: process.env.MO_TASK_ID,
      status: "done",
      summary: "演示执行者：已按卡交付",
      artifacts: [{ path: artifact, kind: "file" }],
      verify: [{ cmd: "demo-executor", exit: 0 }],
      deviations: [],
      pitfalls: [],
      needs: [],
    },
    null,
    2,
  ),
);

console.log("RECEIPT_WRITTEN " + receiptFile);
