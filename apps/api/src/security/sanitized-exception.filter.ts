import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";

@Catch()
export class SanitizedExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SanitizedExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const production = process.env.NODE_ENV === "production";

    let message: string | string[] = "Unexpected error";
    if (isHttp) {
      const body = exception.getResponse();
      if (typeof body === "string") message = body;
      else if (typeof body === "object" && body && "message" in body) {
        message = (body as { message: string | string[] }).message;
      }
    } else if (!production && exception instanceof Error) {
      message = exception.message;
    }

    if (!isHttp || status >= 500) {
      this.logger.error(
        `${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      statusCode: status,
      message: production && status >= 500 ? "Internal server error" : message,
      requestId: request.headers["x-request-id"] ?? undefined,
    });
  }
}
