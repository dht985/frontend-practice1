// urlGuard.test.js：出网目标安全校验（SSRF 防护）测试
import { describe, it, expect } from "vitest";
import { assertSafeTarget, blockedReason, isBlockedIp } from "../../../urlGuard.js";

describe("blockedReason - 必须拦截的地址", () => {
  const blocked = [
    ["127.0.0.1", "本机环回"],
    ["127.9.9.9", "环回段内任意地址"],
    ["0.0.0.0", "本网络"],
    ["10.1.2.3", "私网 10/8"],
    ["172.16.0.1", "私网 172.16/12 起点"],
    ["172.31.255.255", "私网 172.16/12 终点"],
    ["192.168.1.1", "私网 192.168/16"],
    ["169.254.169.254", "云元数据 IMDS"],
    ["169.254.170.2", "ECS 任务元数据"],
    ["100.100.100.200", "阿里云元数据"],
    ["192.0.0.192", "Oracle 元数据"],
    ["100.64.0.1", "运营商级 NAT"],
    ["198.18.0.1", "基准测试保留段"],
    ["224.0.0.1", "组播"],
    ["255.255.255.255", "保留段"],
    ["::1", "IPv6 环回"],
    ["::", "IPv6 未指定"],
    ["fe80::1", "IPv6 链路本地"],
    ["fc00::1", "IPv6 唯一本地"],
    ["fd00:ec2::254", "AWS IMDS IPv6"],
    ["::ffff:127.0.0.1", "IPv4 映射的环回地址"],
    ["2001:db8::1", "IPv6 文档地址"],
  ];

  for (const [ip, label] of blocked) {
    it(`拦截 ${ip}（${label}）`, () => {
      expect(isBlockedIp(ip)).toBe(true);
      expect(blockedReason(ip)).toBeTruthy();
    });
  }
});

describe("blockedReason - 必须放行的公网地址", () => {
  const allowed = [
    ["8.8.8.8", "Google DNS"],
    ["1.1.1.1", "Cloudflare DNS"],
    ["93.184.216.34", "example.com"],
    ["172.32.0.1", "紧邻 172.16/12 之外"],
    ["100.128.0.1", "紧邻 100.64/10 之外"],
    ["2606:4700:4700::1111", "Cloudflare IPv6"],
  ];

  for (const [ip, label] of allowed) {
    it(`放行 ${ip}（${label}）`, () => {
      expect(isBlockedIp(ip)).toBe(false);
      expect(blockedReason(ip)).toBeNull();
    });
  }

  it("无法识别的地址按不安全处理（fail closed）", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });
});

describe("assertSafeTarget - 目标校验", () => {
  const publicResolver = async () => ["93.184.216.34"];
  const loopbackResolver = async () => ["127.0.0.1"];
  const mixedResolver = async () => ["93.184.216.34", "10.0.0.7"];

  it("公网域名通过校验并返回解析结果", async () => {
    const result = await assertSafeTarget("https://example.com/a?b=1", {
      resolve: publicResolver,
    });
    expect(result.hostname).toBe("example.com");
    expect(result.addresses).toEqual(["93.184.216.34"]);
  });

  it("解析到环回地址的域名被拦截（如 localhost）", async () => {
    await expect(
      assertSafeTarget("http://localhost:80/", { resolve: loopbackResolver })
    ).rejects.toMatchObject({ code: "unsafe_target" });
  });

  it("多个解析结果里只要有一个内网地址就拦截", async () => {
    await expect(
      assertSafeTarget("http://split.example.com/", { resolve: mixedResolver })
    ).rejects.toMatchObject({ code: "unsafe_target" });
  });

  it("IP 字面量直接校验，不调用解析器", async () => {
    let called = false;
    const resolve = async () => {
      called = true;
      return ["8.8.8.8"];
    };
    await expect(assertSafeTarget("http://10.0.0.5/", { resolve })).rejects.toMatchObject({
      code: "unsafe_target",
    });
    expect(called).toBe(false);
  });

  it("IPv6 字面量同样受校验", async () => {
    await expect(assertSafeTarget("http://[::1]/")).rejects.toMatchObject({
      code: "unsafe_target",
    });
  });

  it("非 http/https 协议被拒绝", async () => {
    await expect(assertSafeTarget("ftp://example.com/")).rejects.toMatchObject({
      code: "unsafe_target",
    });
    await expect(assertSafeTarget("file:///etc/passwd")).rejects.toMatchObject({
      code: "unsafe_target",
    });
  });

  it("非 80/443 端口被拒绝", async () => {
    await expect(
      assertSafeTarget("http://example.com:8080/", { resolve: publicResolver })
    ).rejects.toMatchObject({ code: "unsafe_target" });
    await expect(
      assertSafeTarget("http://example.com:8080/", { resolve: publicResolver })
    ).rejects.toThrow(/端口/);
  });

  it("显式写出的默认端口可以通过", async () => {
    await expect(
      assertSafeTarget("https://example.com:443/", { resolve: publicResolver })
    ).resolves.toBeTruthy();
    await expect(
      assertSafeTarget("http://example.com:80/", { resolve: publicResolver })
    ).resolves.toBeTruthy();
  });

  it("域名解析不到地址时报错", async () => {
    await expect(
      assertSafeTarget("http://nxdomain.example/", { resolve: async () => [] })
    ).rejects.toThrow(/未解析到任何地址/);
  });

  it("非法 URL 报错", async () => {
    await expect(assertSafeTarget("not a url")).rejects.toMatchObject({
      code: "unsafe_target",
    });
  });
});
