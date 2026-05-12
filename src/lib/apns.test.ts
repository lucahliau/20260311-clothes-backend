import { describe, it, expect } from "vitest";
import { classifyApnsResponse } from "./apns.js";

describe("classifyApnsResponse", () => {
  it("treats 200 as delivered regardless of reason", () => {
    expect(classifyApnsResponse(200, null)).toBe("ok");
    expect(classifyApnsResponse(200, "ignored")).toBe("ok");
  });

  it("treats 410 as permanently dead", () => {
    expect(classifyApnsResponse(410, "Unregistered")).toBe("delete");
    expect(classifyApnsResponse(410, null)).toBe("delete");
  });

  it("treats token-level 400s as permanently dead", () => {
    expect(classifyApnsResponse(400, "BadDeviceToken")).toBe("delete");
    expect(classifyApnsResponse(400, "DeviceTokenNotForTopic")).toBe("delete");
  });

  it("suppresses non-token 400s so config bugs aren't masked", () => {
    // These mean our payload/topic/env is wrong, not the user's token.
    expect(classifyApnsResponse(400, "PayloadTooLarge")).toBe("suppress");
    expect(classifyApnsResponse(400, "BadCertificateEnvironment")).toBe("suppress");
    expect(classifyApnsResponse(400, null)).toBe("suppress");
  });

  it("retries on transient APNS errors", () => {
    expect(classifyApnsResponse(403, "ExpiredProviderToken")).toBe("retry");
    expect(classifyApnsResponse(429, "TooManyRequests")).toBe("retry");
    expect(classifyApnsResponse(500, null)).toBe("retry");
    expect(classifyApnsResponse(503, "ServiceUnavailable")).toBe("retry");
  });

  it("suppresses anything else (defensive default)", () => {
    expect(classifyApnsResponse(404, "DeviceTokenNotForTopic")).toBe("suppress");
    expect(classifyApnsResponse(0, null)).toBe("suppress");
  });
});
