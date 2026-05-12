import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  // 1. Determine Status Code, Error Code, Message, and Details
  let statusCode = 500;
  let code = "INTERNAL_ERROR";
  let message = "Internal server error";
  let details: unknown = undefined;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    statusCode = 400;
    code = "VALIDATION_ERROR";
    message = "Validation failed";
    details = err.flatten().fieldErrors;
  } else if (err instanceof Error) {
    // Prisma known errors
    if (err.constructor.name === "PrismaClientKnownRequestError") {
      const prismaErr = err as any;
      if (prismaErr.code === "P2002") {
        statusCode = 409;
        code = "CONFLICT";
        message = "A record with that value already exists";
        details = prismaErr.meta;
      } else if (prismaErr.code === "P2025") {
        statusCode = 404;
        code = "NOT_FOUND";
        message = "Record not found";
      } else {
        // Other Prisma errors
        message = prismaErr.message;
        details = prismaErr.meta;
      }
    } else {
      // Generic Error
      message = err.message;
    }
  }

  // 2. Log via the request-scoped logger so reqId + userId are bound. 5xx
  //    gets a full stack (also auto-captured to Sentry by setupExpressErrorHandler);
  //    4xx is a warn with just the response shape, since the client triggered it.
  const isInternal = statusCode >= 500;
  const log = req.log;
  if (isInternal) {
    log.error({ err, statusCode, code }, `${req.method} ${req.path} >> ${statusCode} ${code}`);
  } else {
    log.warn({ statusCode, code, details }, `${req.method} ${req.path} >> ${statusCode} ${code}: ${message}`);
  }

  // 3. Send Response
  const isProduction = process.env.NODE_ENV === "production";
  
  // In production, hide 500 details
  if (isProduction && isInternal) {
    message = "Internal server error";
    details = undefined;
  }

  res.status(statusCode).json({
    error: {
      code,
      message,
      details,
    },
  });
}
