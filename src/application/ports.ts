import type { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../domain/messaging/inbox-message';
import type { OutboxMessage } from '../domain/messaging/outbox-message';
import type { Money } from '../domain/money/money';
import type { WagerTransaction, WagerTransactionKind } from '../domain/wagering/wager-transaction';
import type { Wallet } from '../domain/wallet/wallet';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface WalletRepository {
  /** lê a wallet com SELECT FOR UPDATE, travando a linha até o fim da transação */
  lockById(walletId: string): Promise<Wallet | undefined>;
  findById(walletId: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /** grava saldo e version novos, só se a version no banco ainda for a esperada */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(transactionId: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean>;
  insert(transaction: WagerTransaction): Promise<void>;
  /** grava o avanço do processamento, os campos que vieram do provedor não mudam */
  update(transaction: WagerTransaction): Promise<void>;
  /** ids das transações PENDING_REFERENCE com o backoff vencido, as mais atrasadas primeiro */
  findDuePendingReferences(now: Date, limit: number): Promise<string[]>;
  /** antecipa pra agora o próximo check de quem esperava por essa transação do provedor */
  wakeUpDependents(providerId: string, externalTransactionId: string, now: Date): Promise<void>;
}

export interface LedgerPageItem {
  entry: WalletLedgerEntry;
  sequence: bigint;
}

export interface LedgerSummary {
  balance: Money;
  entries: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /** lançamentos da wallet depois da sequence informada, em ordem */
  page(walletId: string, afterSequence: bigint | undefined, limit: number): Promise<LedgerPageItem[]>;
  /** saldo reconstruído somando créditos e subtraindo débitos, e quantidade de lançamentos */
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}

export interface OutboxRepository {
  add(messages: OutboxMessage[]): Promise<void>;
  /** pega os pendentes vencidos e trava as linhas, pulando as que outra instância já travou */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** grava tentativas, próxima tentativa e publicação */
  save(message: OutboxMessage): Promise<void>;
}

export type InboxRegistration = { registered: true } | { registered: false; payloadHash: string };

export interface InboxRepository {
  /** registra a mensagem como processada, se já existir não grava nada e devolve o hash do registro original */
  register(message: InboxMessage): Promise<InboxRegistration>;
}

export interface EventPublisher {
  /** lança EventPublishError quando o broker falha, qualquer outro erro é tratado como falha do processo */
  publish(message: OutboxMessage): Promise<void>;
}

export interface TransactionScope {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

export interface UnitOfWork {
  /** tudo dentro de uma transação SQL só: ou commita tudo junto ou nada */
  transactional<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
  /** leitura fora de transação explícita */
  read<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}
