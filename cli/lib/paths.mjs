import os from "node:os";
import path from "node:path";

export function moHome(env = process.env) {
  return path.resolve(env.MO_AGENT_HOME || path.join(os.homedir(), ".mo-agent"));
}

/**
 * 数据目录，但 home 可注入（便于测试与 daemon 这类"拿 os.homedir() 又可能被
 * MO_AGENT_HOME 改写"的场合）。MO_AGENT_HOME 优先，否则 <home>/.mo-agent。
 */
export function dataDirFrom(home = os.homedir(), env = process.env) {
  return env.MO_AGENT_HOME ? path.resolve(env.MO_AGENT_HOME) : path.join(home, ".mo-agent");
}

export function projectDir(root) {
  return path.join(root, ".mo-agent");
}

export function taskDir(root) {
  return path.join(projectDir(root), "tasks");
}

export function receiptDir(root) {
  return path.join(projectDir(root), "receipts");
}

export function projectFile(root) {
  return path.join(projectDir(root), "project.json");
}

export function cardPath(root, taskId) {
  return path.join(taskDir(root), taskId + ".md");
}

export function receiptPath(root, taskId) {
  return path.join(receiptDir(root), taskId + ".json");
}

export function logDir(root) {
  return path.join(projectDir(root), "logs");
}

export function logPath(root, taskId) {
  return path.join(logDir(root), taskId + ".log");
}

export function ledgerDir(home) {
  return path.join(home, "ledger");
}

export function ledgerFile(home, date = new Date()) {
  const stamp = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
  return path.join(ledgerDir(home), stamp + ".jsonl");
}