import crypto from "crypto";

export type AccountType =
  | "LOAN_RECEIVABLES"
  | "CASH_AT_BANK"
  | "BORROWER_DISBURSEMENT"
  | "PROCESSING_FEES";

export interface LedgerEntry {
  id: string;
  transactionId: string;
  account: AccountType;
  debit: number;
  credit: number;
  timestamp: number;
  hash: string;
}

export class DoubleEntryLedger {
  private entries: LedgerEntry[] = [];
  private lastHash = "00000000000000000000000000000000";

  recordTransaction(
    transactionId: string,
    postings: Array<{ account: AccountType; debit: number; credit: number }>
  ): LedgerEntry[] {

    const totalDebits = postings.reduce((sum, p) => sum + p.debit, 0);
    const totalCredits = postings.reduce((sum, p) => sum + p.credit, 0);

    if (Math.abs(totalDebits - totalCredits) > 0.0001) {
      throw new Error(
        `Ledger Invariant Violation: Debits ($${totalDebits}) do not equal Credits ($${totalCredits}) for txn ${transactionId}`
      );
    }

    const recorded: LedgerEntry[] = [];
    const now = Date.now();

    for (const post of postings) {
      const entryId = crypto.randomUUID();
      const payload = `${entryId}:${transactionId}:${post.account}:${post.debit}:${post.credit}:${now}:${this.lastHash}`;
      const entryHash = crypto.createHash("sha256").update(payload).digest("hex");

      const entry: LedgerEntry = {
        id: entryId,
        transactionId,
        account: post.account,
        debit: post.debit,
        credit: post.credit,
        timestamp: now,
        hash: entryHash,
      };

      this.entries.push(entry);
      this.lastHash = entryHash;
      recorded.push(entry);
    }

    return recorded;
  }

  getAccountBalance(account: AccountType): number {
    let balance = 0;
    for (const entry of this.entries) {
      if (entry.account === account) {

        balance += entry.debit - entry.credit;
      }
    }
    return balance;
  }

  getTransactionHistory(transactionId: string): LedgerEntry[] {
    return this.entries.filter((e) => e.transactionId === transactionId);
  }

  getAllEntries(): LedgerEntry[] {
    return [...this.entries];
  }
}

export const ledger = new DoubleEntryLedger();
