import { describe, it, expect } from "vitest";
import { normalizeLoginBody, loginBodySchema } from "./loginBody.js";

describe("normalizeLoginBody", () => {
  it("passes through top-level email unchanged", () => {
    const o = { email: "a@b.com", password: "x" };
    expect(normalizeLoginBody(o)).toBe(o);
  });

  it("unwraps nested user", () => {
    expect(
      normalizeLoginBody({ user: { email: "a@b.com", password: "secret" } })
    ).toEqual({ email: "a@b.com", password: "secret" });
  });

  it("unwraps nested credentials", () => {
    expect(
      normalizeLoginBody({ credentials: { email: "a@b.com", password: "secret" } })
    ).toEqual({ email: "a@b.com", password: "secret" });
  });

  it("maps username to email when it looks like an email", () => {
    expect(
      normalizeLoginBody({ username: "a@b.com", password: "secret" })
    ).toEqual({ username: "a@b.com", password: "secret", email: "a@b.com" });
  });
});

describe("loginBodySchema", () => {
  it("accepts flat email and password", () => {
    const r = loginBodySchema.safeParse({ email: "a@b.com", password: "p" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.email).toBe("a@b.com");
      expect(r.data.password).toBe("p");
    }
  });

  it("rejects empty body (missing email)", () => {
    const r = loginBodySchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it("accepts nested user shape after preprocess", () => {
    const r = loginBodySchema.safeParse({ user: { email: "a@b.com", password: "p" } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("a@b.com");
  });

  it("rejects wrong password type", () => {
    const r = loginBodySchema.safeParse({ email: "a@b.com", password: 123 });
    expect(r.success).toBe(false);
  });
});
