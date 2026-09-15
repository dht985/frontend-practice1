// vitest 配置：jsdom 环境以提供 DOMParser（extractReadable 依赖）
// 只跑 src 下 __tests__ 目录里的 *.test.js，避免误跑 node_modules
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/__tests__/**/*.test.js"],
    globals: true,
  },
});
