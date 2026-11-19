import express from "express";
import swaggerUi from "swagger-ui-express";
import type { AppContext } from "./context.js";
import { requestId, errorHandler, notFoundHandler } from "./middleware/error.middleware.js";
import { corsForBrowsers } from "./middleware/cors.middleware.js";
import { requireAuth } from "./middleware/auth.middleware.js";
import { healthRoutes } from "./routes/health.routes.js";
import { projectRoutes } from "./routes/projects.routes.js";
import { githubRoutes } from "./routes/github.routes.js";
import { analyticsRoutes } from "./routes/analytics.routes.js";
import { agentRoutes } from "./routes/agents.routes.js";
import { incidentRoutes } from "./routes/incidents.routes.js";
import { reportRoutes } from "./routes/reports.routes.js";
import { openApiDocument } from "./openapi.js";
import { metaRoutes } from "./routes/meta.routes.js"

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(requestId);
  app.use(corsForBrowsers(ctx.env.CORS_ORIGINS));
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRoutes(ctx));
  app.get("/api/v1/openapi.json", (_req, res) => res.json(openApiDocument));
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  const api = express.Router();
  api.use(requireAuth(ctx.verifier));
  api.use("/", projectRoutes(ctx));
  api.use("/github", githubRoutes(ctx));
  api.use("/analytics", analyticsRoutes(ctx));
  api.use("/agents", agentRoutes(ctx));
  api.use("/incidents", incidentRoutes(ctx));
  api.use("/reports", reportRoutes(ctx));
  app.use("/api/v1", api);
  app.use(metaRoutes(ctx));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
