import { createHash } from "crypto";
import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnprocessableEntityException,
  UseInterceptors,
  applyDecorators,
} from "@nestjs/common";
import { ApiHeader } from "@nestjs/swagger";
import { Prisma } from "@prisma/client";
import { Response } from "express";
import { Observable, catchError, concatMap, from, map, of, switchMap, throwError } from "rxjs";
import { AuthenticatedRequest } from "../auth/auth.guard";
import { PrismaService } from "../prisma.service";

const HEADER = "idempotency-key";
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
/** How long a key is remembered. Past this, the same key starts a new request. */
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Makes a money-moving endpoint safe to call twice. The client sends a fresh
 * `Idempotency-Key` per intended action and reuses it on retries or double
 * taps. The first request runs; any repeat with the same key and body gets the
 * first response back (with `Idempotent-Replayed: true`) instead of running
 * again. A repeat that arrives while the first is still running gets 409.
 * If the first request fails, the key is released so a retry can run.
 *
 * Must run after AuthGuard: keys are scoped per signed-in user.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();
    const userId = request.actor?.id;
    if (!userId) {
      throw new BadRequestException("Idempotent endpoints require a signed-in user");
    }

    const key = request.headers[HEADER];
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      throw new BadRequestException("A valid Idempotency-Key header is required for this action");
    }

    const path = request.originalUrl.split("?")[0] ?? request.path;
    const requestHash = createHash("sha256")
      .update(`${request.method.toUpperCase()}\n${path}\n${JSON.stringify(request.body ?? null)}`)
      .digest("hex");

    return from(this.claim(userId, key, requestHash)).pipe(
      switchMap((existing) => {
        if (existing) {
          response.setHeader("Idempotent-Replayed", "true");
          return of(existing.responseBody);
        }
        return next.handle().pipe(
          // Save the result before answering, so a retry that arrives right
          // after gets the stored result rather than a 409.
          concatMap((body) =>
            from(
              this.prisma.idempotencyKey
                .update({
                  where: { userId_key: { userId, key } },
                  data: { completed: true, responseBody: (body ?? null) as Prisma.InputJsonValue },
                })
                // The action already happened; failing to store it only means a
                // later retry sees 409 instead of the stored result.
                .catch(() => undefined),
            ).pipe(map(() => body)),
          ),
          catchError((error) =>
            from(
              this.prisma.idempotencyKey
                .delete({ where: { userId_key: { userId, key } } })
                .catch(() => undefined),
            ).pipe(switchMap(() => throwError(() => error))),
          ),
        );
      }),
    );
  }

  /**
   * Reserves the key. Returns null when this request should run, or the stored
   * result when it's a repeat of one that already finished.
   */
  private async claim(userId: string, key: string, requestHash: string) {
    await this.prisma.idempotencyKey.deleteMany({
      where: { userId, createdAt: { lt: new Date(Date.now() - TTL_MS) } },
    });

    try {
      await this.prisma.idempotencyKey.create({ data: { userId, key, requestHash } });
      return null;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
    }

    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { userId_key: { userId, key } },
    });
    if (!existing) {
      // The first attempt failed and released the key between our insert and read.
      throw new ConflictException("This request is being retried. Try again.");
    }
    if (existing.requestHash !== requestHash) {
      throw new UnprocessableEntityException("This request ID was already used for a different action");
    }
    if (!existing.completed) {
      throw new ConflictException("This request is still being processed. Refresh before trying again.");
    }
    return existing;
  }
}

/**
 * Marks a route as idempotent. Put it after @UseGuards so the actor is known.
 * Use on anything that moves money (credit transfers now, bet placement later).
 */
export function Idempotent() {
  return applyDecorators(
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: "Idempotency-Key",
      required: true,
      description: "Unique per intended action (16-128 chars of A-Z a-z 0-9 _ -). Reuse it when retrying.",
    }),
  );
}
