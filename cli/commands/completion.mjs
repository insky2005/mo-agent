import { MoError } from "../../core/errors.mjs";
import { emit } from "../lib/output.mjs";
import { complete, describe } from "../lib/complete.mjs";

// 用单引号拼接 shell 脚本：这些脚本里大量 ${...}，放进模板字符串会与 JS 插值打架。

const BASH = [
  '# mo 补全（bash）：eval "$(mo completion bash)"',
  "_mo_complete() {",
  "  COMPREPLY=()",
  "  while IFS= read -r line; do",
  '    COMPREPLY+=("$line")',
  '  done < <(mo __complete "${COMP_WORDS[@]:1}" 2>/dev/null)',
  "}",
  "complete -o default -F _mo_complete mo",
  "",
].join("\n");

const ZSH = [
  "#compdef mo",
  '# mo 补全（zsh）：eval "$(mo completion zsh)"',
  "_mo() {",
  "  local -a items",
  '  items=(${(f)"$(mo __complete --describe "${words[@]:1}" 2>/dev/null)"})',
  "  if (( ${#items} )); then",
  "    _describe 'mo' items",
  "  else",
  "    _files",
  "  fi",
  "}",
  "compdef _mo mo",
  "",
].join("\n");

export function completionCommand(ctx, args) {
  const shell = args.positional[0] || "zsh";
  if (shell === "bash") {
    emit(args.options, { shell, script: BASH }, BASH);
    return 0;
  }
  if (shell === "zsh") {
    emit(args.options, { shell, script: ZSH }, ZSH);
    return 0;
  }
  throw new MoError("E_USAGE", "未知 shell：" + shell + "（可用：bash / zsh）");
}

/** 隐藏命令：给补全脚本回调，只输出候选，不做别的 */
export function completeCommand(ctx, { words = [], describe: withDescription = false } = {}) {
  const items = complete({ cwd: ctx.cwd, words: words.map(String) });
  const lines = items.map((entry) => (withDescription ? describe(entry) : entry.value));
  if (lines.length) process.stdout.write(lines.join("\n") + "\n");
  return 0;
}