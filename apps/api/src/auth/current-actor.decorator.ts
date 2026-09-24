import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { Actor } from "./permissions";

export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const request = ctx.switchToHttp().getRequest<{ actor: Actor }>();
  return request.actor;
});
