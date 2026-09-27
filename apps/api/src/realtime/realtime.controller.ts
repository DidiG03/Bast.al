import { Controller, MessageEvent, Sse, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Observable, interval, map, merge, of, takeUntil, timer } from "rxjs";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentActor } from "../auth/current-actor.decorator";
import type { Actor } from "../auth/permissions";
import { RealtimeService } from "./realtime.service";

/** Keeps proxies and load balancers from closing an idle stream. */
const HEARTBEAT_MS = 25_000;
/**
 * The session is only checked when the stream opens, so each stream ends after
 * a few minutes and the browser reconnects with a fresh token. That is how a
 * suspension or sign-out also cuts off live updates.
 */
const MAX_STREAM_MS = 5 * 60_000;

@ApiTags("realtime")
@ApiBearerAuth()
@Controller("realtime")
@UseGuards(AuthGuard)
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Sse("stream")
  stream(@CurrentActor() actor: Actor): Observable<MessageEvent> {
    return merge(
      of<MessageEvent>({
        type: "ready",
        data: { at: new Date().toISOString() },
        retry: 3_000,
      }),
      this.realtime.stream(actor.id),
      interval(HEARTBEAT_MS).pipe(
        map((): MessageEvent => ({ type: "ping", data: "" })),
      ),
    ).pipe(takeUntil(timer(MAX_STREAM_MS)));
  }
}
