import { describe, it, expect } from "vitest";
import { assertSafeFetchUrl, isBlockedHostname } from "../urlSafety";

describe("isBlockedHostname", () => {
  it("拦截 localhost 与 .local", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("Foo.localhost")).toBe(true);
    expect(isBlockedHostname("printer.local")).toBe(true);
  });

  it("拦截常见私网与 metadata", () => {
    expect(isBlockedHostname("127.0.0.1")).toBe(true);
    expect(isBlockedHostname("10.0.0.1")).toBe(true);
    expect(isBlockedHostname("192.168.1.1")).toBe(true);
    expect(isBlockedHostname("172.16.5.1")).toBe(true);
    expect(isBlockedHostname("169.254.169.254")).toBe(true);
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
  });

  it("放行公网主机名与公网 IP", () => {
    expect(isBlockedHostname("example.com")).toBe(false);
    expect(isBlockedHostname("8.8.8.8")).toBe(false);
    expect(isBlockedHostname("1.1.1.1")).toBe(false);
  });
});

describe("assertSafeFetchUrl", () => {
  it("规范化合法 https URL", () => {
    expect(assertSafeFetchUrl("https://example.com/a")).toBe("https://example.com/a");
  });

  it("拒绝空 / 非法协议 / 私网", () => {
    expect(() => assertSafeFetchUrl("")).toThrow(/不能为空/);
    expect(() => assertSafeFetchUrl("ftp://example.com")).toThrow(/http\/https/);
    expect(() => assertSafeFetchUrl("http://127.0.0.1/")).toThrow(/安全/);
    expect(() => assertSafeFetchUrl("https://192.168.0.1/x")).toThrow(/安全/);
  });
});
