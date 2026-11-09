import crypto from "crypto";
import { EventEmitter } from "events";

export interface OutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: any;
  status: "PENDING" | "PUBLISHED" | "FAILED";
  retryCount: number;
  createdAt: number;
  publishedAt?: number;
}

export class OutboxRelay extends EventEmitter {
  private events: OutboxEvent[] = [];
  private isRelaying = false;
  private relayTimer: NodeJS.Timeout | null = null;
  private totalDelivered = 0;

  constructor(pollIntervalMs = 500) {
    super();
    this.relayTimer = setInterval(() => this.processPendingEvents(), pollIntervalMs);
    this.relayTimer.unref();
  }

  stageEvent(aggregateType: string, aggregateId: string, eventType: string, payload: any): OutboxEvent {
    const event: OutboxEvent = {
      id: crypto.randomUUID(),
      aggregateType,
      aggregateId,
      eventType,
      payload,
      status: "PENDING",
      retryCount: 0,
      createdAt: Date.now(),
    };
    this.events.push(event);
    return event;
  }

  async processPendingEvents(): Promise<number> {
    if (this.isRelaying) return 0;
    this.isRelaying = true;

    let processedCount = 0;
    const pending = this.events.filter((e) => e.status === "PENDING");

    for (const evt of pending) {
      try {

        await new Promise((r) => setTimeout(r, 10));

        evt.status = "PUBLISHED";
        evt.publishedAt = Date.now();
        processedCount++;
        this.totalDelivered++;

        this.emit("event:published", evt);
      } catch (err) {
        evt.retryCount++;
        if (evt.retryCount > 5) {
          evt.status = "FAILED";
          this.emit("event:failed", evt);
        }
      }
    }

    this.isRelaying = false;
    return processedCount;
  }

  getMetrics() {
    return {
      pendingOutboxCount: this.events.filter((e) => e.status === "PENDING").length,
      totalDelivered: this.totalDelivered,
    };
  }

  shutdown(): void {
    if (this.relayTimer) {
      clearInterval(this.relayTimer);
      this.relayTimer = null;
    }
  }
}

export const outboxRelay = new OutboxRelay();
