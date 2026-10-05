import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import * as compression from "compression";
import { json, urlencoded } from "express";
import type { IncomingMessage } from "http";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { syncSchema } from "./schema-sync";
import { initSentry } from "./sentry";

async function bootstrap() {
  initSentry();
  syncSchema();
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
    bodyParser: false,
  });

  // Only trust X-Forwarded-For from a private/loopback peer (our own Next.js BFF
  // or a local reverse proxy on the same docker network). A public caller
  // hitting this API directly cannot spoof their IP to dodge lockouts or frame
  // another peer for a honeypot trip. Widen via TRUSTED_PROXIES only if a real
  // reverse proxy is deployed with a stable, non-private address.
  app
    .getHttpAdapter()
    .getInstance()
    .set("trust proxy", process.env.TRUSTED_PROXIES?.trim() || "loopback, linklocal, uniquelocal");

  // Cap payload size to reduce DoS via large bodies (webhooks stay small).
  app.use("/api/webhooks/clerk", json({ limit: "256kb", verify: rawBodySaver }));
  app.use(json({ limit: "64kb", verify: rawBodySaver }));
  app.use(urlencoded({ extended: true, limit: "64kb" }));

  // Answers go out gzipped: the week's match list is around a tenth of its size.
  // The live stream is left alone, so each update reaches the browser at once.
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) => !String(res.getHeader("content-type") ?? "").includes("text/event-stream") && compression.filter(req, res),
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: process.env.NODE_ENV === "production",
      crossOriginEmbedderPolicy: false,
      hsts: process.env.NODE_ENV === "production" ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );

  const origins = process.env.CORS_ORIGIN?.split(",").map((o) => o.trim()).filter(Boolean) ?? [
    "http://localhost:3000",
  ];
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "svix-id",
      "svix-timestamp",
      "svix-signature",
      "x-request-id",
      "x-bastal-timestamp",
      "x-bastal-nonce",
      "x-bastal-signature",
    ],
  });

  app.getHttpAdapter().get("/", (_req: unknown, res: { json: (body: unknown) => void }) => {
    res.json({
      name: "Bast.al API",
      status: "ok",
      health: "/api/health",
      docs: process.env.NODE_ENV === "production" ? undefined : "/docs",
    });
  });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  if (process.env.NODE_ENV !== "production") {
    const swagger = new DocumentBuilder()
      .setTitle("Bast.al API")
      .setDescription("Hierarchical virtual-credit betting simulation API")
      .setVersion("1.0")
      .addBearerAuth()
      .build();
    SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, swagger));
  }

  await app.listen(process.env.PORT ?? 4000);
}

function rawBodySaver(req: IncomingMessage & { rawBody?: Buffer }, _res: unknown, buf: Buffer) {
  if (Buffer.isBuffer(buf)) {
    req.rawBody = buf;
  }
}

bootstrap();
