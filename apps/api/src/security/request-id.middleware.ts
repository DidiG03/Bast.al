import { Injectable, NestMiddleware } from "@nestjs/common";
import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const incoming = req.headers["x-request-id"];
    const id =
      typeof incoming === "string" && incoming.length > 0 && incoming.length < 80
        ? incoming
        : randomUUID();
    req.headers["x-request-id"] = id;
    res.setHeader("x-request-id", id);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    next();
  }
}
