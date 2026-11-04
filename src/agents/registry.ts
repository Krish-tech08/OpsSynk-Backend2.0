import type { Agent, ReviewAgent } from "./agent.types.js";
import { githubAgent } from "./github/github.agent.js";
import { projectAgent } from "./project/project.agent.js";
import { bugAgent } from "./bug/bug.agent.js";
import { devopsAgent } from "./devops/devops.agent.js";
import { reviewAgent } from "./review/review.agent.js";

/** Phase 4: all specialists. The Manager is the orchestrator plus manager.agent.ts. Disable agents via ENABLED_AGENTS. */
export const SPECIALIST_AGENTS: Partial<Record<"github" | "project" | "bug" | "devops", Agent>> = {
  github: githubAgent, project: projectAgent, bug: bugAgent, devops: devopsAgent,
};
export const REVIEW_AGENT: ReviewAgent | null = reviewAgent;
