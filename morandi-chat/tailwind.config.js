/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        // 主色板（指定色值，严格遵守）
        cream: "#F7F3EE",   // 页面背景 奶白
        sand: "#E8D5DD",    // 侧边栏 低饱和灰粉
        blush: "#E3C3CC",   // 用户消息 浅粉
        lilac: "#CFC1DC",   // AI 消息 浅紫
        plum: "#C9BED0",    // 辅助 灰紫
        sage: "#C5CDBF",    // 辅助 灰绿（少量）
        ink: "#5A524C",     // 主文字
        muted: "#8C847C",   // 次要文字
        line: "#DBD1D2",    // 边框/分割线（微粉调中性灰）
        peach: "#E1B99F",   // 主按钮 蜜桃浅橙
        peachdeep: "#D0A183",
        // 层次色（同色系更浅一档，用于小面积容器）
        blushsoft: "#F0DEE4",
        lilacsoft: "#E6DEF0",
        peachsoft: "#F5E5D8",
        creamdeep: "#F1EBE4",
        sagedeep: "#A8B29C",
      },
      boxShadow: {
        soft: "0 2px 12px rgba(90, 82, 76, 0.05)",
        float: "0 6px 28px rgba(90, 82, 76, 0.08)",
        glow: "0 0 0 3px rgba(225, 185, 159, 0.35)",
      },
      borderRadius: {
        xl2: "1.1rem",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        // 背景色块缓慢漂移（幅度极小，保持安静）
        drift: {
          "0%, 100%": { transform: "translate(0, 0)" },
          "50%": { transform: "translate(-14px, 10px)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.35s ease-out both",
        blink: "blink 1s step-end infinite",
        drift: "drift 18s ease-in-out infinite",
        "drift-slow": "drift 24s ease-in-out infinite reverse",
      },
    },
  },
  plugins: [],
};
