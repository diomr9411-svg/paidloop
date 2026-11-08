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
import { connectionOf, effectiveSettings, Vault } from "./connections";
import { buildAi, buildPaypal, dataDirOf, Services } from "./http/services";
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
  /** Used for PayPal and AI calls built from saved keys. Tests swap it. */
  http?: typeof fetch;
}

/** Same pieces as always, but each can be swapped in a test. */
export async function createApp(options: AppOptions = {}): Promise<{ app: NestExpressApplication; services: Services }> {
  const settings = options.settings ?? loadSettings();
  const db = options.db ?? new Db(settings.databaseUrl);
  db.prepare();
  // Keys the owner saved in the app win over the .env file.
  const dataDir = dataDirOf(db);
  const vault = new Vault(dataDir ? join(dataDir, "secret.key") : null);
  const effective = effectiveSettings(settings, connectionOf(db), vault);
  const builders = {
    paypal: (now: Settings) => options.paypal ?? buildPaypal(now, dataDir, options.http),
    ai: (now: Settings) => options.ai ?? buildAi(now, dataDir, options.http),
  };
  const services = new Services(db, builders.paypal(effective), builders.ai(effective), effective, { base: settings, vault, builders, http: options.http });
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forServices(services), { logger: ["error", "warn"], bodyParser: true });
  app.useGlobalFilters(new ApiExceptionFilter());

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  // The owner screens hold the keys and have no login, so only this computer may use them.
  // A web page from another site can't send changes through the owner's browser (cross-site request),
  // and a look-alike address can't reach the app (DNS rebinding).
  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  try {
    allowedHosts.add(new URL(settings.publicBaseUrl).hostname.toLowerCase());
  } catch {
    // no public address set
  }
  const hostOf = (value: string): string => {
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return "";
    }
  };
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/api/")) return next();
    if (!allowedHosts.has(hostOf(`http://${req.headers.host ?? ""}`))) return res.status(403).json({ detail: "This address may not use PaidLoop." });
    const origin = req.headers.origin;
    if (origin && req.method !== "GET" && req.method !== "HEAD" && !allowedHosts.has(hostOf(origin))) {
      return res.status(403).json({ detail: "Requests from other websites are not allowed." });
    }
    next();
  });

  // Serve the built screens, so one command runs everything.
  if (existsSync(FRONTEND)) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (req.path.startsWith("/api/")) return next();
      const candidate = resolve(FRONTEND, "." + req.path);
      if (req.path !== "/" && candidate.startsWith(FRONTEND + sep) && existsSync(candidate) && statSync(candidate).isFile()) {
        // Built files carry a fingerprint in their name, so they never change and can be kept.
        if (req.path.startsWith("/assets/")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.sendFile(candidate);
      }
      // The page itself is checked every time, so an update shows at once, not only after a hard reload.
      res.setHeader("Cache-Control", "no-cache");
      return res.sendFile(join(FRONTEND, "index.html"));
    });
  }
  await app.init();
  return { app, services };
}

export type { INestApplication };
