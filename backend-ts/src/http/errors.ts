// One place that turns every problem into a clear answer in the person's language.
import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import { languageFromHeader, LocalizedError, t, Text } from "../i18n";
import { PayPalError } from "../paypal";
import { InvalidTransition } from "../states";

export const NOT_FOUND = t("Not found.", "Nicht gefunden.");

export function languageOf(request: Request): string {
  return languageFromHeader(request.header("x-language") || request.header("accept-language"));
}

/** The input did not fit. `fields` names what to fix, like "lines.0.quantity". */
export class ValidationFailed extends Error {
  constructor(readonly fields: string[]) {
    super("validation failed");
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const language = languageOf(request);
    const send = (status: number, body: Record<string, unknown>): void => {
      response.status(status).json(body);
    };

    if (error instanceof LocalizedError) return send(error.status, { detail: error.localized(language) });
    if (error instanceof InvalidTransition) {
      return send(409, { detail: t(
        "This step is not possible in the invoice's current state. Please reload the page.",
        "Dieser Schritt ist im aktuellen Status der Rechnung nicht möglich. Bitte laden Sie die Seite neu.",
      ).get(language) });
    }
    if (error instanceof PayPalError) {
      return send(502, { detail: new Text(`PayPal problem: ${error.message}`, `PayPal-Problem: ${error.message}`).get(language) });
    }
    if (error instanceof ValidationFailed) {
      return send(422, { detail: t("Please check the values you entered.", "Bitte prüfen Sie Ihre Eingaben.").get(language), fields: error.fields });
    }
    const status = (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode;
    if ((error as { type?: string }).type === "entity.parse.failed") {
      if (request.path.endsWith("/paypal/webhook")) return send(400, { detail: "Not JSON" });
      return send(422, { detail: t("Please check the values you entered.", "Bitte prüfen Sie Ihre Eingaben.").get(language), fields: [] });
    }
    if (typeof status === "number" && status >= 400 && status < 500) {
      const notFound = status === 404;
      return send(status, { detail: notFound ? NOT_FOUND.get(language) : String((error as Error).message) });
    }
    console.error("Unexpected error:", error);
    return send(500, { detail: "Internal Server Error" });
  }
}
