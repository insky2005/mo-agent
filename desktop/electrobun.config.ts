import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "mo-agent",
    identifier: "dev.moagent.desktop",
    version: "0.1.0",
  },
  runtime: {
    // 托盘常驻：关掉窗口不等于退出
    exitOnLastWindowClosed: false,
  },
  build: {
    // 用厂商默认的 cottontail 布局（自带 metadata.json + 更新包），
    // Bun 布局在第二次启动时会读不到 metadata.json。
    mainProcess: "cottontail",
    cottontail: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/tray.png": "views/mainview/tray.png",
    },
    // codesign: true 需要 Apple 开发者证书（ELECTROBUN_DEVELOPER_ID），
    // 本地改为构建后用 scripts/build-desktop.sh 里的 ad-hoc 重签。
    mac: { bundleCEF: false, createDmg: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
