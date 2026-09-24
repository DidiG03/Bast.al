import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  Req,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { RawBodyRequest } from "@nestjs/common";
import { Request } from "express";
import { ClerkWebhookService } from "./clerk-webhook.service";

@ApiExcludeController()
@Controller("webhooks/clerk")
export class ClerkWebhookController {
  constructor(private readonly webhooks: ClerkWebhookService) {}

  @Post()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers("svix-id") svixId: string,
    @Headers("svix-timestamp") svixTimestamp: string,
    @Headers("svix-signature") svixSignature: string,
  ) {
    if (!svixId || !svixTimestamp || !svixSignature) {
      throw new BadRequestException("Missing Svix signature headers");
    }

    const payload = req.rawBody?.toString("utf8");
    if (!payload) {
      throw new BadRequestException(
        "Empty raw webhook payload — ensure Nest is started with rawBody: true",
      );
    }

    return this.webhooks.handle({
      payload,
      headers: {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      },
    });
  }
}
