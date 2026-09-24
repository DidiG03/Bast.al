import { createHmac, randomBytes } from "crypto";
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

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

  const secret = process.env.REQUEST_INTEGRITY_SECRET;
  if (secret && bodyText !== undefined) {
    Object.assign(headers, sign({ secret, method, path: targetPath, body: bodyText }));
  }

  const upstream = await fetch(url, {
    method,
    headers,
    body: bodyText,
    cache: "no-store",
  });

  if (path === "notifications/stream" && upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
      },
    });
  }

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "x-request-id": upstream.headers.get("x-request-id") ?? headers["x-request-id"],
      "cache-control": "no-store",
    },
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
