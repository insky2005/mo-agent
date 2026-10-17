/**
 * 语音文本规则：纯函数，无 IO。
 *
 * 目标：把"听到的一句话"变成可判定的意图，并且只接受明确、唯一的确认。
 * 设计依据：docs/adr/adr-0002-hands-free-voice.md
 */

const CN_DIGITS = {
  "零": "0", "〇": "0", "○": "0",
  "一": "1", "壹": "1", "幺": "1",
  "二": "2", "两": "2", "贰": "2",
  "三": "3", "叁": "3",
  "四": "4", "肆": "4",
  "五": "5", "伍": "5",
  "六": "6", "陆": "6",
  "七": "7", "柒": "7",
  "八": "8", "捌": "8",
  "九": "9", "玖": "9",
};

/** 抽出文本里的数字序列。中文数字和阿拉伯数字都认，其它字符忽略。 */
export function digitSequence(text) {
  let out = "";
  for (const ch of String(text == null ? "" : text)) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (Object.prototype.hasOwnProperty.call(CN_DIGITS, ch)) out += CN_DIGITS[ch];
  }
  return out;
}

export const INTENT = Object.freeze({
  CONFIRM: "confirm",
  REJECT: "reject",
  CANCEL: "cancel",
  RETRY: "retry",
  REPEAT: "repeat",
  UNKNOWN: "unknown",
  EMPTY: "empty",
});

const REJECT_RE = /(拒绝|不同意|不允许|不批准|驳回)/;
const CANCEL_RE = /(取消|算了|不用了|不要了|不发了|不发送|别发|停止|撤销|不干了)/;
const RETRY_RE = /(重说|重說|众说|重来|重新说|不对|错了|重新来)/;
const REPEAT_RE = /(重复|再念一遍|再读一遍|再说一遍|没听清|念一遍)/;
const CONFIRM_RE = /(确认发送|确认发布|确认|发送|确定|同意|批准|允许|可以发)/;

// whisper 对中文经常输出繁体，不归一化会把「拒絕」判成听不懂。
const TRADITIONAL = {
  "確": "确", "認": "认", "發": "发", "絕": "绝", "複": "复", "說": "说",
  "這": "这", "個": "个", "麼": "么", "為": "为", "與": "与", "對": "对",
  "開": "开", "關": "关", "應": "应", "該": "该", "還": "还", "讓": "让",
  "給": "给", "沒": "没", "無": "无", "聽": "听", "讀": "读", "準": "准",
  "許": "许", "唸": "念", "嗎": "吗", "傳": "传", "送": "送", "眾": "众",
};

export function toSimplified(text) {
  let out = "";
  for (const ch of String(text == null ? "" : text)) {
    out += Object.prototype.hasOwnProperty.call(TRADITIONAL, ch) ? TRADITIONAL[ch] : ch;
  }
  return out;
}

/** 去掉空白与标点，只留下判断用的字。 */
export function normalizeReply(text) {
  return toSimplified(String(text == null ? "" : text))
    .toLowerCase()
    .replace(/[\s\u3000，。！？、,.!?;；:："'“”‘’（）()\[\]【】]/g, "");
}

/**
 * 解析用户的回话。
 * 顺序很重要：拒绝/取消优先于"确认"，避免"确认取消"被当成放行。
 */
export function parseReply(text) {
  const normalized = normalizeReply(text);
  if (!normalized) return { intent: INTENT.EMPTY, normalized };
  if (REJECT_RE.test(normalized)) return { intent: INTENT.REJECT, normalized };
  if (CANCEL_RE.test(normalized)) return { intent: INTENT.CANCEL, normalized };
  if (RETRY_RE.test(normalized)) return { intent: INTENT.RETRY, normalized };
  if (REPEAT_RE.test(normalized)) return { intent: INTENT.REPEAT, normalized };
  if (CONFIRM_RE.test(normalized)) return { intent: INTENT.CONFIRM, normalized };
  return { intent: INTENT.UNKNOWN, normalized };
}

/** 口令必须逐位一致，多一位少一位都不行。 */
export function matchesNonce(text, nonce) {
  const want = String(nonce == null ? "" : nonce).replace(/\D/g, "");
  if (!want) return false;
  return digitSequence(text) === want;
}

export function makeNonce(length, random) {
  const n = Math.max(1, Math.min(8, length || 4));
  const rnd = random || Math.random;
  let out = "";
  for (let i = 0; i < n; i++) out += String(Math.floor(rnd() * 10) % 10);
  return out;
}

const DANGER_RULES = [
  { re: /\brm\s+-[a-z]*[rf]/i, reason: "递归删除" },
  { re: /\bsudo\b/i, reason: "提权执行" },
  { re: /\bgit\s+push\b[^\n]*(--force|\s-f\b)/i, reason: "强推远端" },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: "丢弃本地改动" },
  { re: /\bchmod\s+777\b/i, reason: "权限过宽" },
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh)\b/i, reason: "远程脚本直接执行" },
  { re: /\bdd\s+if=/i, reason: "裸设备写入" },
  { re: /\bmkfs\b|\bdiskutil\s+erase/i, reason: "格式化磁盘" },
  { re: />\s*\/(etc|usr|bin|sbin|System)\//i, reason: "覆写系统文件" },
  { re: /(\.ssh|\.aws|\.gnupg|keychain)/i, reason: "触及凭据目录" },
  { re: /(^|[\s"'])\/(etc|usr|bin|sbin|System)\//i, reason: "操作系统目录" },
  { re: /\bdrop\s+(database|table)\b/i, reason: "删除数据库对象" },
];

/** 粗粒度危险识别。宁可多报，不可少报。 */
export function detectDanger(text) {
  const source = String(text == null ? "" : text);
  const reasons = [];
  for (const rule of DANGER_RULES) {
    if (rule.re.test(source) && reasons.indexOf(rule.reason) === -1) reasons.push(rule.reason);
  }
  return { level: reasons.length ? "high" : "normal", reasons };
}

/**
 * 路径逐字念：src/app.js -> s r c / a p p . j s
 * 中文 TTS 念英文文件名容易糊，逐字比重读整段可靠。
 */
const PATH_RE = /(?:~|\.{1,2})?\/?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|[A-Za-z0-9._-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|py|go|rs|sh|bash|zsh|yaml|yml|toml|lock|txt|html|css|swift|java|kt|rb|php|sql|ini|conf|env)/g;

export function spellPaths(text) {
  return String(text == null ? "" : text).replace(PATH_RE, function (match) {
    return match.split("").join(" ");
  });
}

export function clipText(text, max) {
  const chars = Array.from(String(text == null ? "" : text));
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, max).join("") + "……";
}

/** 口述草稿的回读：短句全文，长句念开头 + 总字数。 */
export function buildDictationDraft(input) {
  const text = String((input && input.text) || "").trim();
  const length = Array.from(text).length;
  const spoken = spellPaths(text);
  const body = length <= 40
    ? "我听到：" + spoken + "。"
    : "我听到：" + spellPaths(clipText(text, 40)) + "共" + length + "个字。";
  return { kind: "dictation", text, prompt: body + "确认发送吗？" };
}

/** 授权草稿的回读：动作 + 目标 + 口令。危险操作额外念出理由。 */
export function buildApprovalDraft(input) {
  const p = input || {};
  const agentLabel = p.agentLabel || p.agent || "Agent";
  const toolName = p.toolName || "操作";
  const title = p.title || "";
  const target = String(p.target || p.command || "");
  const nonce = String(p.nonce || "");
  const danger = detectDanger([title, toolName, target].join(" "));
  const prefix = danger.level === "high"
    ? "危险操作。理由：" + danger.reasons.join("、") + "。"
    : "";
  const targetText = target ? "，目标 " + spellPaths(target) : "";
  const prompt = prefix + agentLabel + " 请求" + toolName + targetText + "。" +
    "听到提示音后，请复述口令：" + nonce.split("").join(" ") + "。";
  return { kind: "approval", agentLabel, toolName, title, target, nonce, danger, prompt };
}
