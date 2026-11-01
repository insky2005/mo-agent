// MO_AGENT_PI_CONTROL loader
// 只做一件事：加载实现文件。实现文件坏了也不能让 pi 起不来。
export default async function (pi) {
  if (process.env.MO_PI_DISABLE === "1") return;
  try {
    const mod = await import("./mo-agent-control-impl.js");
    if (!mod || typeof mod.default !== "function") return;
    await mod.default(pi);
  } catch (error) {
    console.error("[mo-agent] Pi 控制扩展未启用: " + ((error && error.message) || error));
  }
}
