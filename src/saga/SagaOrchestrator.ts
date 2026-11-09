import { ledger } from "../ledger/DoubleEntryLedger.js";
import { outboxRelay } from "../outbox/OutboxRelay.js";

export interface SagaContext {
  disbursementId: string;
  borrowerId: string;
  amount: number;
  bankAccount: string;
  creditReserved: boolean;
  kycValidated: boolean;
  bankReferenceId?: string;
  ledgerCommitted: boolean;
  failureReason?: string;
}

export interface SagaStep {
  name: string;
  execute: (ctx: SagaContext) => Promise<void>;
  compensate: (ctx: SagaContext) => Promise<void>;
}

export interface SagaResult {
  success: boolean;
  disbursementId: string;
  completedSteps: string[];
  compensatedSteps: string[];
  error?: string;
  context: SagaContext;
}

export class SagaOrchestrator {
  private steps: SagaStep[] = [];

  constructor() {
    this.definePipeline();
  }

  private definePipeline(): void {

    this.steps.push({
      name: "RESERVE_CREDIT_LINE",
      execute: async (ctx) => {

        await new Promise((r) => setTimeout(r, 15));
        ctx.creditReserved = true;
      },
      compensate: async (ctx) => {
        if (ctx.creditReserved) {

          await new Promise((r) => setTimeout(r, 10));
          ctx.creditReserved = false;
        }
      },
    });

    this.steps.push({
      name: "REGULATORY_AML_CHECK",
      execute: async (ctx) => {
        await new Promise((r) => setTimeout(r, 15));
        ctx.kycValidated = true;
      },
      compensate: async (ctx) => {
        if (ctx.kycValidated) {
          ctx.kycValidated = false;
        }
      },
    });

    this.steps.push({
      name: "VALIDATE_BENEFICIARY_ROUTING",
      execute: async (ctx) => {
        await new Promise((r) => setTimeout(r, 10));
        if (ctx.bankAccount === "INVALID_ACCOUNT") {
          throw new Error("Beneficiary Account rejected: Invalid IFSC routing code");
        }
      },
      compensate: async () => {
        // Read-only step: no compensation required
      },
    });

    this.steps.push({
      name: "INTERBANK_FUNDS_DISBURSEMENT",
      execute: async (ctx) => {
        await new Promise((r) => setTimeout(r, 25));
        if (ctx.amount > 100000) {

          throw new Error("Interbank Gateway Error: Amount exceeds automated instant clearance limit ($100k)");
        }
        ctx.bankReferenceId = `BANK-TXN-${Date.now()}`;
      },
      compensate: async (ctx) => {
        if (ctx.bankReferenceId) {

          ctx.bankReferenceId = undefined;
        }
      },
    });

    this.steps.push({
      name: "POST_AUDIT_LEDGER",
      execute: async (ctx) => {
        ledger.recordTransaction(ctx.disbursementId, [
          { account: "LOAN_RECEIVABLES", debit: ctx.amount, credit: 0 },
          { account: "CASH_AT_BANK", debit: 0, credit: ctx.amount },
        ]);
        ctx.ledgerCommitted = true;
      },
      compensate: async (ctx) => {
        if (ctx.ledgerCommitted) {

          ledger.recordTransaction(`REV-${ctx.disbursementId}`, [
            { account: "CASH_AT_BANK", debit: ctx.amount, credit: 0 },
            { account: "LOAN_RECEIVABLES", debit: 0, credit: ctx.amount },
          ]);
          ctx.ledgerCommitted = false;
        }
      },
    });
  }

  async executeDisbursement(
    disbursementId: string,
    borrowerId: string,
    amount: number,
    bankAccount: string
  ): Promise<SagaResult> {
    const ctx: SagaContext = {
      disbursementId,
      borrowerId,
      amount,
      bankAccount,
      creditReserved: false,
      kycValidated: false,
      ledgerCommitted: false,
    };

    const completedSteps: string[] = [];
    const compensatedSteps: string[] = [];

    for (const step of this.steps) {
      try {
        await step.execute(ctx);
        completedSteps.push(step.name);
      } catch (err: any) {
        ctx.failureReason = err.message || "Unknown Step Failure";

        for (let i = completedSteps.length - 1; i >= 0; i--) {
          const stepNameToRollback = completedSteps[i];
          const rollbackStep = this.steps.find((s) => s.name === stepNameToRollback);
          if (rollbackStep) {
            try {
              await rollbackStep.compensate(ctx);
              compensatedSteps.push(stepNameToRollback);
            } catch (compErr) {
              console.error(`[Saga] Critical: Compensation failed for ${stepNameToRollback}:`, compErr);
            }
          }
        }

        outboxRelay.stageEvent("LoanDisbursement", disbursementId, "DISBURSEMENT_FAILED_COMPENSATED", {
          disbursementId,
          error: ctx.failureReason,
          compensatedSteps,
        });

        return {
          success: false,
          disbursementId,
          completedSteps,
          compensatedSteps,
          error: ctx.failureReason,
          context: ctx,
        };
      }
    }

    outboxRelay.stageEvent("LoanDisbursement", disbursementId, "DISBURSEMENT_SUCCESSFUL", {
      disbursementId,
      borrowerId,
      amount,
      bankReferenceId: ctx.bankReferenceId,
    });

    return {
      success: true,
      disbursementId,
      completedSteps,
      compensatedSteps: [],
      context: ctx,
    };
  }
}

export const sagaOrchestrator = new SagaOrchestrator();
