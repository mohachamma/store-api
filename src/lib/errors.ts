import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "@hono/zod-openapi";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Single error shape returned by every endpoint. */
export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "not_found" }),
      message: z.string().openapi({ example: "Resource not found" }),
      details: z.unknown().optional(),
    }),
  })
  .openapi("Error");

export type ApiErrorBody = z.infer<typeof ErrorSchema>;

export class ApiError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}

const codeForStatus = (status: number): string =>
  ({
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    422: "validation_error",
    429: "rate_limited",
  })[status] ?? (status >= 500 ? "internal_error" : "error");

/** Global error handler. Never echoes internal details (or personal data) in 5xx responses. */
export function handleError(err: Error, c: Context) {
  if (err instanceof ApiError) {
    return c.json(errorBody(err.code, err.message, err.details), err.status);
  }
  if (err instanceof HTTPException) {
    return c.json(errorBody(codeForStatus(err.status), err.message || "Request failed"), err.status);
  }
  // Database constraint violations are the client's problem (bad data), not a server crash; never echo database details.
  const pg = (err as { code?: string }).code;
  if (pg === "23514" || pg === "22P02" || pg === "22023") return c.json(errorBody("validation_error", "Invalid data"), 422);
  if (pg === "P0002") return c.json(errorBody("conflict", "The item is not in the right state for this action"), 409);
  if (pg === "23505") return c.json(errorBody("conflict", "This value already exists"), 409);
  if (pg === "23503") return c.json(errorBody("conflict", "This item is linked to other data"), 409);
  console.error("Unhandled error:", err.name, err.message);
  return c.json(errorBody("internal_error", "Internal server error"), 500);
}
