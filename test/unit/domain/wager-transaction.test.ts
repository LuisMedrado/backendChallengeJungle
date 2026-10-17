import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/wallet-ledger-entry';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../../src/domain/shared/errors';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { REFERENCE_MAX_ATTEMPTS } from '../../../src/domain/wagering/reference-retry-policy';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wagering/wager-transaction';
import { NOW, brl, wagerTx } from './fixtures';

describe('WagerTransaction', () => {
  describe('create', () => {
    it('nasce PENDING', () => {
      const tx = wagerTx();
      expect(tx.status).toBe(Status.Pending);
      expect(tx.isTerminal()).toBe(false);
    });

    it('OPENING não pode ser submetido', () => {
      expect(() => wagerTx({ kind: Kind.Opening })).toThrow(InvalidWagerTransactionError);
    });

    it.each([Kind.Refund, Kind.Rollback])('%s exige referência', (kind) => {
      expect(() => wagerTx({ kind })).toThrow(InvalidWagerTransactionError);
      expect(() => wagerTx({ kind, referenceExternalTransactionId: '' })).toThrow(InvalidWagerTransactionError);
    });

    it('BET não aceita referência', () => {
      expect(() => wagerTx({ kind: Kind.Bet, referenceExternalTransactionId: 'x' })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it('WIN e LOSS aceitam referência opcional', () => {
      expect(wagerTx({ kind: Kind.Win, referenceExternalTransactionId: 'bet-1' }).status).toBe(Status.Pending);
      expect(wagerTx({ kind: Kind.Loss }).status).toBe(Status.Pending);
    });

    it('não pode referenciar a si mesma', () => {
      expect(() =>
        wagerTx({ kind: Kind.Refund, externalTransactionId: 'a', referenceExternalTransactionId: 'a' }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('valor zero só é aceito em LOSS', () => {
      expect(() => wagerTx({ kind: Kind.Bet, money: brl('0.00') })).toThrow(InvalidWagerTransactionError);
      expect(wagerTx({ kind: Kind.Loss, money: brl('0.00') }).status).toBe(Status.Pending);
    });

    it('campos obrigatórios vazios são rejeitados', () => {
      expect(() => wagerTx({ roundId: '  ' })).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('createOpening', () => {
    it('nasce PROCESSED com saldo observado', () => {
      const tx = WagerTransaction.createOpening({
        id: 'tx',
        walletId: 'w',
        playerId: 'p',
        money: brl('1000.00'),
        createdAt: NOW,
      });
      expect(tx.kind).toBe(Kind.Opening);
      expect(tx.status).toBe(Status.Processed);
      expect(tx.balanceAfter?.amount).toBe('1000.00');
    });
  });

  describe('transições', () => {
    it('PENDING vira PROCESSED', () => {
      const tx = wagerTx();
      tx.markProcessed(undefined, NOW, brl('90.00'));
      expect(tx.status).toBe(Status.Processed);
      expect(tx.processedAt).toEqual(NOW);
      expect(tx.balanceAfter?.amount).toBe('90.00');
    });

    it('PENDING vai pra REJECTED e guarda failureCode', () => {
      const tx = wagerTx();
      tx.reject(FailureCode.InsufficientFunds, brl('5.00'));
      expect(tx.status).toBe(Status.Rejected);
      expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    });

    it('PENDING -> FAILED', () => {
      const tx = wagerTx();
      tx.fail(FailureCode.PermanentProcessingFailure);
      expect(tx.status).toBe(Status.Failed);
    });

    it.each([
      ['PROCESSED', (tx: WagerTransaction) => tx.markProcessed(undefined, NOW, brl('1.00'))],
      ['REJECTED', (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds)],
      ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.PermanentProcessingFailure)],
    ])('estado terminal %s não aceita nenhuma transição', (_, toTerminal) => {
      const tx = wagerTx({ kind: Kind.Win, referenceExternalTransactionId: 'bet' });
      toTerminal(tx);
      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.markProcessed(undefined, NOW, brl('1.00'))).toThrow(InvalidTransactionStateError);
      expect(() => tx.markPendingReference(NOW)).toThrow(InvalidTransactionStateError);
      expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(FailureCode.PermanentProcessingFailure)).toThrow(InvalidTransactionStateError);
    });

    it('PENDING_REFERENCE acumula tentativas com backoff', () => {
      const tx = wagerTx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet' });
      tx.markPendingReference(NOW);
      expect(tx.status).toBe(Status.PendingReference);
      expect(tx.referenceAttempts).toBe(1);
      expect(tx.nextReferenceCheckAt!.getTime() - NOW.getTime()).toBe(2_000);

      tx.markPendingReference(NOW);
      expect(tx.referenceAttempts).toBe(2);
      expect(tx.nextReferenceCheckAt!.getTime() - NOW.getTime()).toBe(4_000);
    });

    it('esgota tentativas após o limite', () => {
      const tx = wagerTx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet' });
      for (let i = 0; i < REFERENCE_MAX_ATTEMPTS; i++) tx.markPendingReference(NOW);
      expect(tx.hasExhaustedReferenceAttempts()).toBe(true);
      tx.reject(FailureCode.ReferenceNotFound);
      expect(tx.status).toBe(Status.Rejected);
      expect(tx.nextReferenceCheckAt).toBeUndefined();
    });

    it('PENDING_REFERENCE vira PROCESSED quando a referência chega', () => {
      const tx = wagerTx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet' });
      tx.markPendingReference(NOW);
      tx.markProcessed('tx-bet', NOW, brl('100.00'));
      expect(tx.status).toBe(Status.Processed);
      expect(tx.referenceTransactionId).toBe('tx-bet');
    });
  });

  describe('consultas', () => {
    it('affectsBalance é false só para LOSS', () => {
      expect(wagerTx({ kind: Kind.Loss }).affectsBalance()).toBe(false);
      expect(wagerTx({ kind: Kind.Bet }).affectsBalance()).toBe(true);
    });

    it('matchesPayload distingue replay de conflito', () => {
      const tx = wagerTx({ payloadHash: 'abc' });
      expect(tx.matchesPayload('abc')).toBe(true);
      expect(tx.matchesPayload('outro')).toBe(false);
    });

    describe('ledgerDirectionFor', () => {
      const bet = wagerTx({ kind: Kind.Bet });
      const win = wagerTx({ kind: Kind.Win });
      const refund = wagerTx({ kind: Kind.Refund, referenceExternalTransactionId: 'b' });
      const rollback = wagerTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });

      it('BET debita, WIN e REFUND creditam', () => {
        expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
        expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
        expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      });

      it('ROLLBACK inverte a referência', () => {
        expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
        expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
        expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
      });

      it('ROLLBACK sem referência e LOSS lançam', () => {
        expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
        expect(() => wagerTx({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
      });
    });

    it('canReference segue a tabela de tipos', () => {
      const bet = wagerTx({ kind: Kind.Bet });
      const win = wagerTx({ kind: Kind.Win });
      const refund = wagerTx({ kind: Kind.Refund, referenceExternalTransactionId: 'b' });
      const rollback = wagerTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });

      expect(refund.canReference(bet)).toBe(true);
      expect(refund.canReference(win)).toBe(false);
      expect(rollback.canReference(bet)).toBe(true);
      expect(rollback.canReference(win)).toBe(true);
      expect(rollback.canReference(refund)).toBe(true);
      expect(rollback.canReference(rollback)).toBe(false);
    });
  });
});
