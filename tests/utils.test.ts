import { describe, it, expect } from "vitest";
import { parseDuration } from "../src/utils.js";

describe("parseDuration", () => {
  it("should parse days", () => {
    expect(parseDuration("7d")).toBe(7 * 86400000);
  });

  it("should parse weeks", () => {
    expect(parseDuration("2w")).toBe(14 * 86400000);
  });

  it("should parse months (30 days)", () => {
    expect(parseDuration("1m")).toBe(30 * 86400000);
  });

  it("should throw for invalid format", () => {
    expect(() => parseDuration("abc")).toThrow('Invalid duration "abc"');
  });

  it("should throw for missing unit", () => {
    expect(() => parseDuration("7")).toThrow('Invalid duration "7"');
  });

  it("should throw for unknown unit", () => {
    expect(() => parseDuration("7x")).toThrow('Invalid duration "7x"');
  });

  it("should throw for empty string", () => {
    expect(() => parseDuration("")).toThrow('Invalid duration ""');
  });

  it("should throw for zero duration", () => {
    expect(() => parseDuration("0d")).toThrow("Duration must be greater than zero");
    expect(() => parseDuration("0w")).toThrow("Duration must be greater than zero");
    expect(() => parseDuration("0m")).toThrow("Duration must be greater than zero");
  });
});
