/**
 * 常见 Agent 的执行模板。
 *
 * 命名规则：
 *   claude            会话型：新终端窗口跑交互式 CLI，过程可见
 *   claude-headless   无头型：mo 起子进程，stdin 传卡（CI / 批量）
 *
 * 会话型靠 `session: true` 区分；无头模板必须能从 stdin 读 prompt 且能写文件。
 */
import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";

const SESSION_NOTE = "（新终端窗口，过程可见）";

export const EXECUTORS = {
  // ---- 会话型（默认名字）----
  claude: {
    command: "claude",
    description: "Claude Code 交互会话" + SESSION_NOTE,
    requires: "claude",
    session: true,
  },
  codex: {
    command: "codex",
    description: "Codex CLI 交互会话" + SESSION_NOTE,
    requires: "codex",
    session: true,
  },
  qodercli: {
    command: "qodercli",
    description: "Qoder CLI（国际版）交互会话" + SESSION_NOTE,
    requires: "qodercli",
    session: true,
  },
  qoderclicn: {
    command: "qoderclicn",
    description: "Qoder CLI（CN 版）交互会话" + SESSION_NOTE,
    requires: "qoderclicn",
    session: true,
  },
  pi: {
    command: "pi",
    description: "pi 交互会话" + SESSION_NOTE,
    requires: "pi",
    session: true,
  },
  qwen: {
    command: "qwen",
    description: "Qwen Code 交互会话" + SESSION_NOTE,
    requires: "qwen",
    session: true,
  },

  // ---- 无头型（-headless 后缀）----
  "claude-headless": {
    command: 'claude -p "$(cat)" --permission-mode acceptEdits',
    description: "Claude Code，无头，允许在工作区改文件",
    requires: "claude",
  },
  "codex-headless": {
    command: "codex exec -s workspace-write -",
    description: "Codex CLI，无头，工作区可写",
    requires: "codex",
  },
  "qodercli-headless": {
    command: 'qodercli -p "$(cat)" --permission-mode accept_edits',
    description: "Qoder CLI（国际版），无头，允许改文件",
    requires: "qodercli",
  },
  "qoderclicn-headless": {
    command: 'qoderclicn -p "$(cat)" --permission-mode accept_edits',
    description: "Qoder CLI（CN 版），无头，允许改文件",
    requires: "qoderclicn",
  },
  "pi-headless": {
    command: 'pi -p "$(cat)"',
    description: "pi，无头，非交互模式",
    requires: "pi",
  },
  "qwen-headless": {
    command: 'qwen --approval-mode auto-edit "$(cat)"',
    description: "Qwen Code，无头，自动批准文件编辑",
    requires: "qwen",
  },
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);
const WRAPPERS = new Set(["env", "nohup", "command", "exec", "time", "sudo"]);

function tokenize(command) {
  return String(command).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
}

function unquote(token) {
  return String(token).replace(/^["']|["']$/g, "");
}

function resolveTokens(tokens, depth = 0) {
  if (!tokens.length || depth > 5) return "";

  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  if (index >= tokens.length) return "";

  const binary = unquote(tokens[index]);
  const base = binary.split("/").pop();
  const rest = tokens.slice(index + 1);

  // bash -lc 'claude …'：递归解析引号里的命令
  if (SHELLS.has(base)) {
    const flagIndex = rest.findIndex((token) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(unquote(token)));
    if (flagIndex >= 0 && rest[flagIndex + 1]) {
      return resolveTokens(tokenize(unquote(rest[flagIndex + 1])), depth + 1);
    }
    return binary;
  }

  if (WRAPPERS.has(base)) return resolveTokens(rest, depth + 1);
  return binary;
}

/** 从命令里取出真正要执行的程序：跳过 VAR=value、shell 包装与引号 */
export function binaryOf(command) {
  return resolveTokens(tokenize(command));
}

export function resolveAgent(name) {
  const key = String(name).trim();
  const preset = EXECUTORS[key];
  if (!preset) {
    throw new MoError("E_USAGE", "未知执行者：" + key, {
      hint: "可用：" + Object.keys(EXECUTORS).join(" / ") + "；自定义命令请用 --exec",
    });
  }
  const binary = preset.requires || binaryOf(preset.command);
  return { name: key, ...preset, binary, installed: Boolean(which(binary)), path: which(binary) };
}

/** 在 PATH 里找可执行文件（不执行它） */
export function which(binary) {
  if (String(binary).includes(path.sep) || String(binary).includes("/")) {
    try {
      fs.accessSync(binary, fs.constants.X_OK);
      return binary;
    } catch {
      return null;
    }
  }
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 继续找
    }
  }
  return null;
}

/**
 * 一个 worker 能不能用，要同时满足两件事：
 *   - 命令里实际调用的程序存在（binaryOf 解析）
 *   - 声明的 requires 存在（如果声明了）
 * 例：命令是 `node run.mjs`，但 requires: "claude"，那 node 和 claude 都得在。
 */
export function workerStatus(preset) {
  const program = binaryOf(preset.command);
  const requires = preset.requires || "";
  const programPath = program ? which(program) : null;
  const requiresPath = requires ? which(requires) : null;

  const missing = [];
  if (program && !programPath) missing.push(program);
  if (requires && !requiresPath) missing.push(requires);

  return {
    program,
    requires: requires || null,
    installed: missing.length === 0,
    missing: [...new Set(missing)],
    path: programPath,
    requiresPath,
  };
}

export function listAgents() {
  return Object.entries(EXECUTORS).map(([name, preset]) => {
    const status = workerStatus(preset);
    return {
      name,
      command: preset.command,
      description: preset.description,
      requires: preset.requires,
      binary: status.program,
      installed: status.installed,
      missing: status.missing,
      path: status.path,
    };
  });
}