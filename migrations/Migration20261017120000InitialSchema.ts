import { Migration } from '@mikro-orm/migrations';

// schema inicial: as garantias de unicidade, imutabilidade e não negatividade ficam aqui no banco
// entao essas garantias nao vao depender so do código. dinheiro é NUMERIC(19,2) com moeda CHAR(3), nunca float
export class Migration20261017120000InitialSchema extends Migration {
  override async up(): Promise<void> {
    // ---- wallets
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid          PRIMARY KEY,
        player_id   uuid          NOT NULL,
        currency    char(3)       NOT NULL,
        balance     numeric(19,2) NOT NULL,
        version     integer       NOT NULL,
        created_at  timestamptz   NOT NULL,
        updated_at  timestamptz   NOT NULL,
        CONSTRAINT wallets_player_currency_uk      UNIQUE (player_id, currency),
        -- alvo da FK composta do ledger (garante moeda do lançamento = moeda da wallet)
        CONSTRAINT wallets_id_currency_uk          UNIQUE (id, currency),
        CONSTRAINT wallets_balance_non_negative_ck CHECK (balance >= 0),
        CONSTRAINT wallets_currency_iso_ck         CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_version_ck              CHECK (version >= 1)
      )
    `);

    // ---- wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid          PRIMARY KEY,
        provider_id                       text          NOT NULL,
        external_transaction_id           text          NOT NULL,
        idempotency_key                   text          NOT NULL,
        payload_hash                      text          NOT NULL,
        wallet_id                         uuid          NOT NULL REFERENCES wallets (id),
        player_id                         uuid          NOT NULL,
        round_id                          text          NOT NULL,
        game_id                           text          NOT NULL,
        kind                              text          NOT NULL,
        amount                            numeric(19,2) NOT NULL,
        currency                          char(3)       NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid,
        status                            text          NOT NULL,
        failure_code                      text,
        -- saldo observado quando foi decidida, na moeda da wallet (devolvido no replay)
        balance_after                     numeric(19,2),
        reference_attempts                integer       NOT NULL DEFAULT 0,
        next_reference_check_at           timestamptz,
        processed_at                      timestamptz,
        created_at                        timestamptz   NOT NULL,
        updated_at                        timestamptz   NOT NULL,

        CONSTRAINT wager_tx_idempotency_key_uk   UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_provider_external_uk UNIQUE (provider_id, external_transaction_id),
        -- alvo das FKs compostas (referência e ledger na msm wallet)
        CONSTRAINT wager_tx_id_wallet_uk         UNIQUE (id, wallet_id),
        CONSTRAINT wager_tx_reference_same_wallet_fk
          FOREIGN KEY (reference_transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),

        CONSTRAINT wager_tx_kind_ck     CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_tx_status_ck   CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_tx_currency_iso_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_tx_not_blank_ck CHECK (
          provider_id <> '' AND external_transaction_id <> '' AND idempotency_key <> ''
          AND payload_hash <> '' AND round_id <> '' AND game_id <> ''
        ),
        CONSTRAINT wager_tx_amount_positive_ck CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
        CONSTRAINT wager_tx_balance_after_non_negative_ck CHECK (balance_after >= 0),
        CONSTRAINT wager_tx_reference_attempts_ck CHECK (reference_attempts >= 0),
        CONSTRAINT wager_tx_reference_required_ck CHECK (
          kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL
        ),
        CONSTRAINT wager_tx_reference_allowed_ck CHECK (
          reference_external_transaction_id IS NULL OR kind IN ('WIN', 'LOSS', 'REFUND', 'ROLLBACK')
        ),
        CONSTRAINT wager_tx_failure_code_ck CHECK (
          (status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)
        ),
        CONSTRAINT wager_tx_processed_ck CHECK (
          (status = 'PROCESSED') = (processed_at IS NOT NULL)
          AND (status <> 'PROCESSED' OR balance_after IS NOT NULL)
        ),
        CONSTRAINT wager_tx_pending_reference_ck CHECK (
          status <> 'PENDING_REFERENCE' OR next_reference_check_at IS NOT NULL
        )
      )
    `);

    // pelo README, uma referência não pode ser revertida duas vezes pelo mesmo tipo
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_one_reversal_per_kind_uk
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
    `);
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_one_opening_per_wallet_uk
        ON wager_transactions (wallet_id)
        WHERE kind = 'OPENING'
    `);
    // worker de PENDING_REFERENCE busca as vencidas, índice só tem as pendentes
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_due_ix
        ON wager_transactions (next_reference_check_at)
        WHERE status = 'PENDING_REFERENCE'
    `);
    // quando a referência chega, acha quem tava esperando por ela
    this.addSql(`
      CREATE INDEX wager_tx_waiting_for_reference_ix
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE'
    `);

    // ---- wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid          PRIMARY KEY,
        -- ordem estável pro cursor da paginação, não depende de relógio
        sequence        bigint        GENERATED ALWAYS AS IDENTITY,
        wallet_id       uuid          NOT NULL,
        transaction_id  uuid          NOT NULL,
        direction       text          NOT NULL,
        amount          numeric(19,2) NOT NULL,
        balance_before  numeric(19,2) NOT NULL,
        balance_after   numeric(19,2) NOT NULL,
        currency        char(3)       NOT NULL,
        created_at      timestamptz   NOT NULL,

        CONSTRAINT ledger_sequence_uk    UNIQUE (sequence),
        CONSTRAINT ledger_transaction_uk UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_transaction_fk
          FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT ledger_wallet_currency_fk
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT ledger_direction_ck CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT ledger_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT ledger_balances_non_negative_ck CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ledger_arithmetic_ck CHECK (
          balance_after = CASE direction
            WHEN 'CREDIT' THEN balance_before + amount
            ELSE balance_before - amount
          END
        )
      )
    `);
    // paginação do ledger por wallet e reconciliação
    this.addSql(`CREATE INDEX ledger_wallet_sequence_ix ON wallet_ledger_entries (wallet_id, sequence)`);

    // ---- imutabilidade garantida no ledger append-only
    //  transação nunca sai de estado terminal nem é apagada
    this.addSql(`
      CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries é append-only: % não permitido', TG_OP
          USING ERRCODE = 'restrict_violation';
      END
      $$
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation()
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation()
    `);

    this.addSql(`
      CREATE FUNCTION guard_wager_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions não pode ser apagada' USING ERRCODE = 'restrict_violation';
        END IF;
        -- terminal não muda mais nada
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'transação % em estado terminal %', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
        END IF;
        -- o que veio do provedor nunca muda, só o estado do processamento avança
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'campos de negócio da transação % são imutáveis', OLD.id USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION guard_wager_transaction()
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_no_truncate
        BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation()
    `);

    // ---- inbox com dedup persistente por consumer e messageId
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text        NOT NULL,
        message_id    text        NOT NULL,
        payload_hash  text        NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id)
      )
    `);

    // ---- outbox
    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid        PRIMARY KEY,
        -- ordem de inserção pra publicar na sequência em que os eventos aconteceram
        sequence        bigint      GENERATED ALWAYS AS IDENTITY,
        aggregate_id    uuid        NOT NULL,
        event_type      text        NOT NULL,
        payload         jsonb       NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer     NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at    timestamptz,
        CONSTRAINT outbox_sequence_uk UNIQUE (sequence),
        CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0)
      )
    `);
    // publisher só olha os pendentes, então o índice só guarda eles e fica pequeno
    this.addSql(`
      CREATE INDEX outbox_pending_ix
        ON outbox_messages (sequence)
        WHERE published_at IS NULL
    `);
  }

  override async down(): Promise<void> {
    // ordem inversa por causa das FKs. DROP TABLE não dispara trigger de DELETE/TRUNCATE
    this.addSql(`DROP TABLE IF EXISTS outbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions`);
    this.addSql(`DROP TABLE IF EXISTS wallets`);
    this.addSql(`DROP FUNCTION IF EXISTS guard_wager_transaction()`);
    this.addSql(`DROP FUNCTION IF EXISTS forbid_ledger_mutation()`);
  }
}
