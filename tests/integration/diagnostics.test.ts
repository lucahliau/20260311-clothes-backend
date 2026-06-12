import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { app, auth, createVerifiedUser, resetDb, type TestUser } from "./helpers.js";

describe("diagnostics", () => {
  let user: TestUser;

  beforeAll(async () => {
    await resetDb();
    user = await createVerifiedUser();
  });

  it("requires auth", async () => {
    const res = await request(app()).post("/diagnostics/crash").send({ payloadJson: "{}" });
    expect(res.status).toBe(401);
  });

  it("accepts a crash report and rejects invalid payloads", async () => {
    const ok = await request(app())
      .post("/diagnostics/crash")
      .set(auth(user.accessToken))
      .send({
        payloadJson: JSON.stringify({ crashDiagnostics: [{ signal: 11 }] }),
        kind: "crash",
        appVersion: "1.0",
        osVersion: "iOS 26.1",
      });
    expect(ok.status).toBe(202);
    expect(ok.body.received).toBe(true);

    const bad = await request(app())
      .post("/diagnostics/crash")
      .set(auth(user.accessToken))
      .send({ payloadJson: "" });
    expect(bad.status).toBe(400);
  });
});
