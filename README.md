# Wagering Processor

> Serviço que aplica operações de aposta (BET, WIN, LOSS, REFUND, ROLLBACK) nas wallets dos jogadores exatamente uma vez, mesmo com mensagens duplicadas, fora de ordem ou processadas por várias instâncias ao mesmo tempo.

## Visão geral

Provedores de jogos mandam operações ligadas a uma rodada. A entrega é at-least-once: a mesma operação pode chegar mais de uma vez, um REFUND pode chegar antes da BET que ele estorna e várias instâncias podem mexer na mesma wallet ao mesmo tempo. Este serviço recebe essas operações, aplica no saldo e registra tudo num ledger que não pode ser alterado.

O projeto é a resposta ao desafio técnico de backend da Jungle Gaming. O enunciado avalia correção financeira, concorrência, idempotência e recuperação de falhas, então a prioridade foi essa e não volume de endpoints.

A regra que guia o desenho: **o PostgreSQL é a fonte da verdade.** Ordenação e deduplicação da fila ajudam, mas não garantem nada. Unicidade, saldo nunca negativo e imutabilidade do ledger estão em constraints e triggers do banco, não só no código.

As decisões, trade-offs e limitações estão no [ARCHITECTURE.md](ARCHITECTURE.md).

## Status

| Parte | Situação |
|---|---|
| Ambiente local (Postgres + LocalStack/SQS) | pronto |
| Domínio (Money, Wallet, ledger, regras de aposta) | pronto, com testes unitários |
| Schema, migrations e constraints | pronto, com testes de integração |
| API HTTP e use cases | pronto, com testes e2e (inclusive concorrência real) |
| Outbox publisher | pronto, com testes de integração (publishers concorrentes e crash antes do commit) |
| Consumer SQS com inbox, retry e DLQ | pronto, com testes de integração (redelivery, crash antes do ack, SIGTERM) |
| Worker de referências pendentes | pronto, com testes de integração (backoff, limite de tentativas, workers concorrentes) |
| Testes com três processos simultâneos e reinício | pronto |
| Logs estruturados em JSON e métricas Prometheus | pronto, com testes de integração |
| Autenticação | não implementada de propósito, com ponto de extensão no código. Desenho no ARCHITECTURE.md, seção 8 |

## Arquitetura

```
HTTP ─┐                                ┌──────────── uma transação SQL ────────────┐
      ├─► ProcessWagerTransaction ─────┤ inbox · transação · wallet · ledger · outbox │
SQS ──┘   (use case único)             └────────────────────────────────────────────┘
                                                  │                         │
                                        outbox publisher          worker de PENDING_REFERENCE
```

O código segue camadas com dependência sempre para dentro:

- **`domain`**: regras de negócio puras, sem NestJS nem ORM. `Money` em centavos (`bigint`), `Wallet` como aggregate root, `WalletLedgerEntry` imutável, `WagerTransaction` com máquina de estados e `WagerSettlement` aplicando as regras de cada tipo de operação.
- **`application`**: use cases e portas (interfaces de repositório, relógio, gerador de id). Também calcula o `payloadHash` usado na idempotência.
- **`infrastructure`**: implementação das portas com MikroORM e SQL.
- **`interfaces`**: controllers HTTP e o consumer SQS, as duas portas de entrada que chamam os msmos use cases.

A concorrência é controlada por wallet: cada operação trava a linha da wallet (`SELECT ... FOR UPDATE`) antes de mexer no saldo. Operações da mesma wallet entram em fila, wallets diferentes rodam em paralelo.

## Primeiros passos

### Pré-requisitos

- [Bun](https://bun.sh) 1.x (desenvolvido com 1.4.3)
- Docker com Docker Compose (no Windows, Docker Desktop com WSL2)

O Node não é necessário: o Bun roda o TypeScript direto e também é o gerenciador de pacotes e o test runner.

### Instalação

```bash
bun install
```
```bash
cp .env.example .env
```
```bash
bun run infra:up
```
```bash
bun run db:migrate
```

O `infra:up` sobe Postgres 17 e LocalStack 4.4 e só termina quando os dois estão saudáveis: o banco aceitando conexão e as filas SQS criadas. O banco `wagering_test`, usado pelos testes de integração, é criado na primeira subida do volume.

### Configuração

Tudo vem do `.env` (copiado do `.env.example`):

| Variável | Pra que serve |
|---|---|
| `PORT` | porta da API (padrão 3000) |
| `DATABASE_URL` | banco de desenvolvimento |
| `DATABASE_URL_TEST` | banco dos testes de integração |
| `AWS_REGION`, `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | acesso ao SQS do LocalStack (credenciais `test`/`test`) |
| `SQS_QUEUE_URL`, `SQS_DLQ_URL` | fila de entrada e DLQ |
| `SQS_EVENTS_QUEUE_URL` | fila de saída onde a outbox publica os eventos |
| `OUTBOX_PUBLISHER_ENABLED`, `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE` | liga o publisher da outbox, intervalo entre ciclos e tamanho do lote |
| `SQS_CONSUMER_ENABLED`, `SQS_WAIT_TIME_SECONDS`, `SQS_RETRY_BASE_DELAY_SECONDS`, `SQS_RETRY_MAX_DELAY_SECONDS` | liga o consumer da fila de entrada, long polling e backoff de erro transitório |
| `PENDING_REFERENCE_WORKER_ENABLED`, `PENDING_REFERENCE_POLL_INTERVAL_MS`, `PENDING_REFERENCE_BATCH_SIZE` | liga o worker que reprocessa operações que chegaram antes da referência |
| `DB_LOCK_TIMEOUT_MS` | quanto uma operação espera o lock da wallet antes de desistir com 503 (padrão 5000) |

As portas do Postgres (5432) e do LocalStack (4566) ficam publicadas só em `127.0.0.1`.

> **Portas em uso:** o projeto precisa das portas 5432, 4566 e 3000 livres. Os testes pegam portas livres sozinhos, então não entram nessa conta. Se já tiver um Postgres local rodando, o `infra:up` falha ao publicar a 5432. Pare o serviço que ocupa a porta antes de subir. Pra mudar a porta da API, ajuste o `PORT` no `.env`.

## Uso

```bash
bun run dev
```

Sobe a API com reload automático. Para conferir se está no ar:

```bash
curl http://localhost:3000/health/live
```

### Endpoints

| Método e rota | O que faz |
|---|---|
| `POST /wallets` | cria wallet (saldo inicial > 0 gera um lançamento de abertura) |
| `GET /wallets/:walletId` | saldo e version |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | lançamentos, paginados por cursor |
| `POST /wallets/:walletId/reconciliation` | compara o saldo com a soma do ledger |
| `POST /wagering/transactions` | submete uma operação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | consulta pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET /health/live`, `GET /health/ready` | liveness e readiness, sem autenticação |
| `GET /metrics` | métricas no formato do Prometheus, sem autenticação |

Exemplo, criando uma wallet e apostando 25.00:

```bash
curl -X POST http://localhost:3000/wallets -H "content-type: application/json" -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```
```bash
curl -X POST http://localhost:3000/wagering/transactions -H "content-type: application/json" -H "Idempotency-Key: provider-a:transaction-123" -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

A resposta traz `"status":"PROCESSED"` e saldo `975.00`. Mandar a mesma requisição de novo devolve o mesmo resultado
com `"idempotentReplay":true`, sem debitar outra vez. Os status HTTP de cada situação (200, 202, 400, 404, 409, 422,
503) estão explicados no [ARCHITECTURE.md](ARCHITECTURE.md).

Outros comandos:

| Comando | O que faz |
|---|---|
| `bun run start` | sobe a API sem watch |
| `bun run db:migrate` | aplica as migrations pendentes |
| `bun run db:rollback` | desfaz a última migration (`bun scripts/migrate.ts down --all` desfaz todas) |
| `bun run infra:logs` | acompanha os logs dos containers |
| `bun run infra:down` | derruba os containers e apaga os volumes |

## Observabilidade

**Logs.** Saem em JSON, uma linha por entrada, prontos pra qualquer agregador. Cada requisição HTTP e cada mensagem da fila gera uma linha com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, além de status e duração. O `x-correlation-id` de quem chama é respeitado e devolvido na resposta. Se não vier, é gerado. Valores de dinheiro e payloads nunca vão pro log, e o logger ainda redige esses campos se algum escapar.

**Métricas.** Em `GET /metrics`, no formato do Prometheus:

```bash
curl http://localhost:3000/metrics
```

| Métrica | O que mostra |
|---|---|
| `wagering_transactions_total` | transações por canal, kind e status |
| `wagering_duplicates_total` | replays pela idempotency key e mensagens repetidas barradas pela inbox |
| `wagering_retries_total` | novas tentativas do consumer, da outbox e das referências pendentes |
| `wagering_dead_letters_total`, `wagering_dlq_depth` | mensagens enviadas pra DLQ e quantas estão paradas lá |
| `wagering_lock_conflicts_total` | lock timeout, deadlock, version que mudou e corrida de idempotência |
| `wagering_outbox_pending`, `wagering_outbox_lag_seconds` | eventos esperando publicação e há quanto tempo o mais velho espera |
| `wagering_processing_duration_seconds` | latência do processamento, do recebimento ao commit |
| `wagering_reconciliation_divergences_total` | reconciliações em que o saldo não bateu com o ledger |

Os detalhes de cada uma estão no [ARCHITECTURE.md](ARCHITECTURE.md), seção 7.

## Estrutura do projeto

```
├── docker/
│   ├── localstack/init-sqs.sh   # cria a fila de entrada com DLQ e a fila de eventos
│   └── postgres/init.sql        # cria o banco de testes
├── migrations/                  # migrations com up e down, em SQL escrito à mão
├── scripts/migrate.ts           # aplica ou desfaz migrations
├── src/
│   ├── domain/                  # regras de negócio puras
│   ├── application/             # use cases, portas e payloadHash
│   ├── infrastructure/          # MikroORM, SQS, workers, logger JSON e métricas
│   ├── interfaces/http/         # controllers, log por requisição e /metrics
│   ├── interfaces/sqs/          # consumer da fila de entrada
│   ├── app.module.ts
│   └── main.ts
├── test/
│   ├── unit/                    # domínio, sem banco nem fila
│   ├── integration/             # Postgres e SQS reais em container
│   └── concurrency/             # três processos da aplicação ao msm tempo
└── docker-compose.yml
```

## Componentes principais

### Money (`src/domain/money/money.ts`)

Guarda o valor em centavos num `bigint`, então não existe erro de ponto flutuante. Na entrada exige string com exatamente duas casas (`"25.00"`) e recusa notação científica, `NaN`, `Infinity`, sinal e mais de duas casas. É imutável: toda operação devolve uma instância nova, e misturar moedas lança erro.

### Wallet e ledger (`src/domain/wallet`, `src/domain/ledger`)

O saldo só muda por `debit` e `credit`, e os dois devolvem o lançamento do ledger correspondente. O lançamento confere a própria conta (`saldo antes ± valor = saldo depois`) antes de a wallet mudar, e se a conta não fecha nada é alterado. Por isso os dois nunca discordam.

### Regras de aposta (`src/domain/wagering`)

`WagerSettlement` aplica as regras de cada tipo:

- **BET** debita, e sem saldo é rejeitada com `INSUFFICIENT_FUNDS`.
- **WIN** credita.
- **LOSS** registra o resultado sem mexer no saldo.
- **REFUND** e **ROLLBACK** revertem uma operação anterior.

Se a operação referenciada ainda não chegou, a transação fica `PENDING_REFERENCE` e é tentada de novo com backoff exponencial. A lista completa de códigos de falha está no ARCHITECTURE.md.

### Schema (`migrations/`)

A migration inicial cria wallets, transações, ledger, inbox e outbox. Alguns exemplos do que o banco garante sozinho:

- uma wallet por jogador e moeda;
- saldo nunca negativo;
- idempotency key única;
- referência sempre da mesma wallet, via FK composta;
- uma reversão processada por tipo de operação;
- ledger append-only (trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE`).

## Desenvolvimento

### Testes

```bash
bun test
```
```bash
bun run test:unit
```
```bash
bun run test:integration
```
```bash
bun run test:concurrency
```

Os testes de integração e de concorrência usam Postgres e SQS de verdade, então precisam do `bun run infra:up` antes. Cada arquivo começa recriando o schema (migration down e depois up) no banco `wagering_test`.

O `test:concurrency` sobe três processos da aplicação em portas livres escolhidas na hora e testa os três ao mesmo tempo: disputa de saldo, a mesma aposta enviada dezenas de vezes, três consumers na mesma fila e uma instância morta no meio da carga e reiniciada. A suíte inteira leva perto de 2 minutos. Para feedback rápido, use `test:unit`.

### Teste de carga

```bash
bun run test:load
```

Sobe três instâncias e mede três cenários: carga espalhada em várias wallets, tudo numa wallet só e mensagens pela fila. Zera o `wagering_test`, então não roda junto com a suíte. O resultado e a análise estão no [LOAD_TEST.md](LOAD_TEST.md).

Toda suíte que mexe em saldo termina conferindo que o saldo de **todas** as wallets do banco bate com o ledger.

Desde a fase do schema, o teste vem antes do código. Escreve, vê falhar, só depois implementa.

Os testes de schema tentam quebrar cada garantia direto por SQL e conferem o código de erro e o nome da constraint violada. Assim um teste não passa por causa de outra regra.

### Checagem de tipos

```bash
bun run typecheck
```

O TypeScript roda em modo estrito, com `noUncheckedIndexedAccess` e `verbatimModuleSyntax` ligados.
