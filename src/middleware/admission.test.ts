import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { AdmissionController } from "./admission.js";

function response() {
  const events = new EventEmitter();
  const state = { status: 200, body: undefined as unknown };
  const res = {
    once: events.once.bind(events),
    setHeader: vi.fn(),
    status: vi.fn((status: number) => {
      state.status = status;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      state.body = body;
      return res;
    }),
  } as unknown as Response;
  return { events, res, state };
}

const req = {
  log: { warn: vi.fn() },
} as unknown as Request;

describe("AdmissionController", () => {
  it("fails fast at capacity and admits again after completion", () => {
    const controller = new AdmissionController(1);
    const first = response();
    const next = vi.fn() as NextFunction;
    controller.middleware(req, first.res, next);
    expect(next).toHaveBeenCalledOnce();

    const rejected = response();
    controller.middleware(req, rejected.res, vi.fn());
    expect(rejected.state.status).toBe(503);
    expect(rejected.state.body).toMatchObject({ error: { code: "SERVER_BUSY" } });
    expect(rejected.res.setHeader).toHaveBeenCalledWith("Retry-After", "2");

    first.events.emit("finish");
    const admitted = response();
    const admittedNext = vi.fn() as NextFunction;
    controller.middleware(req, admitted.res, admittedNext);
    expect(admittedNext).toHaveBeenCalledOnce();
  });
});
