import type { EngineeringSnapshot, Incident, Membership, Organization, Project, Task } from "../types/domain.js";
import type { Investigation, InvestigationEvent } from "../types/investigation.js";

export type NewEvent = Omit<InvestigationEvent, "id" | "sequence">;

/** Data access used by services. Implemented by MemoryStore (tests, local) and FirestoreStore (deployments). */
export interface Store {
  kind: "firestore" | "memory";
  organizations: {
    get(id: string): Promise<Organization | null>;
    upsert(org: Organization): Promise<void>;
  };
  members: {
    get(organizationId: string, uid: string): Promise<Membership | null>;
    upsert(m: Membership): Promise<void>;
  };
  projects: {
    list(organizationId: string): Promise<Project[]>;
    get(id: string): Promise<Project | null>;
    upsert(p: Project): Promise<void>;
  };
  tasks: {
    listByProject(projectId: string): Promise<Task[]>;
    get(id: string): Promise<Task | null>;
    upsert(t: Task): Promise<void>;
  };
  incidents: {
    list(organizationId: string): Promise<Incident[]>;
    get(id: string): Promise<Incident | null>;
    upsert(i: Incident): Promise<void>;
  };
  investigations: {
    create(inv: Investigation): Promise<void>;
    get(id: string): Promise<Investigation | null>;
    list(organizationId: string, limit: number): Promise<Investigation[]>;
    update(id: string, patch: Partial<Investigation>): Promise<void>;
    findByIdempotencyKey(organizationId: string, requestedBy: string, key: string): Promise<Investigation | null>;
    /** Investigations still queued or running (used for restart recovery). */
    listActive(limit: number): Promise<Investigation[]>;
  };
  events: {
    /** Assigns the next sequence number atomically and persists the event. */
    append(event: NewEvent): Promise<InvestigationEvent>;
    list(investigationId: string, afterSequence: number, limit: number): Promise<InvestigationEvent[]>;
  };
  snapshots: {
    upsert(s: EngineeringSnapshot): Promise<void>;
    listByOrganization(organizationId: string, limit: number): Promise<EngineeringSnapshot[]>;
  };
}
