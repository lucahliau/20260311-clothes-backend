import type { NextFunction, Request, Response } from "express";

/**
 * Process-local admission control for catalog reads that fan into expensive
 * SQL/vector work. Rejecting overload quickly preserves connections for auth,
 * social writes, and health probes instead of letting every request wait for
 * the pooler's checkout timeout.
 */
export class AdmissionController {
  private active = 0;

  constructor(private readonly maxConcurrent: number) {}

  middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (this.active >= this.maxConcurrent) {
      res.setHeader("Retry-After", "2");
      req.log.warn(
        { active: this.active, maxConcurrent: this.maxConcurrent },
        "Expensive-read admission limit reached",
      );
      res.status(503).json({
        error: {
          code: "SERVER_BUSY",
          message: "The catalog is busy. Try again shortly.",
        },
      });
      return;
    }

    this.active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
}

const configuredMax = Number(process.env.DB_HEAVY_REQUEST_CONCURRENCY);
const maxConcurrent =
  Number.isFinite(configuredMax) && configuredMax > 0 ? Math.floor(configuredMax) : 4;

/** Shared across `/items`, feed/ANN, and brand aggregation routes. */
export const expensiveReadAdmission = new AdmissionController(maxConcurrent).middleware;
