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

  // 2. Log the error with context (Skip logging for 404s/401s if desired, but here we log everything for clarity as requested)
  // For 500s, log the stack trace. For others, just the message.
  const isInternal = statusCode === 500;
  
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path} >> ${statusCode} ${code}`);
  if (isInternal) {
    console.error(err);
  } else {
    // Optional: Log non-500 errors as warnings if you want to see them in console
    console.warn(`  Message: ${message}`);
    if (details) console.warn(`  Details:`, JSON.stringify(details));
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
