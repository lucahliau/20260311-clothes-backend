import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { captureException } from "../lib/sentry.js";

const router = Router();

// MetricKit crash payloads are typically tens of KB; cap well below the 1mb
// body limit so a single report can't balloon log volume.
const crashReportSchema = z.object({
  payloadJson: z.string().min(2).max(300_000),
  kind: z.enum(["crash", "hang", "diagnostic"]).default("crash"),
  appVersion: z.string().max(50).optional(),
  osVersion: z.string().max(100).optional(),
});

// ---------------------------------------------------------------------------
// POST /diagnostics/crash
// ---------------------------------------------------------------------------
// The iOS app uploads MetricKit diagnostic payloads (delivered on the launch
// after a crash/hang). The full payload lands in the structured logs; Sentry
// gets a marker event so crashes show up in alerting.

router.post("/crash", requireAuth, async (req: Request, res: Response) => {
  const report = crashReportSchema.parse(req.body);
  const userId = req.user!.userId;

  let payload: unknown;
  try {
    payload = JSON.parse(report.payloadJson);
  } catch {
    payload = { raw: report.payloadJson.slice(0, 2_000) };
  }

  req.log.error(
    {
      userId,
      kind: report.kind,
      appVersion: report.appVersion,
      osVersion: report.osVersion,
      diagnostics: payload,
    },
    "[diagnostics] iOS crash report received",
  );

  const marker = new Error(
    `iOS ${report.kind} report (app ${report.appVersion ?? "?"}, os ${report.osVersion ?? "?"})`,
  );
  marker.name = "IOSCrashReport";
  captureException(marker);

  res.status(202).json({ received: true });
});

export default router;
