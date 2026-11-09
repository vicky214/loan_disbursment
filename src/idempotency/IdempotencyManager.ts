import crypto from "crypto";

export type IdempotencyStatus = "PROCESSING" | "COMPLETED" | "FAILED";

export interface IdempotencyRecord {
  key: string;
  payloadHash: string;
  status: IdempotencyStatus;
  response?: any;
  statusCode?: number;
  createdAt: number;
  expiresAt: number;
}

export class IdempotencyManager {
  private records = new Map<string, IdempotencyRecord>();
  private defaultTTLMs: number;

  constructor(defaultTTLMs = 24 * 60 * 60 * 1000) {
    this.defaultTTLMs = defaultTTLMs;
  }

  hashPayload(payload: any): string {
    const serialized = typeof payload === "string" ? payload : JSON.stringify(payload || {});
    return crypto.createHash("sha256").update(serialized).digest("hex");
  }

  async lockOrLookup(
    key: string,
    payload: any
  ): Promise<
    | { state: "EXECUTE" }
    | { state: "CACHED"; response: any; statusCode: number }
    | { state: "IN_FLIGHT" }
    | { state: "MISMATCH"; originalHash: string; incomingHash: string }
  > {
    const incomingHash = this.hashPayload(payload);
    const existing = this.records.get(key);

    if (existing) {
      if (existing.expiresAt < Date.now()) {
        this.records.delete(key);
      } else {
        if (existing.payloadHash !== incomingHash) {
          return {
            state: "MISMATCH",
            originalHash: existing.payloadHash,
            incomingHash,
          };
        }

        if (existing.status === "COMPLETED" && existing.response) {
          return {
            state: "CACHED",
            response: existing.response,
            statusCode: existing.statusCode || 200,
          };
        }

        if (existing.status === "PROCESSING") {
          return { state: "IN_FLIGHT" };
        }
      }
    }

    const record: IdempotencyRecord = {
      key,
      payloadHash: incomingHash,
      status: "PROCESSING",
      createdAt: Date.now(),
      expiresAt: Date.now() + this.defaultTTLMs,
    };
    this.records.set(key, record);

    return { state: "EXECUTE" };
  }

  async complete(key: string, response: any, statusCode = 200): Promise<void> {
    const record = this.records.get(key);
    if (record) {
      record.status = "COMPLETED";
      record.response = response;
      record.statusCode = statusCode;
    }
  }

  async fail(key: string, errorResponse: any, statusCode = 500): Promise<void> {
    const record = this.records.get(key);
    if (record) {
      record.status = "FAILED";
      record.response = errorResponse;
      record.statusCode = statusCode;
    }
  }

  async purge(key: string): Promise<boolean> {
    return this.records.delete(key);
  }
}

export const idempotencyManager = new IdempotencyManager();
