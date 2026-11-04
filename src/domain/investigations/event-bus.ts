import { EventEmitter } from "node:events";
import type { InvestigationEvent } from "../../types/investigation.js";

/** In-process fan-out of persisted events to connected SSE clients (single-instance MVP). */
export class EventBus {
  private readonly emitter = new EventEmitter();
  constructor() { this.emitter.setMaxListeners(0); }
  publish(e: InvestigationEvent) { this.emitter.emit(e.investigationId, e); }
  subscribe(investigationId: string, fn: (e: InvestigationEvent) => void): () => void {
    this.emitter.on(investigationId, fn);
    return () => this.emitter.off(investigationId, fn);
  }
}
