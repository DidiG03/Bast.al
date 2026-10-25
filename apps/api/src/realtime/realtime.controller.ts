import { Controller, MessageEvent, Sse, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Observable, defer, from, interval, map, merge, mergeMap, of, takeUntil, timer } from "rxjs";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentActor } from "../auth/current-actor.decorator";
import type { Actor } from "../auth/permissions";
import { RealtimeService } from "./realtime.service";

/** Keeps proxies and load balancers from closing an idle stream. */
const HEARTBEAT_MS = 25_000;
/**
 * The session is only checked when the stream opens, so each stream ends after
 * a while and the browser reconnects with a fresh token. That is how a
 * suspension or sign-out also cuts off live updates. 50 seconds by default
 * (REALTIME_STREAM_MS): the stream passes through the web app's server
 * function, which its host cuts off after a time limit (60 s is allowed on
 * every plan); a stream the host cuts shows as an error in the browser and
 * loses the updates until it reconnects, one this side ends cleanly doesn't.
 */
const MAX_STREAM_MS = Number(process.env.REALTIME_STREAM_MS) || 50_000;

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
      // A Player's stream also gets their team's live prices.
      defer(() => from(this.realtime.topicsFor(actor).catch(() => [] as string[]))).pipe(mergeMap((topics) => this.realtime.stream(actor.id, topics))),
      interval(HEARTBEAT_MS).pipe(
        map((): MessageEvent => ({ type: "ping", data: "" })),
      ),
    ).pipe(takeUntil(timer(MAX_STREAM_MS)));
  }
}
