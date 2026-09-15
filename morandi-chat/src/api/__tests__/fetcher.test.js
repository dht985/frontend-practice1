// fetcher.js 单元测试：truncateAtBoundary（纯函数）+ extractReadable（需 jsdom 的 DOMParser）
import { describe, it, expect } from "vitest";
import { truncateAtBoundary, extractReadable } from "../fetcher";

describe("truncateAtBoundary", () => {
  it("短文本不截断原样返回", () => {
    const r = truncateAtBoundary("hello world", 100);
    expect(r.text).toBe("hello world");
    expect(r.truncated).toBe(false);
  });

  it("恰好等于上限也不截断", () => {
    const text = "a".repeat(100);
    const r = truncateAtBoundary(text, 100);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(text);
  });

  it("优先在 [75%, 100%] 区间的换行处截断", () => {
    const part1 = "a".repeat(80);
    const text = part1 + "\n" + "b".repeat(50);
    const r = truncateAtBoundary(text, 100);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe(part1);
    expect(r.text.length).toBe(80);
  });

  it("区间内有换行时不在句末标点处截断", () => {
    const part1 = "a".repeat(80);
    // 换行在 80，句号在 90；换行更靠后但仍 < max，应优先用换行
    const text = part1 + "\n" + "c".repeat(9) + "。" + "b".repeat(50);
    const r = truncateAtBoundary(text, 100);
    expect(r.text).toBe(part1);
  });

  it("无换行时优先在中文句末标点处截断", () => {
    const part1 = "a".repeat(85);
    const text = part1 + "。" + "b".repeat(50);
    const r = truncateAtBoundary(text, 100);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe(part1 + "。"); // cut = at + mk.length = 86
  });

  it("无换行时优先在英文句末标点（含空格）处截断", () => {
    const part1 = "a".repeat(85);
    const text = part1 + ". " + "b".repeat(50);
    const r = truncateAtBoundary(text, 100);
    expect(r.truncated).toBe(true);
    // 实现末尾 trimEnd 会去掉句末空格，仅保留句号；句号仍在即可
    expect(r.text).toBe(part1 + ".");
  });

  it("换行在 75% 之前不采用，退而找句末标点", () => {
    const part1 = "a".repeat(50);
    const text = part1 + "\n" + "c".repeat(34) + "。" + "b".repeat(50);
    // 换行 index=50 < minCut=75；句号 index=85+1=86（"。 "长度1，但 lastIndexOf("。")=85, +1=86）
    const r = truncateAtBoundary(text, 100);
    expect(r.text).toBe(part1 + "\n" + "c".repeat(34) + "。");
    expect(r.text.endsWith("。")).toBe(true);
  });

  it("无换行无句末标点时硬切到上限", () => {
    const text = "a".repeat(150);
    const r = truncateAtBoundary(text, 100);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(100);
    expect(r.text).toBe("a".repeat(100));
  });

  it("换行与标点均在 75% 之前，硬切到上限", () => {
    const part1 = "a".repeat(50);
    const text = part1 + "\n" + "。b".repeat(40);
    const r = truncateAtBoundary(text, 100);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(100);
  });

  it("截断结果长度永远不超过上限", () => {
    // 多种边界，校验不变量
    const cases = [
      "a".repeat(150),
      "a".repeat(80) + "\n" + "b".repeat(80),
      "a".repeat(85) + "。" + "b".repeat(80),
      "a".repeat(50) + "\n" + "b".repeat(50) + "。" + "c".repeat(50),
    ];
    for (const text of cases) {
      const r = truncateAtBoundary(text, 100);
      expect(r.text.length).toBeLessThanOrEqual(100);
    }
  });

  it("截断结果已 trimEnd，不保留尾部空白", () => {
    const part1 = "a".repeat(80);
    const text = part1 + "\n   \n" + "b".repeat(50);
    const r = truncateAtBoundary(text, 100);
    expect(r.text).toBe(part1);
    expect(r.text).toBe(r.text.trimEnd());
  });
});

describe("extractReadable", () => {
  it("空字符串返回兜底文本", () => {
    const { title, text } = extractReadable("");
    expect(title).toBe("");
    expect(text).toContain("未提取到有效正文");
  });

  it("null/undefined 同样返回兜底文本", () => {
    expect(extractReadable(null).text).toContain("未提取到有效正文");
    expect(extractReadable(undefined).text).toContain("未提取到有效正文");
  });

  it("og:title 优先于 title 标签", () => {
    const html = `<!DOCTYPE html><html><head>
      <meta property="og:title" content="OG 标题">
      <title>普通标题</title>
    </head><body><article><p>${"正文".repeat(120)}</p></article></body></html>`;
    const { title } = extractReadable(html);
    expect(title).toBe("OG 标题");
  });

  it("无 og:title 时用 title 标签", () => {
    const html = `<!DOCTYPE html><html><head><title>页面标题</title></head>
      <body><article><p>${"正文".repeat(120)}</p></article></body></html>`;
    const { title } = extractReadable(html);
    expect(title).toBe("页面标题");
  });

  it("无 og:title 与 title 时用 h1", () => {
    const html = `<!DOCTYPE html><html><head></head>
      <body><h1>一级标题</h1><article><p>${"正文".repeat(120)}</p></article></body></html>`;
    const { title } = extractReadable(html);
    expect(title).toBe("一级标题");
  });

  it("article 内容 >=200 字时用 article 文本，剔除 nav 噪声", () => {
    const content = "这是正文段落。".repeat(50);
    const html = `<!DOCTYPE html><html><head><title>Article Test</title></head><body>
      <nav>首页 关于 联系</nav>
      <article>${content}</article>
      <footer>版权声明</footer>
    </body></html>`;
    const { title, text } = extractReadable(html);
    expect(title).toBe("Article Test");
    expect(text).toContain("这是正文段落");
    expect(text).not.toContain("首页 关于");
    expect(text).not.toContain("版权声明");
  });

  it("无 article/main 时回退到 body 并剔除 nav/header/footer/aside", () => {
    const content = "正文内容段落。".repeat(50);
    const html = `<!DOCTYPE html><html><head><title>Body Test</title></head><body>
      <nav>导航链接</nav>
      <header>页头</header>
      <div>${content}</div>
      <aside>侧边栏</aside>
      <footer>页脚</footer>
    </body></html>`;
    const { text } = extractReadable(html);
    expect(text).toContain("正文内容段落");
    expect(text).not.toContain("导航链接");
    expect(text).not.toContain("页头");
    expect(text).not.toContain("侧边栏");
    expect(text).not.toContain("页脚");
  });

  it("article 不足 200 字时回退 body", () => {
    const bodyContent = "主体正文段落。".repeat(50);
    const html = `<!DOCTYPE html><html><head><title>Short Article</title></head><body>
      <article>短文章内容</article>
      <div>${bodyContent}</div>
    </body></html>`;
    const { text } = extractReadable(html);
    // article 元素提取仅"短文章内容" < 200，回退 body 提取
    expect(text).toContain("主体正文段落");
    expect(text).toContain("短文章内容"); // body 包含 article 内容
  });

  it("复杂结构不抛异常", () => {
    const html = `<!DOCTYPE html><html><head><title>Complex</title></head><body>
      <article>
        <h2>标题</h2>
        <p>段落一${"内容".repeat(100)}</p>
        <ul><li>项 A</li><li>项 B</li></ul>
        <pre>代码块</pre>
        <blockquote>引用</blockquote>
      </article>
    </body></html>`;
    expect(() => extractReadable(html)).not.toThrow();
    const { text } = extractReadable(html);
    expect(text.length).toBeGreaterThan(0);
  });

  it("script/style 内容被剔除", () => {
    const html = `<!DOCTYPE html><html><head>
      <title>Noise Test</title>
      <style>body{color:red}</style>
      <script>alert(1)</script>
    </head><body><article>
      <p>${"正文".repeat(120)}</p>
    </article></body></html>`;
    const { text } = extractReadable(html);
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("alert(1)");
  });

  it("标题被压缩空白并截断到 300 字", () => {
    const longTitle = "a".repeat(500);
    const html = `<!DOCTYPE html><html><head><title>${longTitle}</title></head>
      <body><article><p>${"正文".repeat(120)}</p></article></body></html>`;
    const { title } = extractReadable(html);
    expect(title.length).toBeLessThanOrEqual(300);
  });
});
