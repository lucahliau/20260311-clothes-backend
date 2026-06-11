import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { prisma } from "../../src/lib/prisma.js";
import { app, auth, createVerifiedUser, resetDb } from "./helpers.js";

describe("auth lifecycle", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("registers with immediate tokens (verify-later) and lets the unverified user log in", async () => {
    const body = { email: "fresh@test.dev", username: "fresh_user", password: "password123" };

    const reg = await request(app()).post("/auth/register").send(body);
    expect(reg.status).toBe(201);
    expect(reg.body.requiresEmailVerification).toBe(true);
    expect(reg.body.accessToken).toBeTruthy();
    expect(reg.body.refreshToken).toBeTruthy();
    expect(reg.body.user.emailVerified).toBe(false);

    // The registered session works immediately…
    const me = await request(app()).get("/users/me").set(auth(reg.body.accessToken));
    expect(me.status).toBe(200);

    // …and so does a fresh login before the email is verified.
    const login = await request(app())
      .post("/auth/login")
      .send({ email: body.email, password: body.password });
    expect(login.status).toBe(200);
    expect(login.body.user.emailVerified).toBe(false);
  });

  it("rejects duplicate email with 409 and invalid payload with 400", async () => {
    const dupe = await request(app())
      .post("/auth/register")
      .send({ email: "fresh@test.dev", username: "other_name", password: "password123" });
    expect(dupe.status).toBe(409);
    // Anti-enumeration: the message must not reveal WHICH field collided.
    expect(dupe.body.error.message).toMatch(/email or username/i);

    const invalid = await request(app())
      .post("/auth/register")
      .send({ email: "not-an-email", username: "x", password: "short" });
    expect(invalid.status).toBe(400);
  });

  it("logs in, calls a protected route, rotates refresh tokens, and logs out", async () => {
    const user = await createVerifiedUser();

    const me = await request(app()).get("/users/me").set(auth(user.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.user?.id ?? me.body.id).toBe(user.id);

    const refreshed = await request(app())
      .post("/auth/refresh")
      .send({ refreshToken: user.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeTruthy();
    expect(refreshed.body.refreshToken).toBeTruthy();
    expect(refreshed.body.refreshToken).not.toBe(user.refreshToken);

    const meAgain = await request(app()).get("/users/me").set(auth(refreshed.body.accessToken));
    expect(meAgain.status).toBe(200);

    const logout = await request(app())
      .post("/auth/logout")
      .set(auth(refreshed.body.accessToken))
      .send({ refreshToken: refreshed.body.refreshToken });
    expect(logout.status).toBe(200);

    const afterLogout = await request(app())
      .post("/auth/refresh")
      .send({ refreshToken: refreshed.body.refreshToken });
    expect(afterLogout.status).toBe(401);
  });

  it("rejects a garbage bearer token and a missing header", async () => {
    expect((await request(app()).get("/users/me")).status).toBe(401);
    expect((await request(app()).get("/users/me").set(auth("garbage"))).status).toBe(401);
  });

  it("locks the account after repeated failed logins (even with the right password)", async () => {
    const user = await createVerifiedUser();

    let locked = false;
    for (let i = 0; i < 10; i++) {
      const res = await request(app())
        .post("/auth/login")
        .send({ email: user.email, password: "wrong-password" });
      expect([401, 423]).toContain(res.status);
      if (res.status === 423) {
        locked = true;
        break;
      }
    }

    // The 10th failure flips the lock; the next attempt must see 423.
    const correct = await request(app())
      .post("/auth/login")
      .send({ email: user.email, password: user.password });
    expect(correct.status).toBe(423);
    expect(correct.body.error.code).toBe("ACCOUNT_LOCKED");
    expect(locked || correct.status === 423).toBe(true);

    // Unlock directly so later suites aren't affected by the 15-minute window.
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
  });

  it("serves the same auth API under /v1", async () => {
    const user = await createVerifiedUser();
    const login = await request(app())
      .post("/v1/auth/login")
      .send({ email: user.email, password: user.password });
    expect(login.status).toBe(200);
    expect(login.body.accessToken).toBeTruthy();
  });

  it("normalizes email case on register and login", async () => {
    const email = `Mixed.Case${Date.now()}@Test.DEV`;
    const reg = await request(app())
      .post("/auth/register")
      .send({ email, username: `mixed_${Date.now() % 100000}`, password: "password123" });
    expect(reg.status).toBe(201);
    expect(reg.body.user.email).toBe(email.toLowerCase());

    const login = await request(app())
      .post("/auth/login")
      .send({ email: email.toUpperCase(), password: "password123" });
    expect(login.status).toBe(200);
  });

  it("logs in with a plain username as the identifier", async () => {
    const user = await createVerifiedUser();
    const res = await request(app())
      .post("/auth/login")
      .send({ username: user.username, password: user.password });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it("change-password revokes other sessions and re-issues for the caller", async () => {
    const user = await createVerifiedUser();

    // A second device with its own session.
    const deviceB = await request(app())
      .post("/auth/login")
      .send({ email: user.email, password: user.password, deviceId: "device-B-abcdef" });
    expect(deviceB.status).toBe(200);

    const change = await request(app())
      .post("/auth/change-password")
      .set(auth(user.accessToken))
      .send({
        currentPassword: user.password,
        newPassword: "newpassword456",
        deviceId: "device-A-abcdef",
      });
    expect(change.status).toBe(200);
    expect(change.body.accessToken).toBeTruthy();
    expect(change.body.refreshToken).toBeTruthy();

    // Device B's refresh token is dead; the re-issued one works.
    const refreshB = await request(app())
      .post("/auth/refresh")
      .send({ refreshToken: deviceB.body.refreshToken });
    expect(refreshB.status).toBe(401);

    const refreshA = await request(app())
      .post("/auth/refresh")
      .send({ refreshToken: change.body.refreshToken });
    expect(refreshA.status).toBe(200);

    // Old password rejected, new one accepted.
    expect(
      (
        await request(app())
          .post("/auth/login")
          .send({ email: user.email, password: user.password })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app())
          .post("/auth/login")
          .send({ email: user.email, password: "newpassword456" })
      ).status,
    ).toBe(200);
  });
});
