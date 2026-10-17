import { describe, expect, it } from 'bun:test';
import { LedgerDirection, WalletLedgerEntry } from '../../../src/domain/ledger/wallet-ledger-entry';
import { InvalidTransactionStateError } from '../../../src/domain/shared/errors';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { type SettleWagerInput, WagerSettlement } from '../../../src/domain/wagering/wager-settlement';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { NOW, balanceFromLedger, nextId, openWallet, usd, wagerTx, brl } from './fixtures';

/** uma wallet e seu ledger em memória em env de teste */
function setup(initialBalance = '100.00') {
  const { wallet, entries } = openWallet(initialBalance);

  const settle = (tx: WagerTransaction, extra: Partial<SettleWagerInput> = {}) => {
    const result = WagerSettlement.settle({ transaction: tx, wallet, ledgerEntryId: nextId('entry'), now: NOW, ...extra });
    if (result.status === Status.Processed && result.ledgerEntry) entries.push(result.ledgerEntry);
    return result;
  };

  /** cria e aplica uma transação e devolve já decidida */
  const apply = (overrides: Partial<CreateWagerTransactionProps>, extra: Partial<SettleWagerInput> = {}) => {
    const tx = wagerTx(overrides);
    settle(tx, extra);
    return tx;
  };

  const assertLedgerConsistent = (w: Wallet = wallet, e: WalletLedgerEntry[] = entries) =>
    expect(balanceFromLedger(e).equals(w.balance)).toBe(true);

  return { wallet, entries, settle, apply, assertLedgerConsistent };
}

describe('WagerSettlement regras de negócio', () => {
  describe('BET', () => {
    it('debita o saldo e gera 1 lançamento DEBIT', () => {
      const { wallet, entries, apply, assertLedgerConsistent } = setup('100.00');
      const bet = apply({ kind: Kind.Bet, money: brl('25.00') });

      expect(bet.status).toBe(Status.Processed);
      expect(bet.balanceAfter?.amount).toBe('75.00');
      expect(wallet.balance.amount).toBe('75.00');
      expect(entries.at(-1)!.direction).toBe(LedgerDirection.Debit);
      assertLedgerConsistent();
    });

    it('saldo insuficiente REJECTED INSUFFICIENT_FUNDS, sem lançamento e sem mudar version', () => {
      const { wallet, entries, settle } = setup('10.00');
      const bet = wagerTx({ kind: Kind.Bet, money: brl('10.01') });
      const result = settle(bet);

      expect(result).toEqual({ status: Status.Rejected, failureCode: FailureCode.InsufficientFunds });
      expect(bet.balanceAfter?.amount).toBe('10.00');
      expect(entries).toHaveLength(1); // só a abertura
      expect(wallet.version).toBe(1);
    });

    it('cenário 100.00 com duas apostas de 80.00, uma PROCESSED, outra REJECTED resulta em saldo 20.00', () => {
      const { wallet, entries, apply, assertLedgerConsistent } = setup('100.00');
      const first = apply({ kind: Kind.Bet, money: brl('80.00') });
      const second = apply({ kind: Kind.Bet, money: brl('80.00') });

      expect(first.status).toBe(Status.Processed);
      expect(second.status).toBe(Status.Rejected);
      expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(wallet.balance.amount).toBe('20.00');
      expect(entries.filter((e) => e.direction === LedgerDirection.Debit)).toHaveLength(1);
      assertLedgerConsistent();
    });
  });

  describe('WIN', () => {
    it('credita sem referência', () => {
      const { wallet, apply, assertLedgerConsistent } = setup('100.00');
      apply({ kind: Kind.Win, money: brl('50.00') });
      expect(wallet.balance.amount).toBe('150.00');
      assertLedgerConsistent();
    });

    it('credita referenciando a BET da mesma rodada', () => {
      const { wallet, apply } = setup('100.00');
      const bet = apply({ kind: Kind.Bet, money: brl('10.00') });
      const win = apply(
        { kind: Kind.Win, money: brl('30.00'), referenceExternalTransactionId: bet.externalTransactionId },
        { reference: bet },
      );
      expect(win.status).toBe(Status.Processed);
      expect(win.referenceTransactionId).toBe(bet.id);
      expect(wallet.balance.amount).toBe('120.00');
    });

    it('referência de outra rodada usando REFERENCE_MISMATCH', () => {
      const { apply } = setup('100.00');
      const bet = apply({ kind: Kind.Bet, roundId: 'round-A' });
      const win = apply(
        { kind: Kind.Win, roundId: 'round-B', referenceExternalTransactionId: bet.externalTransactionId },
        { reference: bet },
      );
      expect(win.failureCode).toBe(FailureCode.ReferenceMismatch);
    });
  });

  describe('LOSS', () => {
    it('PROCESSED sem lançamento e sem mudar saldo nem version', () => {
      const { wallet, entries, settle } = setup('100.00');
      const loss = wagerTx({ kind: Kind.Loss, money: brl('0.00') });
      const result = settle(loss);

      expect(result).toEqual({ status: Status.Processed, ledgerEntry: undefined });
      expect(loss.balanceAfter?.amount).toBe('100.00');
      expect(wallet.version).toBe(1);
      expect(entries).toHaveLength(1);
    });
  });

  describe('REFUND', () => {
    it('reverte uma BET PROCESSED creditando o mesmo valor', () => {
      const { wallet, apply, assertLedgerConsistent } = setup('100.00');
      const bet = apply({ kind: Kind.Bet, money: brl('40.00') });
      const refund = apply(
        { kind: Kind.Refund, money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId },
        { reference: bet },
      );

      expect(refund.status).toBe(Status.Processed);
      expect(refund.referenceTransactionId).toBe(bet.id);
      expect(wallet.balance.amount).toBe('100.00');
      assertLedgerConsistent();
    });

    it('REFERENCE_KIND_NOT_ALLOWED', () => {
      const { apply } = setup('100.00');
      const win = apply({ kind: Kind.Win, money: brl('10.00') });
      const refund = apply(
        { kind: Kind.Refund, money: brl('10.00'), referenceExternalTransactionId: win.externalTransactionId },
        { reference: win },
      );
      expect(refund.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
    });

    it('valor diferente da referência chamando REFERENCE_AMOUNT_MISMATCH', () => {
      const { apply } = setup('100.00');
      const bet = apply({ kind: Kind.Bet, money: brl('40.00') });
      const refund = apply(
        { kind: Kind.Refund, money: brl('39.99'), referenceExternalTransactionId: bet.externalTransactionId },
        { reference: bet },
      );
      expect(refund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
    });

    it('referência já revertida chamando REFERENCE_ALREADY_REVERSED', () => {
      const { wallet, apply } = setup('100.00');
      const bet = apply({ kind: Kind.Bet, money: brl('40.00') });
      const refund = apply(
        { kind: Kind.Refund, money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId },
        { reference: bet, referenceAlreadyReversed: true },
      );
      expect(refund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
      expect(wallet.balance.amount).toBe('60.00');
    });

    it('BET rejeitada sem reembolso chamando REFERENCE_NOT_PROCESSED', () => {
      const { apply } = setup('10.00');
      const bet = apply({ kind: Kind.Bet, money: brl('40.00') });
      expect(bet.status).toBe(Status.Rejected);
      const refund = apply(
        { kind: Kind.Refund, money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId },
        { reference: bet },
      );
      expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    });
  });

  describe('ROLLBACK', () => {
    it('de acao BET credita', () => {
      const { wallet, apply, assertLedgerConsistent } = setup('100.00');
      const bet = apply({ kind: Kind.Bet, money: brl('30.00') });
      apply(
        { kind: Kind.Rollback, money: brl('30.00'), referenceExternalTransactionId: bet.externalTransactionId },
        { reference: bet },
      );
      expect(wallet.balance.amount).toBe('100.00');
      assertLedgerConsistent();
    });

    it('de acao WIN debita', () => {
      const { wallet, entries, apply, assertLedgerConsistent } = setup('100.00');
      const win = apply({ kind: Kind.Win, money: brl('50.00') });
      apply(
        { kind: Kind.Rollback, money: brl('50.00'), referenceExternalTransactionId: win.externalTransactionId },
        { reference: win },
      );
      expect(wallet.balance.amount).toBe('100.00');
      expect(entries.at(-1)!.direction).toBe(LedgerDirection.Debit);
      assertLedgerConsistent();
    });

    it('de REFUND debita, desfaz o reembolso', () => {
      const { wallet, apply, assertLedgerConsistent } = setup('100.00');
      const bet = apply({ kind: Kind.Bet, money: brl('40.00') });
      const refund = apply(
        { kind: Kind.Refund, money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId },
        { reference: bet },
      );
      const rollback = apply(
        { kind: Kind.Rollback, money: brl('40.00'), referenceExternalTransactionId: refund.externalTransactionId },
        { reference: refund },
      );

      expect(rollback.status).toBe(Status.Processed);
      expect(wallet.balance.amount).toBe('60.00');
      assertLedgerConsistent();
    });

    it('que deixaria saldo negativo, REVERSAL_WOULD_OVERDRAW', () => {
      const { wallet, apply } = setup('0.00');
      const win = apply({ kind: Kind.Win, money: brl('50.00') });
      apply({ kind: Kind.Bet, money: brl('45.00') }); // saldo 5.00
      const rollback = apply(
        { kind: Kind.Rollback, money: brl('50.00'), referenceExternalTransactionId: win.externalTransactionId },
        { reference: win },
      );

      expect(rollback.status).toBe(Status.Rejected);
      expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
      expect(wallet.balance.amount).toBe('5.00');
    });
  });

  describe('referência fora de ordem', () => {
    it('referência ausente: PENDING_REFERENCE; depois PROCESSED quando chega', () => {
      const { wallet, settle, apply, assertLedgerConsistent } = setup('100.00');
      const refund = wagerTx({ kind: Kind.Refund, money: brl('20.00'), referenceExternalTransactionId: 'bet-late' });

      expect(settle(refund)).toEqual({ status: Status.PendingReference });
      expect(refund.referenceAttempts).toBe(1);
      expect(wallet.balance.amount).toBe('100.00');

      const bet = apply({ kind: Kind.Bet, money: brl('20.00'), externalTransactionId: 'bet-late' });
      expect(settle(refund, { reference: bet }).status).toBe(Status.Processed);
      expect(wallet.balance.amount).toBe('100.00');
      assertLedgerConsistent();
    });

    it('referência existente mas ainda não decidida fica aguardando', () => {
      const { settle } = setup('100.00');
      const pendingWin = wagerTx({ kind: Kind.Win, referenceExternalTransactionId: 'missing' });
      settle(pendingWin);
      const rollback = wagerTx({
        kind: Kind.Rollback,
        money: pendingWin.money,
        referenceExternalTransactionId: pendingWin.externalTransactionId,
      });
      expect(settle(rollback, { reference: pendingWin }).status).toBe(Status.PendingReference);
    });
  });

  describe('consistência com a wallet', () => {
    it('moeda diferente da wallet chamando REJECTED CURRENCY_MISMATCH', () => {
      const { wallet, apply } = setup('100.00');
      const bet = apply({ kind: Kind.Bet, money: usd('10.00') });
      expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
      expect(wallet.balance.amount).toBe('100.00');
    });

    it('player diferente do dono da wallet chanmadno REJECTED WALLET_PLAYER_MISMATCH', () => {
      const { apply } = setup('100.00');
      expect(apply({ kind: Kind.Bet, playerId: 'outro' }).failureCode).toBe(FailureCode.WalletPlayerMismatch);
    });
  });

  it('reaplicar transação já decidida lança sem duplicar debito', () => {
    const { wallet, settle } = setup('100.00');
    const bet = wagerTx({ kind: Kind.Bet, money: brl('10.00') });
    settle(bet);
    expect(() => settle(bet)).toThrow(InvalidTransactionStateError);
    expect(wallet.balance.amount).toBe('90.00');
  });
});
