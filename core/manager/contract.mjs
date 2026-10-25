/**
 * 主 Agent 契约的唯一真源。
 *
 * 这里只有文字与工具清单，不碰文件系统、不发命令。
 * SKILL.md / AGENTS.md 段落 / .mo-agent/MO.md / mo agent describe 全部由 render() 生成，
 * 加通道时不要再手写一份文案。
 */

// 反引号在下面用 ` 占位，最后统一替换，避免模板字符串打架
const BT = String.fromCharCode(96);

export const SERVER = { name: "mo", title: "mo —— 个人工作台" };

const w = (value) => String(value).replace(/`/g, BT);

/** 工具清单：MCP、describe、文案都从这里来 */
export const TOOLS = [
  {
    name: "task_create",
    description: "建一张 draft 任务卡（未确认，不能派单）。返回 taskId 与卡片路径。",
    schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "一句话标题" },
        deliverables: { type: "array", items: { type: "string" }, description: "交付物清单，至少一条" },
        verify: { type: "array", items: { type: "string" }, description: '验收项，形如 "run:npm test" / "check:文件含X" / "human:视觉确认"' },
        boundaries: { type: "array", items: { type: "string" }, description: "边界（不要做什么）" },
        constraints: { type: "array", items: { type: "string" }, description: "约束" },
        background: { type: "string", description: "背景" },
        project: { type: "string", description: "项目名或路径，缺省用当前目录绑定的项目" },
        worker: { type: "string", description: "内置执行者名，与 exec 二选一" },
        exec: { type: "string", description: "自定义执行命令，如 claude -p" },
        timeout: { type: "string", description: "形如 45m / 2h" },
      },
      required: ["title", "deliverables"],
    },
  },
  {
    name: "task_confirm",
    description: "发起任务卡的确认请求（不是确认本身）。支持 elicitation 的客户端会当场弹表单让用户选；否则返回 pending，等人从终端或网页批准。",
    schema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        wait: { type: "string", description: "等批准，如 60s；不给则立即返回 pending" },
        project: { type: "string" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "task_dispatch",
    description: "派发已确认的任务卡，前台等待执行者跑完并做验收。可能耗时数分钟。",
    schema: {
      type: "object",
      properties: { taskId: { type: "string" }, worker: { type: "string" }, exec: { type: "string" }, timeout: { type: "string" }, project: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "task_status",
    description: "查任务状态、验收结果与待批请求。汇报只引用这里的字段。",
    schema: { type: "object", properties: { taskId: { type: "string" }, project: { type: "string" } }, required: ["taskId"] },
  },
  {
    name: "inbox_pull",
    description: "拉取任务通知（done / blocked / failed），拉完归档；主 Agent 用它替代推送。",
    schema: {
      type: "object",
      properties: { peek: { type: "boolean", description: "只看不归档" }, taskId: { type: "string" }, limit: { type: "number" } },
    },
  },
  {
    name: "ledger_query",
    description: "查账本事件（机器事实，优先于任何转述）。",
    schema: {
      type: "object",
      properties: { project: { type: "string" }, taskId: { type: "string" }, type: { type: "string", description: "事件类型前缀，如 task." }, days: { type: "number" }, limit: { type: "number" } },
    },
  },
  {
    name: "memory_recall",
    description: "按关键词从记忆库召回条目（派单时同一条通道会自动注入）。",
    schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, scope: { type: "string", description: "preferences / pitfalls / decisions" } }, required: ["query"] },
  },
  {
    name: "memory_propose",
    description: "提一条记忆候选（不进记忆库，等人裁决）。缺触发条件会被拒收。",
    schema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "preferences / pitfalls / decisions，默认 pitfalls" },
        title: { type: "string" },
        trigger: { type: "array", items: { type: "string" }, description: "触发条件，必填" },
        tags: { type: "array", items: { type: "string" } },
        body: { type: "string" },
      },
      required: ["title", "trigger", "body"],
    },
  },
];

/** 禁止动作：写进文案，也用来校验"不暴露"。cli 是同一件事的 CLI 说法 */
export const FORBIDDEN = [
  { action: "task_approve", cli: "mo task approve", why: "批准任务卡属于人" },
  { action: "task_reject", cli: "mo task reject", why: "拒绝任务卡属于人" },
  { action: "memory_accept", cli: "mo memory accept / mo memory reject", why: "记忆入库属于人的裁决" },
  { action: "receipt_submit", cli: "mo receipt submit", why: "回执属于执行者，伪造等于把系统变摆设" },
];

export const TRIGGERS = [
  ["要落地（开始做 / 落地 / 派给 X / 就这么办）", "建卡 → 回显 → 等批准 → 派单"],
  ["问进度（怎么样了 / 做完了吗）", "先 mo inbox pull 看通知，再 mo task status 按事实汇报"],
  ["纠正你的做法", "问用户要不要改；同意后用 mo memory propose 记成候选"],
  ["其它情况（默认）", "只聊，不碰任何 mo 命令"],
];

export const RULES = [
  "没确认不派单：dispatch 会返回 E_NOT_CONFIRMED；confirm 只是发起请求",
  '没拿到 taskId 不许说"已派发"',
  "执行者退出码 0 但没有回执 = 未完成（blocked/missing_receipt）",
  "不要手改 .mo-agent/tasks/*.md，除非用户明确要求",
  "不要自己写回执",
  "一次对话最多派 3 个任务；不确定就停下来问",
  "安装软件、修改 shell 配置前必须得到明确同意",
];

export const FAILURES = [
  ["E_NOT_CONFIRMED", "卡还没确认", "还差批准，要现在发起吗？"],
  ["E_FORBIDDEN", "批准只能在人的终端里做", "请用户自己执行 mo task approve"],
  ["E_CARD_CHANGED", "批准前卡片被改过", "让用户重新发起确认"],
  ["E_PROJECT_UNBOUND", "当前目录不是项目", "问是否 mo project init ."],
  ["E_NO_EXECUTOR", "卡里没执行者", "问用哪个 --worker 或 --exec"],
  ["blocked(missing_receipt)", "执行者没写回执", "转述 outputTail（常见：未登录）"],
  ["blocked(bad_receipt)", "回执不合法", "转述 errors"],
  ["blocked(timeout)", "超时", "问重试还是换执行者"],
];

const FRONTMATTER = [
  "---",
  "name: mo",
  "description: 把讨论落成任务卡并派给执行 Agent。用户说\"开始做/落地/派给 X/就这么办\"，要查看任务进度与验收结果，或要安装/初始化 mo 工具时使用。",
  "license: PolyForm-Noncommercial-1.0.0",
  "compatibility: 需要 mo CLI（单文件二进制或 npm 包）。安装见仓库 scripts/install-cli.sh 或 install-remote.sh。",
  "metadata:",
  "  author: mo-agent",
  "  homepage: https://github.com/insky2005/mo-agent",
  "---",
  "",
  "# mo",
  "",
  "用 `mo` 把\"聊出来的想法\"固化成任务卡，派给任意执行 Agent，最后按账本汇报。",
  "",
];

const INSTALL = [
  "## 前提",
  "",
  "```bash",
  "mo --version          # 不可用 → 见下面的「mo 还没装」",
  "mo doctor             # 顺带确认当前目录属于某个项目",
  "```",
  "",
  "当前目录不是项目时，先问用户是否要 `mo project init .`，**不要自动建**。",
  "",
  "### mo 还没装",
  "",
  "**不要自己猜命令，也不要继续建卡。** 先说明情况，并**征得用户明确同意**再动手——安装会下载二进制、写 `~/.local/bin`，属于改动用户机器。",
  "",
  "#### 用户同意由你安装",
  "",
  "```bash",
  "TMP=\"$(mktemp)\"",
  "curl -fsSL https://raw.githubusercontent.com/insky2005/mo-agent/main/scripts/install-remote.sh -o \"$TMP\"",
  "bash \"$TMP\"",
  "",
  "~/.local/bin/mo --version     # PATH 可能还没刷新，先用绝对路径验证",
  "~/.local/bin/mo skill list    # 确认技能也装上了",
  "```",
  "",
  "装完告诉用户两件事：",
  "",
  "1. **重开终端**后 `mo` 才会在 PATH 里；当前会话用绝对路径 `~/.local/bin/mo` 也能继续；",
  "2. 新终端里执行 `mo --version` 确认。",
  "",
  "之后用绝对路径继续建卡派单是可以的，不需要等用户重开。",
  "",
  "#### 用户不同意，或想自己装",
  "",
  "给出两条命令，然后停下：",
  "",
  "```bash",
  "# Release 单文件二进制（不需要 Node；加 --with-skill 会顺带装技能）",
  "curl -fsSL https://raw.githubusercontent.com/insky2005/mo-agent/main/scripts/install-remote.sh | bash",
  "",
  "# 源码（需要 git 与 Node 18+）",
  "git clone https://github.com/insky2005/mo-agent.git",
  "cd mo-agent",
  "bash scripts/install-cli.sh",
  "```",
  "",
  "源码方式里，没有 bun 时安装脚本会退化为软链到仓库（需要 Node）；有 bun 则构建单文件二进制。",
  "",
  "**不要 `curl … | bash` 一把梭**：先把脚本下到临时文件，让用户有机会先看一眼再执行。",
  "",
];

/** 边界段：所有渲染都带，不允许哪个通道缺一块 */
const BOUNDARY = () => [
  "## 不能做的",
  "",
  ...FORBIDDEN.map((item) => "- " + item.cli + "（" + item.why + "）"),
  "- 手改 .mo-agent/tasks/*.md，除非用户明确要求",
  "",
];

const BEHAVIOR = () => [
  ...BOUNDARY(),
  "## 什么时候动手",
  "",
  "用户提到本技能、或在相关话题里跟你说话——**默认就是\"聊\"**：正常对话，不建卡、不派单、不碰任何 `mo` 命令。技能被加载不代表要立刻执行动作。",
  "",
  "只有出现明确的信号才进下一步：",
  "",
  "| 信号 | 动作 |",
  "|---|---|",
  ...TRIGGERS.map(([signal, action]) => "| " + signal + " | " + action + " |"),
  "",
  "## 建卡",
  "",
  "先把三个字段问清楚：**交付物、验收标准、边界**。缺验收标准要明确提醒，不要静默建卡。",
  "",
  "```bash",
  "mo task create \\",
  "  --title \"一句话说明\" \\",
  "  --deliverable \"可验收的产出\" \\",
  "  --verify \"run:npm test -- --filter x\" \\",
  "  --verify \"check:dist/index.html 存在\" \\",
  "  --boundary \"不要改后端接口\" \\",
  "  --worker <执行者> \\",
  "  --json",
  "```",
  "",
  "`--worker` 用内置执行者（`mo worker list` 看清单和本机是否安装）；需要额外参数时改用 `--exec \"<完整命令>\"`，两者互斥。",
  "",
  "## 派单前必须回显，批准由人做",
  "",
  "把卡摘要给用户，然后**停下等批准**：",
  "",
  "```text",
  "任务：t_01H…",
  "项目：<项目名>",
  "交付：<可验收的产出>",
  "验收：run npm test / human 视觉确认",
  "执行：<执行者>",
  "派发吗？",
  "```",
  "",
  "用 `mo task confirm <taskId>` **发起确认请求**（不改变状态）。批准只能由人完成：",
  "",
  "```bash",
  "mo task confirm <taskId>         # 你发起请求，返回 pending",
  "# 用户在终端：mo task approve <taskId>     （或手机上点允许）",
  "mo task dispatch <taskId> --json # 批准后才能派",
  "```",
  "",
  "`dispatch` 是**前台等待**的：执行者跑完才返回，可能几分钟。可以先把\"已开始\"告诉用户。",
  "",
  "## 汇报",
  "",
  "只引用工具返回的事实，不要替执行者说\"完成了\"。",
  "",
  "```bash",
  "mo inbox pull --json              # 任务结束/阻塞的通知，拉完归档",
  "mo task status <taskId> --json",
  "mo ledger query --task <taskId> --json",
  "```",
  "",
  "- `done` + `verified: verified` → 才算真的完成；",
  "- `done` + `verified: unverified` → 卡上没有能自动跑的验收项，转述给用户确认；",
  "- `blocked` → 说清 `reason`、`exitCode`、`outputTail`；",
  "- `failed` → 同样转述，不要美化。",
  "",
  "## 账本里的发起者",
  "",
  "账本的 `actor` 只有四种值：",
  "",
  "- `agent`：通过 `mo task ...` 发起的动作（建卡、派单、发起确认请求）",
  "- `human`：只用于批准（`mo task approve`）",
  "- `core`：内核判定（完成、阻塞、验收）",
  "- `worker`：执行者交回执",
  "",
  "不要替用户批准——确认权在用户手里。",
  "",
  "## 铁律",
  "",
  ...RULES.map((rule, index) => (index + 1) + ". **" + rule + "**"),
  "",
  "## 常见失败",
  "",
  "| 返回 | 意思 | 你说什么 |",
  "|---|---|---|",
  ...FAILURES.map(([code, meaning, say]) => "| " + "`" + code + "`" + " | " + meaning + " | " + say + " |"),
  "",
];

function behavior() {
  return w(BEHAVIOR().join("\n"));
}

export function renderSkill() {
  return w([...FRONTMATTER, ...INSTALL].join("\n")) + "\n" + behavior();
}

/** 项目内 AGENTS.md 的内联块：短，够用 */
export function renderAgentBlock() {
  return w(
    [
      "## mo",
      "",
      "本仓库用 mo 管理任务。要把讨论落地时：",
      "",
      "1. 补清交付物、验收标准、边界，再 `mo task create --json`；",
      "2. 把卡摘要给用户，**停下等批准**（`mo task confirm <taskId>` 只发起请求，批准由人做）；",
      "3. 批准后 `mo task dispatch <taskId> --json`，只按 `mo task status` / `mo ledger query` 汇报；",
      "4. 执行者没写回执（`missing_receipt`）一律视为未完成。",
    ].join("\n"),
  );
}

/** .mo-agent/MO.md：中等长度，给"引用模式"用 */
export function renderMoDoc() {
  return w(
    [
      "# mo 用法",
      "",
      "本文件由 `mo project init` 生成，供主 Agent 参考。",
      "",
      "## 流程",
      "",
      "1. 补齐交付物、验收标准、边界，再 `mo task create --json`；",
      "2. 卡摘要回显给用户，等批准；",
      "3. `mo task confirm <taskId>` 发起请求 → 批准由人做 → `mo task dispatch <taskId>`；",
      "4. 只按 `mo task status` / `mo ledger query` 汇报。",
      "",
      "## 常用命令",
      "",
      "```bash",
      "mo task list                       # 本项目任务",
      "mo task status <taskId> --json     # 状态、待批请求与事件",
      "mo task requests                   # 待批准的确认请求",
      "mo inbox pull --json               # 任务通知（done / blocked / failed）",
      "mo ledger query --task <taskId>    # 账本流水",
      "mo worker list                     # 可用执行者",
      "```",
      "",
      "## 铁律",
      "",
      ...RULES.map((rule) => "- " + rule + "；"),
      "- 批准/拒绝任务卡（mo task approve / mo task reject）、采纳记忆（mo memory accept）、替执行者写回执，都不是你的事；",
      "",
    ].join("\n"),
  );
}

/** 给只能读文字的 Agent 直接粘贴：不含安装说明 */
export function renderPrompt() {
  return w(
    [
      "# mo 任务派发契约（主 Agent）",
      "",
      "你是\"主 Agent\"：把用户聊出来的想法固化成任务卡，派给执行 Agent，并按账本的事实汇报。",
      "`mo` 是这台机器上的命令行工具，先跑 `mo --version` 确认可用；不确定命令时跑 `mo help`。",
      "",
      "## 你能调用的",
      "",
      ...TOOLS.map((tool) => "- " + tool.name + " —— " + tool.description),
      "",
      ...BEHAVIOR(),
    ].join("\n"),
  );
}

/** 极短指针：技能已装时只留一句 */
export function renderPointer(where) {
  return w(
    [
      "## mo",
      "",
      "本仓库使用 mo。" + (where || "把讨论落地时按已安装的 mo 技能执行") + "，只按 `mo task status` / `mo ledger query` 的事实汇报。",
    ].join("\n"),
  );
}

/**
 * FORMATS 是"能渲染的全部"；DESCRIBE_FORMATS 才是 mo agent describe 暴露的。
 * agent-block / mo-doc / pointer 是 mo project init 落盘用的 payload，
 * 对着终端打印没有意义（它们本来就靠"引用技能/MO.md"来补全细节）。
 */
export const FORMATS = ["skill", "agent-block", "mo-doc", "prompt", "pointer"];
export const DESCRIBE_FORMATS = ["prompt", "skill"];

/** describe 的输出说明：格式 + 一句话用途，直接给 --format list 用 */
export const DESCRIBE_GUIDE = [
  ["prompt", "直接粘进 Agent 的系统提示 / 对话（= describe 默认）"],
  ["skill", "技能文件内容，与 skills/mo/SKILL.md 完全一致"],
];

const finish = (text) => (text.endsWith("\n") ? text : text + "\n");

export function render(format) {
  if (format === "skill") return finish(renderSkill());
  if (format === "agent-block") return finish(renderAgentBlock());
  if (format === "mo-doc") return finish(renderMoDoc());
  if (format === "prompt") return finish(renderPrompt());
  if (format === "pointer") return finish(renderPointer());
  throw new Error("未知格式：" + format + "（可用：" + FORMATS.join(" / ") + "）");
}
