/**
 * 常见 Agent 的执行模板。
 *
 * 收录原则：非交互、能从 stdin 读 prompt、且**能写文件**——
 * 写不了 $MO_RECEIPT 的执行者拿不到 done，给了也是坑。
 *
 * 桌面端 Agent（Qoder 桌面版、WorkBuddy）没有 headless 入口，不在这里。
 */
import fs from "node:fs";
import path from "node:path";
import { MoError } from "../../core/errors.mjs";

export const EXECUTORS = {
  claude: {
    command: 'claude -p "$(cat)" --permission-mode acceptEdits',
    description: "Claude Code，允许在工作区改文件",
    requires: "claude",
  },
  codex: {
    command: "codex exec -s workspace-write -",
    description: "Codex CLI，工作区可写",
    requires: "codex",
  },
  qodercli: {
    command: 'qodercli -p "$(cat)" --permission-mode accept_edits',
    description: "Qoder CLI（国际版），允许改文件",
    requires: "qodercli",
  },
  qoderclicn: {
    command: 'qoderclicn -p "$(cat)" --permission-mode accept_edits',
    description: "Qoder CLI（CN 版），允许改文件",
    requires: "qoderclicn",
  },
  pi: {
    command: 'pi -p "$(cat)"',
    description: "pi，非交互模式",
    requires: "pi",
  },
  qwen: {
    command: 'qwen --approval-mode auto-edit "$(cat)"',
    description: "Qwen Code，自动批准文件编辑",
    requires: "qwen",
  },

  // ---- 会话型：开一个新窗口跑交互式 CLI，人在旁边看着 ----
  // 与上面的无头模板并存：无头适合 CI/批量，会话型适合"我想看它干活"。
  "claude-session": {
    command: "claude",
    description: "Claude Code 交互会话（新终端窗口，过程可见）",
    requires: "claude",
    session: true,
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