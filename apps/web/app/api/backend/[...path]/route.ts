import { createHmac, randomBytes } from "crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { signedClientHeaders } from "../../../../lib/client-signature";

const UPSTREAM = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Server-side BFF proxy: attaches anti-replay HMAC so the browser never sees
 * REQUEST_INTEGRITY_SECRET, while Nest can require signed mutations.
 */
export async function GET(
  request: NextRequest,
  context: { params: { path: string[] } },
) {
  return proxy(request, context.params.path);
}

export async function POST(
  request: NextRequest,
  context: { params: { path: string[] } },
) {
  return proxy(request, context.params.path);
}

export async function PUT(
  request: NextRequest,
  context: { params: { path: string[] } },
) {
  return proxy(request, context.params.path);
}

export async function PATCH(
  request: NextRequest,
  context: { params: { path: string[] } },
) {
  return proxy(request, context.params.path);
}

export async function DELETE(
  request: NextRequest,
  context: { params: { path: string[] } },
) {
  return proxy(request, context.params.path);
}

async function proxy(request: NextRequest, parts: string[]) {
  const path = parts.join("/");
  const targetPath = `/api/${path}`;
  const url = new URL(targetPath, UPSTREAM);
  request.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const { getToken } = await auth();
  const token = await getToken();
  const method = request.method.toUpperCase();
  const bodyText =
    method === "GET" || method === "HEAD" ? undefined : await request.text();

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": request.headers.get("x-request-id") ?? cryptoRandom(),
  };
  if (token) headers.authorization = `Bearer ${token}`;

  // Forward whatever X-Forwarded-For this server itself received (set by a
  // real reverse proxy/CDN in front of Next, if any) so Nest's rate limiting
  // and lockouts key on the actual visitor rather than always seeing this BFF's
  // own address. Nest only trusts this header when it comes from a private/
  // loopback peer (see main.ts `trust proxy`), so a client can't spoof it by
  // sending its own X-Forwarded-For straight to this route.
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

  // "Send it only if it changed": the API answers 304 with no body when the
  // browser already has this exact answer (see apiFetch's `revalidate`).
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && method === "GET") headers["if-none-match"] = ifNoneMatch;

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) headers["x-forwarded-for"] = forwardedFor;

  const userAgent = request.headers.get("user-agent");
  if (userAgent) headers["user-agent"] = userAgent;

  const secret = process.env.REQUEST_INTEGRITY_SECRET;
  Object.assign(headers, signedClientHeaders(request.headers));
  if (secret && bodyText !== undefined) {
    Object.assign(headers, sign({ secret, method, path: targetPath, body: bodyText }));
  }

  // SSE connections are meant to stay open indefinitely, but Node's global
  // `fetch` (undici) enforces a hard ~300s timeout on reading a response body
  // regardless of activity, which kills long-lived streams with a 500 every
  // five minutes. Node's core http/https client has no such limit, so the
  // stream path bypasses fetch entirely.
  if (path === "realtime/stream") {
    return proxyStream(url, headers);
  }

  const upstream = await fetch(url, {
    method,
    headers,
    body: bodyText,
    cache: "no-store",
  });

  // Passed on as it arrives rather than read in full first.
  const etag = upstream.headers.get("etag");
  return new NextResponse(upstream.status === 304 ? null : upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "x-request-id": upstream.headers.get("x-request-id") ?? headers["x-request-id"],
      "cache-control": "no-store",
      ...(etag ? { etag } : {}),
    },
  });
}

function proxyStream(url: URL, headers: Record<string, string>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const upstreamReq = requestFn(url, { method: "GET", headers }, (upstreamRes) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          upstreamRes.on("data", (chunk: Buffer) => controller.enqueue(chunk));
          upstreamRes.on("end", () => controller.close());
          upstreamRes.on("error", (err) => controller.error(err));
        },
        cancel() {
          upstreamRes.destroy();
        },
      });
      resolve(
        new Response(body, {
          status: upstreamRes.statusCode ?? 200,
          headers: {
            "content-type": upstreamRes.headers["content-type"] ?? "text/event-stream",
            "cache-control": "no-cache, no-store",
            connection: "keep-alive",
          },
        }),
      );
    });
    upstreamReq.on("error", reject);
    upstreamReq.end();
  });
}

function sign(input: { secret: string; method: string; path: string; body: string }) {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString("base64url");
  const payload = `${input.method}\n${input.path}\n${timestamp}\n${nonce}\n${input.body}`;
  const signature = createHmac("sha256", Buffer.from(input.secret, "hex"))
    .update(payload)
    .digest("hex");
  return {
    "x-bastal-timestamp": timestamp,
    "x-bastal-nonce": nonce,
    "x-bastal-signature": signature,
  };
}

function cryptoRandom() {
  return randomBytes(12).toString("hex");
}
