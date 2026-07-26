import { describe, expect, it } from "vitest";
import { isDatabaseBusyError } from "./error.js";

describe("isDatabaseBusyError", () => {
  it("recognizes pool checkout and statement timeout failures", () => {
    expect(
      isDatabaseBusyError(
        new Error("(ECHECKOUTTIMEOUT) unable to check out connection from the pool after 15000ms"),
      ),
    ).toBe(true);
    expect(isDatabaseBusyError({ cause: { code: "57014", message: "statement timeout" } })).toBe(
      true,
    );
    expect(isDatabaseBusyError({ code: "P2024" })).toBe(true);
    expect(isDatabaseBusyError(new Error("Query read timeout"))).toBe(true);
  });

  it("does not hide unrelated application failures", () => {
    expect(isDatabaseBusyError(new Error("unexpected serialization bug"))).toBe(false);
  });
});
