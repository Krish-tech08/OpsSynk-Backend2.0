import type { Env } from "./config/env.js";
import type { Store } from "./repositories/store.js";
import type { AuthVerifier } from "./integrations/firebase/auth.verifier.js";
import { GitHubService } from "./integrations/github/github.service.js";
import type { GitHubTransport } from "./integrations/github/github.client.js";
import { FIXTURE_HTML_BASE } from "./integrations/github/fixture.transport.js";
import type { HealthConfig } from "./domain/health/health.config.js";
import { HealthService } from "./services/health.service.js";
import { ProjectService } from "./services/project.service.js";
import type { GeminiClient } from "./integrations/gemini/gemini.client.js";
import { InvestigationService } from "./services/investigation.service.js";
import { IncidentService } from "./services/incident.service.js";
import { EventBus } from "./domain/investigations/event-bus.js";
import type { Agent, ReviewAgent } from "./agents/agent.types.js";
import type { AgentId } from "./types/investigation.js";

export interface AppContext {
  env: Env;
  store: Store;
  verifier: AuthVerifier;
  github: GitHubService;
  health: HealthService;
  projects: ProjectService;
  gemini: GeminiClient | null;
  bus: EventBus;
  investigations: InvestigationService;
  incidents: IncidentService;
  now: () => Date;
}

export interface ContextDeps {
  env: Env;
  store: Store;
  verifier: AuthVerifier;
  transport: GitHubTransport;
  gemini: GeminiClient | null;
  healthConfig: HealthConfig;
  now?: () => Date;
  agents?: { specialists: Partial<Record<AgentId, Agent>>; review: ReviewAgent | null };
}

/** Wires every service from its dependencies. Tests pass fakes; server.ts passes real implementations. */
export function buildContext(d: ContextDeps): AppContext {
  const now = d.now ?? (() => new Date());
  const github = new GitHubService(d.transport, {
    allowlist: d.env.GITHUB_REPOSITORY_ALLOWLIST,
    activityWindowDays: d.healthConfig.windows.activityDays,
    ciWindowDays: d.healthConfig.windows.ciDays,
    now,
    htmlBaseUrl: d.transport.source === "fixture" ? FIXTURE_HTML_BASE : "https://github.com",
  });
  const health = new HealthService(d.store, github, d.healthConfig, now);
  const projects = new ProjectService(d.store, github, d.env.GITHUB_REPOSITORY_ALLOWLIST, now);
  const bus = new EventBus();
  const investigations = new InvestigationService({ env: d.env, store: d.store, github, health, gemini: d.gemini, bus, now, agents: d.agents });
  const incidents = new IncidentService(d.store, investigations, now);
  return { env: d.env, store: d.store, verifier: d.verifier, github, health, projects, gemini: d.gemini, bus, investigations, incidents, now };
}
