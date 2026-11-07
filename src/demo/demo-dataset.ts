/**
 * OpsSynk demonstration dataset (explicitly synthetic). Used by:
 *  - scripts/seed-demo.ts   → Firestore projects/tasks/incidents (all flagged isDemoData: true)
 *  - the fixture GitHub transport (GITHUB_MODE=fixture) → raw GitHub-shaped JSON
 * Times are offsets from "now", so staleness rules behave the same whenever the demo runs.
 * Edit `repository` names to match the GitHub teammate's real repositories when using live mode.
 */
export type DemoProfile = "healthy" | "warning" | "critical";
export type DemoTeam = "Mobile" | "Platform" | "Productivity" | "Infrastructure";

export interface DemoProject {
  id: string;
  name: string;
  team: DemoTeam;
  repository: string;
  profile: DemoProfile;
  description: string;
  hasDeployments: boolean;
}

export const DEMO_ORG_ID = "org_demo";
/** The real organization this deployment serves, and its owner's Firebase Auth UID. */
export const DEMO_ORG_NAME = "SynkStack";
export const DEMO_OWNER_UID = "YV0ZBCkMsaYFCn4OpH5oJ3gEVIu1";
export const DEMO_GITHUB_ORG = "SynkStack";

export const DEMO_PROJECTS: DemoProject[] = [
  { id: "demo_android_app", name: "Android App", team: "Mobile", repository: "mobile-app-android", profile: "healthy", description: "Customer Android application.", hasDeployments: true },
  { id: "demo_ios_app", name: "iOS App", team: "Mobile", repository: "mobile-app-ios", profile: "warning", description: "Customer iOS application.", hasDeployments: false },
  { id: "demo_payments_sdk", name: "Payments SDK", team: "Mobile", repository: "mobile-payments-sdk", profile: "critical", description: "In-app payments SDK.", hasDeployments: true },
  { id: "demo_auth_service", name: "Auth Service", team: "Platform", repository: "platform-auth-service", profile: "warning", description: "Authentication and session service.", hasDeployments: true },
  { id: "demo_api_gateway", name: "API Gateway", team: "Platform", repository: "platform-api-gateway", profile: "healthy", description: "Public API gateway.", hasDeployments: true },
  { id: "demo_notifications", name: "Notifications", team: "Platform", repository: "platform-notifications", profile: "healthy", description: "Email and push notification service.", hasDeployments: false },
  { id: "demo_docs_editor", name: "Docs Editor", team: "Productivity", repository: "productivity-docs-editor", profile: "healthy", description: "Collaborative document editor.", hasDeployments: false },
  { id: "demo_calendar_sync", name: "Calendar Sync", team: "Productivity", repository: "productivity-calendar-sync", profile: "warning", description: "Calendar synchronization worker.", hasDeployments: false },
  { id: "demo_chat_bot", name: "Chat Bot", team: "Productivity", repository: "productivity-chat-bot", profile: "critical", description: "Internal support chat bot.", hasDeployments: false },
  { id: "demo_terraform", name: "Terraform Modules", team: "Infrastructure", repository: "infra-terraform-modules", profile: "critical", description: "Shared infrastructure-as-code modules.", hasDeployments: true },
  { id: "demo_ci_templates", name: "CI Templates", team: "Infrastructure", repository: "infra-ci-templates", profile: "healthy", description: "Reusable CI workflow templates.", hasDeployments: false },
  { id: "demo_observability", name: "Observability", team: "Infrastructure", repository: "infra-observability", profile: "warning", description: "Metrics, logs and tracing stack.", hasDeployments: true },
];

/** Task blueprints per profile: [title, status, dueInDays (negative = past), assigned]. */
export const DEMO_TASKS: Record<DemoProfile, Array<[string, "todo" | "in_progress" | "blocked" | "done", number, boolean]>> = {
  healthy: [
    ["Release planning", "done", -20, true], ["Core feature implementation", "done", -6, true],
    ["Accessibility review", "done", -2, true], ["Performance tuning", "in_progress", 10, true], ["Release notes", "todo", 18, true],
  ],
  warning: [
    ["Release planning", "done", -25, true], ["Migration to new API", "in_progress", -4, true],
    ["Flaky test cleanup", "in_progress", -2, false], ["Security review", "todo", 6, true], ["Documentation update", "todo", 14, true],
  ],
  critical: [
    ["Release planning", "done", -40, true], ["Fix production crash", "blocked", -12, true],
    ["Dependency upgrade", "blocked", -8, false], ["Integration tests", "todo", -5, false], ["Launch checklist", "todo", -1, true],
  ],
};

export const DEMO_INCIDENTS = [
  { id: "demo_incident_payments", projectId: "demo_payments_sdk", title: "Checkout failures after SDK update",
    description: "Customers report failed card payments after the latest Payments SDK build.", severity: "sev1" as const, status: "investigating" as const },
  { id: "demo_incident_auth", projectId: "demo_auth_service", title: "Intermittent login timeouts",
    description: "Login requests occasionally time out during peak hours.", severity: "sev3" as const, status: "open" as const },
];
