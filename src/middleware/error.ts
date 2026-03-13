import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

interface AppError extends Error {
  statusCode?: number;
  code?: string;
}

export function errorHandler(err: AppError, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        details: err.flatten().fieldErrors,
      },
    });
    return;
  }

  // Prisma known errors
  if (err.constructor?.name === "PrismaClientKnownRequestError") {
    const prismaErr = err as AppError & { code: string; meta?: Record<string, unknown> };

    if (prismaErr.code === "P2002") {
      res.status(409).json({
        error: {
          code: "CONFLICT",
          message: "A record with that value already exists",
          details: prismaErr.meta,
        },
      });
      return;
    }

    if (prismaErr.code === "P2025") {
      res.status(404).json({
        error: { code: "NOT_FOUND", message: "Record not found" },
      });
      return;
    }
  }

  const statusCode = err.statusCode || 500;
  const isProduction = process.env.NODE_ENV === "production";

  console.error("[Error]", err);

  res.status(statusCode).json({
    error: {
      code: err.code || "INTERNAL_ERROR",
      message: isProduction && statusCode === 500 ? "Internal server error" : err.message,
    },
  });
}
