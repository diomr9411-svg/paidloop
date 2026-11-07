// Builds the whole app: the routes, the error answers, the screens, and the background payment check.
import { Module, DynamicModule, INestApplication, OnApplicationBootstrap, OnModuleDestroy, Inject, Injectable } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { AI } from "./ai";
import { Db } from "./db";
import { ApiExceptionFilter } from "./http/errors";
import { CONTROLLERS } from "./http/controllers";
import { buildAi, buildPaypal, Services } from "./http/services";
import { PayPalApi } from "./paypal";
import { loadSettings, REPO_ROOT, Settings } from "./settings";

export const FRONTEND = resolve(REPO_ROOT, "frontend", "dist");

@Injectable()
class SyncRunner implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(@Inject(Services) private readonly services: Services) {}
  onApplicationBootstrap(): void {
    this.services.startSync();
  }
  onModuleDestroy(): void {
    this.services.stopSync();
  }
}

@Module({})
class AppModule {
  static forServices(services: Services): DynamicModule {
    return { module: AppModule, controllers: CONTROLLERS, providers: [{ provide: Services, useValue: services }, SyncRunner] };
  }
}

export interface AppOptions {
  settings?: Settings;
  paypal?: PayPalApi;
  ai?: AI;
  db?: Db;
}

/** Same pieces as always, but each can be swapped in a test. */
export async function createApp(options: AppOptions = {}): Promise<{ app: NestExpressApplication; services: Services }> {
  const settings = options.settings ?? loadSettings();
  const db = options.db ?? new Db(settings.databaseUrl);
  db.prepare();
  const services = new Services(db, options.paypal ?? buildPaypal(settings), options.ai ?? buildAi(settings), settings);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forServices(services), { logger: ["error", "warn"], bodyParser: true });
  app.useGlobalFilters(new ApiExceptionFilter());

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  // Serve the built screens, so one command runs everything.
  if (existsSync(FRONTEND)) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (req.path.startsWith("/api/")) return next();
      const candidate = resolve(FRONTEND, "." + req.path);
      if (req.path !== "/" && candidate.startsWith(FRONTEND + sep) && existsSync(candidate) && statSync(candidate).isFile()) return res.sendFile(candidate);
      return res.sendFile(join(FRONTEND, "index.html"));
    });
  }
  await app.init();
  return { app, services };
}

export type { INestApplication };
