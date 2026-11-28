import { randomUUID } from "node:crypto";
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { Request, Response } from "express";

/** What a player sees when something broke on our side. The details go to the server log only. */
export const FRIENDLY_ERROR = "Something went wrong on our side. Please try again in a moment.";
/** What a player sees when the database is unavailable or out of room: it passes, so trying again later helps. */
export const BUSY_ERROR = "The service is busy right now. Please try again in a moment.";

/** Prisma's codes for "can't reach / timed out / pool exhausted / connection closed". */
const PRISMA_UNAVAILABLE = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);
/**
 * Postgres classes that mean the server can't do the work right now, not that
 * the request was wrong: 53 insufficient resources (53100 disk full, 53200 out
 * of memory, 53300 too many connections), 57P0x shutting down, 08 connection.
 */
const PG_UNAVAILABLE = /\b(53[0-9]{3}|57P0[0-9]|08[0-9A-Z]{3})\b|No space left on device|could not write to file|out of memory|too many (database )?connections|terminating connection/i;

/** True for a database error that passes: a full disk, no connection, a pool timeout. */
export function isDatabaseUnavailable(exception: unknown): boolean {
  if (!(exception instanceof Error)) return false;
  if (!exception.constructor.name.startsWith("PrismaClient")) return false;
  const code = (exception as { code?: unknown }).code;
  if (typeof code === "string" && PRISMA_UNAVAILABLE.has(code)) return true;
  if (exception.constructor.name === "PrismaClientInitializationError") return true;
  const meta = (exception as { meta?: { code?: unknown; message?: unknown } }).meta;
  return PG_UNAVAILABLE.test(`${exception.message} ${String(meta?.code ?? "")} ${String(meta?.message ?? "")}`);
}

/**
 * Every error answer goes through here. Messages from errors we throw on
 * purpose (HttpException) are ours and written for players, so they're sent
 * as they are. Anything else (Prisma, Postgres, a bug) is never sent: the
 * player gets a friendly message and a reference, and the full error is
 * logged under that reference.
 *
 * This doesn't depend on NODE_ENV being "production": the host doesn't set it
 * by itself, and a database error once reached players word for word.
 * NODE_ENV=development shows the real message, for local work.
 */
@Catch()
export class SanitizedExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SanitizedExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = String(request.headers["x-request-id"] ?? randomUUID());

    let status: number;
    let message: string | string[];
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      message = typeof body === "string" ? body : typeof body === "object" && body && "message" in body ? (body as { message: string | string[] }).message : exception.message;
    } else if (isDatabaseUnavailable(exception)) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      message = BUSY_ERROR;
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = FRIENDLY_ERROR;
    }
    if (process.env.NODE_ENV === "development" && !(exception instanceof HttpException) && exception instanceof Error) message = exception.message;

    if (!(exception instanceof HttpException) || status >= 500) {
      this.logger.error(`${request.method} ${request.url} [${requestId}] ${status}`, exception instanceof Error ? exception.stack : String(exception));
    }

    if (response.headersSent) return;
    response.status(status).json({ statusCode: status, message, requestId });
  }
}
