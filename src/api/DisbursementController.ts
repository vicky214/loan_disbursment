import { idempotencyManager } from "../idempotency/IdempotencyManager.js";
import { sagaOrchestrator, SagaResult } from "../saga/SagaOrchestrator.js";
import { ledger } from "../ledger/DoubleEntryLedger.js";
import { outboxRelay } from "../outbox/OutboxRelay.js";

export interface DisbursementRequest {
  disbursementId: string;
  borrowerId: string;
  amount: number;
  bankAccount: string;
}

export interface ApiResponse<T = any> {
  statusCode: number;
  headers: Record<string, string>;
  body: T;
}

export class DisbursementController {
  async handleDisburse(
    idempotencyKey: string | undefined,
    body: DisbursementRequest
  ): Promise<ApiResponse> {
    if (!idempotencyKey) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Missing required header: Idempotency-Key" },
      };
    }

    if (!body.disbursementId || !body.borrowerId || !body.amount || !body.bankAccount) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Missing required fields: disbursementId, borrowerId, amount, bankAccount" },
      };
    }

    const lockResult = await idempotencyManager.lockOrLookup(idempotencyKey, body);

    if (lockResult.state === "CACHED") {
      return {
        statusCode: lockResult.statusCode,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Status": "HIT",
        },
        body: lockResult.response,
      };
    }

    if (lockResult.state === "IN_FLIGHT") {
      return {
        statusCode: 409,
        headers: { "Content-Type": "application/json" },
        body: { error: "Concurrent request in progress for this Idempotency-Key. Please retry shortly." },
      };
    }

    if (lockResult.state === "MISMATCH") {
      return {
        statusCode: 422,
        headers: { "Content-Type": "application/json" },
        body: {
          error: "Idempotency key reuse with mismatched payload signature.",
          detail: { originalHash: lockResult.originalHash, incomingHash: lockResult.incomingHash },
        },
      };
    }

    try {
      const sagaResult: SagaResult = await sagaOrchestrator.executeDisbursement(
        body.disbursementId,
        body.borrowerId,
        body.amount,
        body.bankAccount
      );

      const responsePayload = {
        disbursementId: body.disbursementId,
        status: sagaResult.success ? "PROCESSED" : "FAILED",
        amount: body.amount,
        bankReferenceId: sagaResult.context.bankReferenceId,
        completedSteps: sagaResult.completedSteps,
        compensatedSteps: sagaResult.compensatedSteps,
        error: sagaResult.error,
        timestamp: Date.now(),
      };

      const statusCode = sagaResult.success ? 201 : 400;

      if (sagaResult.success) {
        await idempotencyManager.complete(idempotencyKey, responsePayload, statusCode);
      } else {
        await idempotencyManager.fail(idempotencyKey, responsePayload, statusCode);
      }

      return {
        statusCode,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Status": "NEW",
        },
        body: responsePayload,
      };
    } catch (err: any) {
      const errorPayload = { error: "Internal Pipeline Error", message: err.message };
      await idempotencyManager.fail(idempotencyKey, errorPayload, 500);

      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: errorPayload,
      };
    }
  }

  getAuditSummary() {
    return {
      loanReceivablesBalance: ledger.getAccountBalance("LOAN_RECEIVABLES"),
      cashAtBankBalance: ledger.getAccountBalance("CASH_AT_BANK"),
      totalLedgerEntries: ledger.getAllEntries().length,
      outboxMetrics: outboxRelay.getMetrics(),
    };
  }
}

export const disbursementController = new DisbursementController();
