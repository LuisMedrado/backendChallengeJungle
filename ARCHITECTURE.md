# ARCHITECTURE do Distributed Wagering Processor

## [INDICE]

1. [Overview](#1-visão-geral)
2. [Stack](#2-stack-e-ambiente-local)
3. [Mensageria](#3-mensageria-sqs)
4. [Modelo de domínio](#4-modelo-de-domínio)
5. [Persistência e schema](#5-persistência-e-schema)
6. [Processamento e API](#6-processamento-e-api)
7. [Códigos de falha](#7-códigos-de-falha)
8. [Interpretações das regras](#8-interpretações-das-regras)
9. [Testes](#9-testes)
10. [Limitações](#10-limitações-conhecidas)
11. [O que eu faria com mais tempo](#11-o-que-eu-faria-com-mais-tempo)

---

## 1. Visão geral

Serviço que recebe operações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) por HTTP e SQS,
aplica cada uma exatamente uma vez sobre a wallet do jogador e publica eventos de integração.

Parte do princípio que o banco domina a verdade sobre os estados. Recursos do broker (FIFO, deduplicação por exemplo) são otimização,
as garantias de unicidade, imutabilidade e não negatividade ficam em constraints do banco.

---

## 2. Stack e ambiente local

| Item | Escolha | Motivo |
|---|---|---|
| Runtime / pacotes / testes | Bun 1.x | Exigido no projeto, executa TypeScript e carrega as deps. |
| Framework | NestJS 11 | Exigido no projeto, DI e hooks (como o `enableShutdownHooks`) usados no shutdown. |
| Banco | PostgreSQL 17 | Exigido no projeto, Versão estável atual. |
| Mensageria | LocalStack 4.4 (SQS) | Exigido (LocalStack ou MiniStack). Tem limitações, descritas na seção 10. |
| Orquestração | Docker Compose | Exigido no projeto. |

### Decisões

- **LocalStack fixado em `4.4`.** As versões mais recentes da imagem passaram a exigir conta/token de autenticação.
  A `4.4` funciona sem credenciais, o que mantém o `docker compose up` reproduzível.
- **Healthchecks no Compose.** `docker compose up --wait` só retorna quando o Postgres aceita conexões
  (`pg_isready`) e a fila principal já existe. Isso evita testes rodando contra infraestrutura pela metade.
- **Banco de testes separado (`wagering_test`).** Criado pelo `docker/postgres/init.sql` na primeira inicialização
  do volume. Testes de integração e concorrência não interferem no banco de desenvolvimento.
- **TypeScript estrito.** Além de `strict`, foram ligados:
  - `noUncheckedIndexedAccess`: acesso por índice retorna `T | undefined`, o que obriga a tratar listas vazias;
  - `noImplicitOverride`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`;
  - `verbatimModuleSyntax`: imports usados só como tipo precisam de `import type`, o que deixa explícito o que existe
    em runtime. Classes injetadas pelo NestJS continuam com import de valor (a DI depende da metadata em runtime).
- **Portas só em `127.0.0.1`.** Postgres e LocalStack usam credenciais fixas de desenvolvimento; publicar as portas
  apenas em localhost evita expô-los na rede local.
- **Boot fail-fast.** Falha ao iniciar (porta ocupada, config inválida) encerra o processo com código ≠ 0 em vez de
  virar uma rejeição de Promise não tratada.
- **Line endings.** `.gitattributes` força LF em `*.sh` e `*.sql`. Os scripts rodam dentro de containers Linux
  via bind mount, e com CRLF o bash falha com command not found.

---

## 3. Mensageria (SQS)

As duas primeiras filas têm os nomes definidos no enunciado. A terceira é a saída dos eventos, que o enunciado não
nomeia (ver seção 8):

| Fila | Configuração |
|---|---|
| `wager-transactions.fifo` | FIFO, `ContentBasedDeduplication=false`, `VisibilityTimeout=30`, `RedrivePolicy` → DLQ com `maxReceiveCount=5` |
| `wager-transactions-dlq.fifo` | FIFO |
| `wager-events.fifo` | FIFO, `ContentBasedDeduplication=false`. Recebe os eventos de integração publicados pela outbox |

- **`ContentBasedDeduplication=false`**: o produtor informa `MessageDeduplicationId` explicitamente, evitando
  que dois payloads idênticos com significados distintos sejam descartados pelo broker.
- **`maxReceiveCount=5`**: limite de tentativas antes da DLQ (seção 10 do enunciado). A DLQ é criada antes da fila
  principal porque a `RedrivePolicy` referencia o ARN dela.
- **`VisibilityTimeout=30`**: tempo para processar uma mensagem antes que ela volte a ficar visível.
  _[a revisar]_ ajustar conforme a latência medida do processamento.
- **FIFO não é garantia de consistência.** O `MessageGroupId` (planejado: `walletId`) reduz contenção, mas
  a correção depende do lock no banco e da inbox persistente.

### Transactional outbox

Os eventos são gravados na tabela `outbox_messages` na msm transação SQL da operação (seção 6). Um worker, o
`OutboxPublisherWorker`, publica eles depois do commit. Nenhum evento sai antes do commit, pq até o commit ele nem
existe pra quem está fora da transação.

**Como um lote é publicado** (`PublishOutboxBatch`):

1. Abre uma transação e pega até `OUTBOX_BATCH_SIZE` eventos pendentes e vencidos com
   `SELECT ... FOR UPDATE SKIP LOCKED`, na ordem de `sequence`.
2. Publica cada um no `wager-events.fifo` e marca `published_at`.
3. Commit.

**Várias instâncias ao msm tempo.** Toda instância roda o worker. O `SKIP LOCKED` faz cada uma pular as linhas que
outra já travou, então duas instâncias nunca publicam o msm evento ao msm tempo e ninguém fica esperando ninguém.
O teste roda dois publishers com pools separados sobre 60 eventos: cada evento sai exatamente uma vez e as duas
instâncias trabalham.

**O processo morre no meio.** O lock das linhas é da transação. Se o processo morre antes do commit, o Postgres faz
rollback, as linhas destravam e outra instância publica. Nada se perde.

**Publicação duplicada: at-least-once, de propósito.** Um evento pode ser publicado mais de uma vez. Acontece quando
o processo publica no SQS e morre **antes** do commit que marca o evento como publicado. No rollback o evento volta
pra pendente, e outra instância publica de novo.

Isso é uma escolha, não um descuido. Entre o banco e o broker não existe "exatamente uma vez": são dois sistemas sem
transação em comum, então sempre tem um instante entre "publiquei" e "registrei que publiquei" em que o processo pode
morrer. Sobram duas opções:

| Garantia | O que acontece no crash | Consequência |
|---|---|---|
| at-most-once: marca como publicado antes de publicar | o evento pode **nunca** sair | perde evento confirmado, o que o enunciado proíbe |
| **at-least-once: publica e depois marca** | o evento pode sair **duas vezes** | nada se perde, e o duplicado é tratável |

Perder evento não tem conserto depois. Duplicado tem, desde que dê pra reconhecer. Por isso a outbox é at-least-once
e cada evento é feito pra ser reconhecível:

- **`eventId` estável.** O id é gerado uma vez, quando o evento é gravado na outbox, e é o msm em toda republicação.
  O consumidor guarda os `eventId` já tratados e ignora o que repetir. É o msm padrão da inbox que este serviço usa
  pra mensagens que recebe, deduplicando por `(consumer, messageId)`.
- **`MessageDeduplicationId = eventId`.** Dentro da janela de 5 min do SQS FIFO, o próprio broker descarta a cópia e o
  consumidor nem vê. Fora da janela, quem segura é o consumidor.
- **Eventos descrevem fatos, não comandos.** `WalletBalanceChanged` diz o saldo antes e depois e a `walletVersion`, não
  "some X". Aplicar o msm fato duas vezes não muda o resultado pra quem usa esses campos.

O enunciado pede exatamente isso: "uma publicação duplicada continua segura para o consumidor". O teste simula o
caso: a instância A publica e "morre" antes do commit, a instância B publica de novo, e as duas publicações saem com o
msm `eventId`.

**Broker fora do ar.** Na primeira falha de publicação o lote para. O evento que falhou ganha `attempts + 1` e
`next_attempt_at` com backoff (1s, 2s, 4s... até 60s), e os outros voltam pra fila sem tentativa contada. Sem isso,
com o SQS fora, um lote de 50 seguraria a transação por até 50 timeouts de 5s tentando um broker que já se sabe que
está fora. Não tem limite de tentativas: evento confirmado nunca é descartado, e um evento travado aparece no
outbox lag.

**Erro inesperado** que não é falha do broker derruba o lote inteiro com rollback. O worker loga e tenta de novo no
próximo ciclo, sem parar o loop.

**Shutdown.** O worker para no `onModuleDestroy`, que o Nest chama antes do `onApplicationShutdown` onde o pool do
banco fecha. O `stop()` espera o lote em andamento terminar, então o shutdown não corta uma publicação no meio.

| Variável | Padrão | Pra que serve |
|---|---|---|
| `OUTBOX_PUBLISHER_ENABLED` | `true` | liga o worker na instância |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | espera entre ciclos quando não tem nada pra publicar. Lote cheio emenda o próximo direto |
| `OUTBOX_BATCH_SIZE` | `50` | eventos por transação |

### Consumer da fila de entrada

O `SqsWagerConsumer` lê o `wager-transactions.fifo` e entrega cada mensagem pro `WagerMessageHandler`, que chama o
**msm `ProcessWagerTransaction` do HTTP**. Não tem regra de negócio duplicada: a fila é só outra porta de entrada.

**Inbox na msm transação.** A entrada pela fila passa um registro de inbox pro use case, que grava
`(consumer_name, message_id)` como **primeiro passo da transação SQL**, antes do lock da wallet. O insert usa
`ON CONFLICT DO NOTHING`:

- inseriu: segue normal e o registro da inbox commita junto com a transação, o saldo, o ledger e a outbox;
- já existia: é a msm mensagem chegando de novo, o use case para ali sem tocar em nada e o consumer faz ack;
- deu erro depois: o rollback desfaz a inbox também, então a redelivery processa como se fosse a primeira vez.

Duas entregas da msm mensagem ao msm tempo também ficam seguras: a segunda espera a primeira commitar no índice
único e aí cai no conflito. Se a msm `messageId` voltar com conteúdo diferente, o consumer mantém o processamento
original, faz ack e loga um aviso, pq isso indica erro de quem publicou.

São duas camadas de deduplicação com papéis diferentes: a **inbox** reconhece a msm *mensagem* e a **idempotency
key** reconhece a msm *operação* mesmo vindo em mensagens diferentes. As duas estão no banco.

**Ack só depois do commit.** O `DeleteMessage` só roda depois que o handler voltou, e o handler só volta depois do
commit. Se o processo morre entre o commit e o ack, a mensagem reaparece depois do visibility timeout e a inbox
reconhece. O teste simula exatamente isso.

**Três tipos de falha, três destinos:**

| Tipo | Exemplos | O que o consumer faz |
|---|---|---|
| Negócio | saldo insuficiente, referência inválida, moeda diferente da wallet | **ack**. A transação foi gravada como `REJECTED` com `failureCode` e evento na outbox. Reenviar daria o msm resultado |
| Transitório | banco fora, `lock_timeout`, deadlock, version mudou no meio | **sem ack**. Muda a visibility pra voltar com backoff: 1s, 2s, 4s... até 60s, pelo `ApproximateReceiveCount`. Depois de 5 recebimentos o redrive do SQS manda pra DLQ |
| Permanente | JSON quebrado, campo inválido, `OPENING` vindo da fila, wallet inexistente, msm key com outro payload | **direto pra DLQ** e apaga da fila. Tentar de novo não muda nada, então não gasta as 5 tentativas |

Erro **inesperado** que não se encaixa em nenhum dos três é tratado como transitório. Se for bug, esgota as tentativas
e cai na DLQ do msm jeito, sem perder a mensagem.

**Ordem dentro do grupo.** O `MessageGroupId` das mensagens é a `walletId`. Se uma mensagem do lote falha com erro
transitório, as próximas do msm grupo no msm lote são devolvidas pra fila sem processar. Assim nenhuma passa na
frente da que falhou. Mensagens de outros grupos seguem normal.

**SIGTERM.** O `enableShutdownHooks` do Nest chama o `onModuleDestroy`, que para o consumer antes do pool do banco
fechar. O `stop()`:

1. corta o long polling na hora, sem esperar os até 20s do receive;
2. deixa a mensagem que já está sendo processada terminar e fazer o ack;
3. devolve as que sobraram no lote com visibility zero, pra outra instância pegar na hora em vez de esperar 30s.

| Variável | Padrão | Pra que serve |
|---|---|---|
| `SQS_CONSUMER_ENABLED` | `true` | liga o consumer na instância |
| `SQS_WAIT_TIME_SECONDS` | `20` | long polling do receive |
| `SQS_RETRY_BASE_DELAY_SECONDS` | `1` | primeiro intervalo do backoff de erro transitório |
| `SQS_RETRY_MAX_DELAY_SECONDS` | `60` | teto do backoff |

---

## 4. Modelo de domínio

Código em `src/domain/`, sem dependência de NestJS nem de ORM. Todas as entidades têm construtor `private`
e factories estáticas (`create`/`open`/`receive`/`enqueue` validam; `rehydrate` só reconstrói o estado persistido).

| Classe | Papel |
|---|---|
| `Money` | Valor imutável (`Object.freeze`). Operações retornam nova instância; moedas diferentes lançam `CurrencyMismatchError`. |
| `Wallet` | Aggregate root. `debit`/`credit` alteram o saldo **e** devolvem o `WalletLedgerEntry`, então saldo e ledger não divergem. `version` começa em 1 e só sobe quando o saldo muda. |
| `WalletLedgerEntry` | Lançamento imutável (campos `readonly` + `Object.freeze`). `create` valida `balanceBefore ± money === balanceAfter`, valor positivo e saldo final não negativo. |
| `WagerTransaction` | Máquina de estados da operação (ver abaixo). Guarda `balanceAfter` para o replay devolver o saldo observado. |
| `WagerSettlement` | Serviço de domínio puro que aplica as regras de BET/WIN/LOSS/REFUND/ROLLBACK sobre uma wallet já travada. |
| `InboxMessage` / `OutboxMessage` | Dedup de entrada e eventos a publicar, com backoff. |
| `IntegrationEvent` | Envelope abstrato; cada evento é uma subclasse com `eventType` e `version` no tipo. |

### Escolhas de tipagem

- **`enum` mantido** para kind, status, direção e `FailureCode`, seguindo os esqueletos do enunciado. A alternativa
  idiomática (`const` object + `as const`) evita o código gerado pelo enum, mas divergiria da especificação.
- **`SettlementResult` é uma união discriminada por `status`**: quem consome só acessa `failureCode` ou `ledgerEntry`
  depois de checar o status, e o compilador garante isso.
- **Sem non-null assertion (`!`)**: campos que o status garante preenchidos (ex.: `balanceAfter` em `PROCESSED`)
  passam por uma checagem que lança `InvalidTransactionStateError` se o invariante quebrar.

### Money

- **`bigint` em centavos.** Aritmética exata, sem ponto flutuante e sem biblioteca externa. Com escala fixa de 2,
  não existe arredondamento: entradas com mais de 2 casas são rejeitadas em vez de arredondadas.
- **Entrada exige exatamente 2 casas** (`"25.00"`). `"25"` e `"25.5"` são rejeitados. Assim o mesmo valor tem uma única
  representação, o que também mantém o `payloadHash` estável.
- Rejeita: vazio, sinal (`-`/`+`), notação científica, `NaN`, `Infinity`, zeros à esquerda, vírgula, espaços e valores
  acima de `NUMERIC(19,2)` (17 dígitos inteiros).
- Negativos só existem como resultado interno (`subtract`, `negate`), nunca na entrada.

### Estados da WagerTransaction

```
PENDING ──► PROCESSED          (terminal)
   │   ──► REJECTED            (terminal)
   │   ──► FAILED              (terminal)
   └──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
              └──► PENDING_REFERENCE   (nova tentativa sem a referência)
```

Qualquer transição a partir de um estado terminal lança `InvalidTransactionStateError` (erro de programação).
`WagerSettlement.settle` verifica isso **antes** de mutar a wallet. Um teste pegou esse caso: sem o guard,
reaplicar uma transação já decidida debitava a wallet e só depois falhava na transição.

### Backoff

| | Política |
|---|---|
| `PENDING_REFERENCE` | 2s, 4s, 8s... até 5 min; **10 tentativas** (~18 min no total). Esgotado: `REJECTED` com `REFERENCE_NOT_FOUND`. |
| Outbox | 1s, 2s, 4s... até 60s; **sem limite**: evento confirmado nunca é descartado. Falha persistente aparece no outbox lag. |

### payloadHash

SHA-256 (hex) do JSON canônico (chaves ordenadas recursivamente, sem espaços, `undefined` omitido) do subconjunto:
`providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId`.
O header `Idempotency-Key` e metadados de transporte (`messageId`, `type`, `occurredAt`) ficam de fora, então a mesma
operação gera o mesmo hash por HTTP ou por SQS. Referência vazia equivale a ausente.

### Eventos

`aggregateId = walletId` em todos os eventos: a wallet é o aggregate root e a unidade de ordenação. O id da mensagem
na outbox é o `eventId`, então uma publicação duplicada chega com o mesmo id e o consumidor consegue deduplicar.

---

## 5. Persistência e schema

### ORM e migrations

- **MikroORM** (o preferencial do enunciado). Ele cuida da transação (`em.transactional()`), do pool de conexões e
  das migrations. Os repositórios escrevem **SQL explícito** pelo `em.execute()` em vez de mapear entidades.
  O motivo é que as partes críticas dependem de SQL que eu quero visível e testado: `SELECT ... FOR UPDATE` na wallet,
  violação de unique virando decisão de negócio, e o join pra trazer a moeda da wallet. O domínio já tem classes
  ricas com `create`/`rehydrate`, então uma camada de entidade do ORM no meio seria mais um mapeamento sem ganho.
  O custo é não usar o Identity Map nem o `LockMode` do ORM, e escrever o mapeamento linha → domínio à mão.
- O driver do MikroORM devolve `timestamptz` como string, não como `Date`. Os mapeamentos convertem explícito (ver achado 2 na seção 9).
- As migrations são **SQL escrito à mão** dentro das classes de migration do MikroORM, cada uma com `up` e `down`.
  O schema é parte do que é avaliado, então prefiro controlar cada constraint em vez de deixar o ORM gerar.
- A lista de migrations é explícita (`migrations/index.ts`) em vez de glob no disco. Funciona igual no Bun e no Node.
- Rodam em transação e com `allOrNothing`: se uma falhar, nada fica aplicado pela metade.
- `bun run db:migrate` aplica e `bun run db:rollback` volta a última. O teste de integração faz up → down → up pra
  provar que é reversível.

### Dinheiro no banco

`NUMERIC(19,2)` pro valor e `CHAR(3)` pra moeda, em colunas separadas. O pg devolve `NUMERIC` como string
(`"975.00"`), que entra direto no `Money.from`, sem passar por float em nenhum momento.

### Garantias no schema

| Garantia | Como |
|---|---|
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` na wallet e `balance_before/after >= 0` no ledger |
| Idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Referência na msm wallet | FK composta `(reference_transaction_id, wallet_id) → (id, wallet_id)` |
| Uma reversão por tipo | índice único parcial `(reference_transaction_id, kind) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| Um OPENING por wallet | índice único parcial `(wallet_id) WHERE kind = 'OPENING'` |
| Regras por kind | `CHECK`s: REFUND/ROLLBACK exigem referência, BET não aceita, valor zero só em LOSS |
| Coerência do status | `CHECK`s: `failure_code` só em REJECTED/FAILED, PROCESSED exige `processed_at` e `balance_after`, PENDING_REFERENCE exige `next_reference_check_at` |
| Um lançamento por transação | `UNIQUE (transaction_id, wallet_id)` no ledger |
| Lançamento na msm wallet e moeda | FKs compostas pra `wager_transactions (id, wallet_id)` e `wallets (id, currency)` |
| Aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)` |
| Ledger imutável | trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE` |
| Transação imutável | trigger: terminal não muda nada, campos que vieram do provedor nunca mudam, e não pode apagar |
| Dedup da inbox | `PRIMARY KEY (consumer_name, message_id)` |

Os triggers usam `ERRCODE = 'restrict_violation'` (23001), então a aplicação diferencia "violou imutabilidade" de
"violou check" (23514) e de "duplicou" (23505).

`balance_after` da transação fica na moeda da **wallet**, não da transação. Uma transação rejeitada por
`CURRENCY_MISMATCH` (operação em USD numa wallet BRL) guarda o saldo BRL que a wallet tinha.

### Índices

Só pras queries que já sei que vão existir. Conferi com `EXPLAIN` que o planner usa cada um:

| Índice | Query que atende |
|---|---|
| `outbox_pending_ix (sequence) WHERE published_at IS NULL` | publisher buscando eventos pendentes em ordem. Parcial, só guarda o que falta publicar |
| `wager_tx_pending_reference_due_ix (next_reference_check_at) WHERE status = 'PENDING_REFERENCE'` | worker buscando as que venceram o backoff |
| `wager_tx_waiting_for_reference_ix (provider_id, reference_external_transaction_id) WHERE status = 'PENDING_REFERENCE'` | quando uma transação chega, achar quem tava esperando por ela |
| `ledger_wallet_sequence_ix (wallet_id, sequence)` | paginação do ledger por cursor e reconciliação |

O ledger e a outbox têm uma coluna `sequence` (`GENERATED ALWAYS AS IDENTITY`). É a ordem de inserção e serve de
cursor estável, sem depender de relógio nem de empate de `created_at`.

Os índices são criados sem `CONCURRENTLY`, pq na migration inicial as tabelas estão vazias e a migration roda em
transação (que não aceita `CONCURRENTLY`). Numa tabela já populada em produção seria uma migration separada, fora de
transação.

---

## 6. Processamento e API

### Fluxo de uma operação

Um use case só, `ProcessWagerTransaction`, atende o HTTP e a fila. Tudo dentro de **uma** transação SQL:

1. Valida o que dá antes de abrir transação (formato do dinheiro, kind permitido) e calcula o `payloadHash`.
2. Se veio pela fila, registra a mensagem na inbox. Se já estava lá, para aqui sem fazer nada (seção 3).
3. Trava a wallet com `SELECT ... FOR UPDATE`. Se não existe, é 404.
4. Procura a operação pela idempotency key ou por `(providerId, externalTransactionId)`.
   Achou com msm key e msm hash: replay, devolve o resultado guardado. Achou com outra coisa: 409.
5. Cria a `WagerTransaction`, busca a referência (se tiver) e roda o `WagerSettlement` do domínio.
6. Grava a transação, o saldo novo (`UPDATE ... WHERE version = ?`), o lançamento e os eventos na outbox.
7. Commit. Só depois disso a resposta sai, ou o ack da mensagem acontece.

### Concorrência

- **Lock pessimista por wallet** (`SELECT ... FOR UPDATE`). A unidade de concorrência é a `walletId`: operações da
  msm wallet entram em fila no banco, wallets diferentes rodam em paralelo. Não tem lock global.
- Escolhi pessimista e não otimista pq numa hot wallet (muita aposta na msm wallet) o otimista gera retry em cascata.
  Com o lock cada operação espera a vez uma vez só. Como cada transação trava uma wallet só, não tem como dar deadlock.
- O `UPDATE` do saldo ainda confere a `version` como segunda barreira. Se não bater, nada é gravado e a resposta é 503.
- **`lock_timeout` por transação** (achado 3 na seção 9). `SET LOCAL lock_timeout`, padrão 5s, `DB_LOCK_TIMEOUT_MS`. Quem espera o lock
  segura uma conexão do pool. Sem limite, uma wallet travada prenderia todas as conexões e derrubaria as outras
  wallets junto. Com o limite, quem passa do tempo recebe 503 com `Retry-After` e nada é gravado.
- Isolamento `READ COMMITTED` (padrão do Postgres). Depois de pegar o lock, cada SELECT enxerga o que a transação
  anterior da msm wallet commitou, então a checagem de idempotência e a busca da referência veem o estado atual.

### Referências fora de ordem

Quando um `REFUND`, `ROLLBACK` ou `WIN` com referência chega antes da transação que ele referencia, ele é gravado como
`PENDING_REFERENCE` e responde 202. Quem resolve depois é o `PendingReferenceWorker`, que roda o use case
`ResolvePendingReferences` em loop.

**Um ciclo do worker:**

1. Busca os ids `PENDING_REFERENCE` com `next_reference_check_at` vencido, os mais atrasados primeiro, pelo índice
   parcial `wager_tx_pending_reference_due_ix`.
2. Pra cada um, abre uma transação SQL própria: trava a **wallet** com `FOR UPDATE` e só depois relê a transação
   pendente. É a msm ordem de lock do HTTP e da fila, wallet primeiro, então não tem deadlock entre eles.
3. Se a transação não está mais pendente ou o backoff ainda não venceu, pula. É o que acontece quando dois workers
   pegam o msm id: o segundo espera o lock da wallet, relê, vê que já foi resolvida e segue.
4. Busca a referência e decide:
   - chegou e já foi decidida: o `WagerSettlement` do domínio aplica a operação, igual na entrada direta. Pode virar
     `PROCESSED` ou `REJECTED` por alguma regra, tipo valor diferente ou referência rejeitada;
   - não chegou e ainda tem tentativa: conta mais uma e agenda a próxima com backoff (2s, 4s, 8s... até 5 min);
   - não chegou e esgotou as 10 tentativas: `REJECTED` com `REFERENCE_NOT_FOUND`.
5. Grava tudo e, se a transação terminou, os eventos na outbox, na msm transação.

Uma transação com problema num ciclo não trava as outras: o erro é registrado no log, ela continua vencida e volta no
próximo ciclo.

**Eventos.** O `WagerTransactionPendingReference` sai só na primeira vez, quando a transação fica pendente. As novas
tentativas só atualizam a linha, senão uma referência que nunca chega geraria 10 eventos iguais. Quando a transação
termina, sai o evento final: `WagerTransactionProcessed` com `WalletBalanceChanged`, ou `WagerTransactionRejected`.

**Acordar quem está esperando.** Quando qualquer transação termina decidida, um `UPDATE` pelo índice parcial
`wager_tx_waiting_for_reference_ix` antecipa pra agora o `next_reference_check_at` de quem estava esperando por ela.
Sem isso, um `REFUND` na sexta tentativa esperaria até 64s mesmo com a `BET` já tendo chegado. Isso roda tanto na
entrada direta quanto no próprio worker, pq uma transação resolvida pelo worker também pode ser referência de outra,
tipo um `ROLLBACK` de um `REFUND`.

**Replay.** Reenviar a msm operação depois que ela foi resolvida devolve o estado atual dela, não o 202 do primeiro
envio: a transação deixou de estar pendente.

| Variável | Padrão | Pra que serve |
|---|---|---|
| `PENDING_REFERENCE_WORKER_ENABLED` | `true` | liga o worker na instância |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | `1000` | espera entre ciclos quando não tem nada vencido |
| `PENDING_REFERENCE_BATCH_SIZE` | `50` | transações por ciclo |

O loop do worker é o msm `PollingWorker` da outbox: se o ciclo fez trabalho emenda o próximo, se não fez espera o
intervalo, e o `stop()` espera o ciclo atual terminar antes do pool do banco fechar.

### Corrida de idempotência

Duas requisições com a msm key mas `walletId` diferentes travam wallets diferentes, então as duas passam pela checagem
ao msm tempo. Aí quem barra é a unique do banco: a segunda falha no insert, a transação inteira faz rollback e o use
case tenta **uma** vez de novo. Na nova tentativa ela acha a primeira e vira replay ou 409. O teste de 50 requisições
iguais em paralelo cobre isso.

### Status HTTP

| Situação | Status | Corpo |
|---|---|---|
| Processada (inclusive replay) | 200 | `{ transactionId, status, balance, idempotentReplay }` |
| Rejeitada por regra de negócio | 422 | msm formato + `failureCode` |
| Aceita aguardando referência | 202 | msm formato, `balance: null` |
| Payload inválido, header faltando, cursor inválido | 400 | `{ error: { code: "INVALID_PAYLOAD", message } }` |
| Wallet ou transação não existe | 404 | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` |
| Msm key com outro payload, wallet duplicada | 409 | `IDEMPOTENCY_KEY_CONFLICT` / `WALLET_ALREADY_EXISTS` |
| Banco fora, lock timeout, deadlock | 503 + `Retry-After` | `SERVICE_UNAVAILABLE` |

O replay devolve o **msm status** da resposta original (uma rejeição reenviada continua 422), então o provedor
decide pelo status e nunca precisa ler a mensagem.

Rejeição de negócio não é erro HTTP no sentido de exceção: a transação foi aceita, decidida e gravada (auditável),
só que como `REJECTED`. Por isso o corpo é o msm de uma processada, com o `failureCode` a mais.

### Outras decisões da API

- **Validação em duas camadas.** O DTO (class-validator) confere tipo, UUID, kind e campos desconhecidos
  (`forbidNonWhitelisted`). O formato do dinheiro fica com o `Money.from` do domínio, pra regra não ficar duplicada.
- **Idempotency-Key obrigatória** no header, até 255 caracteres. É ela que identifica a operação, não o corpo.
- **`x-correlation-id`** opcional: se vier, vai pros eventos da outbox, se não, é gerado.
- **Ledger paginado por cursor opaco** (`base64url` da `sequence` do último item). Limite padrão 50, máximo 200.
- **Reconciliação** compara o saldo da wallet com a soma do ledger. Divergência é logada e devolvida com
  `consistent: false`, **nunca corrigida**. É `POST` pq é uma verificação sob demanda com efeito (log/métrica).
- **Wallet com saldo inicial** gera uma transação `OPENING` e um `CREDIT` na msm transação SQL, e publica
  `WagerTransactionProcessed` e `WalletBalanceChanged` como qualquer outra operação que muda saldo.
- **IDs são UUID v7** (`Bun.randomUUIDv7()`), ordenados por tempo, o que mantém o índice da PK compacto.
- **Health:** `/health/live` não toca em nada, `/health/ready` confere o Postgres e a fila de entrada do SQS.
  Os dois ficam sem autenticação.

---

## 7. Códigos de falha

Persistidos em `failure_code`. Reenviar a mesma idempotency key sempre devolve o resultado original;
"corrigir" significa enviar uma nova transação.

| Código | Quando | Orientação ao provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | Não reenviar |
| `REVERSAL_WOULD_OVERDRAW` | ROLLBACK de WIN/REFUND deixaria saldo negativo | Tratamento operacional |
| `CURRENCY_MISMATCH` | Moeda da operação ≠ moeda da wallet | Corrigir payload |
| `WALLET_PLAYER_MISMATCH` | `playerId` não é dono da wallet | Corrigir payload |
| `REFERENCE_NOT_FOUND` | Referência não chegou dentro do limite de tentativas | Desistir |
| `REFERENCE_MISMATCH` | Referência de outro provider/player/wallet/moeda/rodada | Corrigir payload |
| `REFERENCE_KIND_NOT_ALLOWED` | Ex.: REFUND referenciando WIN | Corrigir payload |
| `REFERENCE_NOT_PROCESSED` | Referência terminou REJECTED/FAILED | Desistir |
| `REFERENCE_ALREADY_REVERSED` | Referência já revertida pelo mesmo tipo | Desistir |
| `REFERENCE_AMOUNT_MISMATCH` | Valor da reversão ≠ valor da referência | Corrigir payload |
| `PERMANENT_PROCESSING_FAILURE` | Erro permanente de infraestrutura (status `FAILED`) | Investigação |

---

## 8. Interpretações das regras

| Regra / ambiguidade | Interpretação adotada |
|---|---|
| Quais kinds aceitam referência | `REFUND` e `ROLLBACK` exigem. `WIN` e `LOSS` aceitam opcionalmente (só `BET`). `BET` com referência é payload inválido. |
| "Não pode ser revertida duas vezes **pelo mesmo tipo**" | Seguida literalmente (regra 4 da seção 7 do enunciado): uma referência aceita no máximo um `REFUND` e no máximo um `ROLLBACK`. Consequência: uma `BET` com `REFUND` e também `ROLLBACK` é creditada duas vezes. Ver limitações. |
| Referência existe mas ainda não foi decidida (ex.: está `PENDING_REFERENCE`) | Tratada como ausente: a transação fica `PENDING_REFERENCE` e tenta de novo. Se esgotar as tentativas assim, vira `REJECTED` com `REFERENCE_NOT_FOUND`, msm código de quando a referência nunca chega. |
| Limite de tentativas da referência | 10 tentativas com backoff de 2s até 5 min, uns 18 min no total. Provedor costuma mandar a operação referenciada em segundos, e o dinheiro da reversão fica "parado" enquanto espera, então não compensa esperar muito mais. O worker acorda quem espera assim que a referência chega, então o limite só pesa quando ela não vem mesmo. |
| Referência existe e terminou `REJECTED`/`FAILED` | `REJECTED` com `REFERENCE_NOT_PROCESSED`, sem esperar. |
| Valor zero | Só `LOSS` aceita `"0.00"`. Os demais kinds exigem valor positivo. |
| `playerId` diferente do dono da wallet | `REJECTED` com `WALLET_PLAYER_MISMATCH` (persistido e auditável). |
| Wallet aberta com saldo zero | Não gera transação `OPENING` nem lançamento. |
| Quais erros da fila são permanentes | Payload inválido, wallet inexistente e conflito de idempotência vão direto pra DLQ, pq repetir dá o msm resultado. Regra de negócio não é erro: vira `REJECTED` e a mensagem é ack. |
| Status `FAILED` | O enunciado define, mas nenhuma rota de hoje grava. Mensagem que esgota as tentativas por erro de infraestrutura nunca chegou a commitar transação nenhuma, então não tem linha pra marcar como `FAILED`. O registro auditável dela é a DLQ, com o motivo no atributo `reason`, mais o log. |
| `correlationId` de quem vem pela fila | A mensagem do enunciado não tem um. O `messageId` vira o `correlationId` e o `causationId` dos eventos gerados, o que liga cada evento à mensagem que causou ele. |
| Pra onde a outbox publica | O enunciado não nomeia. Uma fila FIFO `wager-events.fifo`, com `MessageGroupId = walletId` e `MessageDeduplicationId = eventId`. O corpo é o envelope do evento. |
| Formato de `playerId` e `walletId` | UUID, como nos exemplos do enunciado (coluna `uuid` no banco). `providerId`, `externalTransactionId`, `roundId` e `gameId` são texto livre. |

---

## 9. Testes

### Teste antes do código

A partir da Fase 2 os testes são escritos **antes** da implementação. O fluxo é escrever o teste, rodar e ver falhar,
e só depois implementar até passar. Assim o teste descreve o comportamento esperado e não vira um espelho do código que
já existe (teste feito pra passar).

A Fase 1 (domínio) foi feita com o código primeiro e os testes logo depois.

### Achados

Problemas reais que apareceram durante o desenvolvimento, e como foram resolvidos.

**1. Débito duplicado ao reaplicar uma transação (Fase 1, domínio)**

- **Como apareceu:** um teste unitário reaplicava uma BET já processada esperando erro. O erro vinha, mas o saldo
  já tinha sido debitado de novo.
- **Causa:** o `WagerSettlement` mexia na wallet primeiro e só depois tentava mudar o status da transação, que é
  quando a regra de estado terminal lançava o erro.
- **Correção:** checar se a transação já é terminal **antes** de qualquer mutação. O banco também barra pela
  idempotência, mas o domínio não pode depender disso.

**2. Datas chegando como string do banco (Fase 3, persistência)**

- **Como apareceu:** os testes e2e das consultas (ledger e transação por id) davam 500. Com o app rodando com log de
  erro ligado, apareceu `createdAt.toISOString is not a function`.
- **Causa:** o driver do MikroORM devolve `timestamptz` como **string**, e não como `Date` como o `pg` puro faz. Num
  teste chamando o repositório direto o erro não aparecia, pq ali a data nem era usada.
- **Correção:** os mapeamentos linha → domínio convertem explícito (`toDate`), em vez de confiar no tipo que o driver
  devolve.

**3. Hot wallet esgotando o pool de conexões (Fase 3, concorrência)**

- **Como apareceu:** na revisão do lock pessimista. Quem espera o `SELECT ... FOR UPDATE` fica parado **segurando uma
  conexão do pool**. Se uma wallet ficar travada (transação lenta, processo pendurado), as requisições dela vão
  ocupando todas as conexões e as outras wallets param junto, mesmo sem ter nada a ver.
- **Como provei:** um teste e2e trava a wallet por outra conexão e manda uma aposta. Antes da correção a requisição
  ficava pendurada até o teste estourar o tempo (5s).
- **Correção:** `SET LOCAL lock_timeout` no começo de cada transação (padrão 5s, `DB_LOCK_TIMEOUT_MS`). Quem passa do
  tempo recebe 503 com `Retry-After`, nada é gravado, e reenviar com a msm key processa normal depois.

**4. Índice criado e nunca usado (Fase 6, revisão do schema)**

- **Como apareceu:** na revisão de banco do worker de referências. O índice `wager_tx_waiting_for_reference_ix`, criado
  na Fase 2 pra "achar quem estava esperando por uma transação", não era usado por nenhuma query.
- **O problema por trás:** sem usar esse índice, uma transação pendente só era reavaliada quando o backoff dela
  vencia, mesmo com a referência já tendo chegado. Na sexta tentativa isso dava até 64s de espera à toa.
- **Correção:** quando uma transação termina decidida, quem esperava por ela é acordado na hora por um `UPDATE` que
  usa o índice. Teste escrito antes: empurra o backoff pra longe, manda a referência e espera o worker resolver sem o
  relógio andar.

### Camadas

| Tipo | Onde | O que usa |
|---|---|---|
| Unidade | `test/unit` | Só o domínio, sem banco nem fila. Roda em milissegundos. |
| Integração | `test/integration` | PostgreSQL e LocalStack reais em container, sem mock (o enunciado elimina quem mocka os dois). |
| Concorrência | `test/concurrency` | Três processos de verdade da aplicação, `bun src/main.ts` em portas diferentes, contra o msm banco e as msmas filas. |

`bun run test:unit` dá feedback em milissegundos. A suíte inteira, com os três processos, leva perto de 2 min.

Os testes de integração usam o banco `wagering_test`, separado do de desenvolvimento. Cada arquivo começa com
migration down → up, então parte de um schema limpo. Não dá pra limpar com `TRUNCATE` pq o ledger bloqueia, e isso é
proposital.

Os testes de schema (`test/integration/schema.test.ts`) tentam violar cada garantia direto via SQL e conferem o código
de erro **e o nome da constraint**. Assim um teste não passa por acidente por causa de outra regra.

### Invariante final em todas as suítes

O enunciado pede que todo teste termine com `wallet.balance == saldo reconstruído pelo ledger`. Cada suíte de
integração e a de concorrência terminam com um teste que confere isso pra **todas** as wallets do banco, não só as que o
teste usou. Ficam de fora só duas suítes que quebram o invariante de propósito: a de schema, que insere linhas cruas
pra testar constraint, e a de wallets, que corrompe um saldo pra provar que a reconciliação detecta.

### Paralelismo real e várias instâncias

Os testes de concorrência disparam as requisições juntas com `Promise.all`, nunca em sequência. A suíte
`test/concurrency` sobe três processos da aplicação, cada um com seu pool de conexões, consumer, publisher da outbox e
worker de referências, e um cliente que distribui as requisições entre eles em rodízio. Esse cliente age como um
provedor de verdade: se a instância cai ou responde 503, reenvia pra próxima com a msm `Idempotency-Key`.

### Cobertura da seção 13 do enunciado

| Cenário pedido | Onde está |
|---|---|
| A msm aposta 50 vezes em paralelo vira um débito só | `wagering.e2e`, e 60 vezes espalhada entre 3 processos em `multi-instance` |
| Operações disputando o saldo da msm wallet, o cenário 100 / 80 / 80 | `wagering.e2e`, e 30 apostas pra um saldo que só dá pra 10 entre 3 processos |
| Wallets distintas em paralelo | `wagering.e2e`: com a wallet A travada, a B responde em menos de 250ms. Prova que não tem lock global |
| Três ou mais processos simultâneos | `multi-instance`, HTTP e fila |
| Worker morto depois do commit e antes do ack | `sqs-consumer` simulando, e `multi-instance` matando processo de verdade |
| Dois publishers na msm outbox | `outbox-publisher`, com pools separados |
| `ROLLBACK` ou `REFUND` antes da referência | `pending-reference` e `pending-reference.e2e` |
| Reinício com prova de consistência final | `multi-instance`: mata uma instância no meio da carga, sobe de novo e confere tudo |

**O teste de reinício.** São 10 wallets com 200 apostas, metade por HTTP e metade pela fila. Quando 40 já foram
processadas, o teste mata uma das instâncias com `SIGKILL`, sem dar chance de terminar nada, e sobe ela de novo. Aí
espera o sistema estabilizar: fila de entrada vazia, inclusive as mensagens que estavam em voo na instância morta e
só voltam depois do visibility timeout de 30s, e outbox toda publicada. No fim confere:

- cada wallet com exatamente 20 débitos e o saldo certo;
- nenhuma mensagem na DLQ;
- invariante saldo == ledger em todas as wallets;
- **pelo menos uma requisição precisou de failover.** Sem isso o teste poderia passar só pq a instância morreu num
  momento ocioso, e não teria provado nada.

**Fase 7 e TDD.** Os testes desta fase são de caracterização: verificam garantias que as fases anteriores já deviam
dar, e nasceram verdes. Não teve vermelho pra mostrar, e isso é registrado aqui de propósito. Pra ter certeza de que
o teste de reinício não passava por acaso, ele ganhou a checagem de failover.

---

## 10. Limitações conhecidas

### Reversão por tipo

Seguindo o enunciado, a unicidade da reversão é por `(referência, tipo)`. Uma `BET` que recebe `REFUND` e depois
`ROLLBACK` direto (e não um `ROLLBACK` do `REFUND`) é creditada duas vezes. Com mais contexto do domínio, eu avaliaria
restringir a uma reversão por referência, independentemente do tipo.

### Banco

- `NUMERIC(19,2)` arredonda em silêncio um valor com mais casas (`1.005` vira `1.01`) antes de qualquer `CHECK`.
  O banco não tem como recusar isso, então a validação de escala fica no `Money.from`, na entrada.
- A coerência entre `wallets.balance` e a soma do ledger não é uma constraint (exigiria somar o ledger a cada escrita).
  Ela é garantida pela aplicação, que grava saldo e lançamento na msm transação, e conferida pelo endpoint de
  reconciliação.
- Em dev o app conecta com o usuário dono das tabelas. Em produção, um role de aplicação sem `UPDATE`/`DELETE` no
  ledger seria uma segunda barreira além do trigger.

### Ordem dos eventos

A outbox publica em ordem de `sequence` e o `MessageGroupId` por wallet faz o SQS entregar na ordem em que recebeu.
Mas com várias instâncias publicando ao msm tempo, dois eventos da msm wallet podem cair em lotes diferentes e sair
fora de ordem. A ordem por wallet é melhor esforço. O consumidor que precisar de ordem estrita usa o
`walletVersion` do `WalletBalanceChanged`, que cresce a cada mudança de saldo.

### Lote da outbox segura o lock durante a publicação

O lote publica com a transação aberta, segurando o lock das linhas até o commit. É o que deixa o desenho simples e
seguro: morreu no meio, o rollback devolve tudo. O custo é a transação durar o tempo das chamadas ao SQS. Isso é
limitado pelo tamanho do lote, pelo timeout de 5s por chamada e por parar no primeiro erro do broker. A alternativa
seria um lease com coluna `claimed_until`, que publica fora da transação mas exige tratar lease expirado.

### Visibility timeout do lote no consumer

O consumer recebe até 10 mensagens e processa uma por vez. O visibility timeout de 30s conta a partir do receive,
pra todas do lote ao msm tempo. Se várias mensagens do lote baterem no `lock_timeout` de 5s, as últimas podem
reaparecer pra outra instância antes de serem processadas. A correção continua garantida pela inbox e pelo lock da
wallet, então não duplica nada, mas gera retrabalho. A solução seria renovar a visibility de cada mensagem logo antes
de processar ela. Ficou de fora pq eu não consegui escrever um teste que falhasse sem isso sem mudar o timeout da fila
que os outros testes usam, e não implemento comportamento sem teste.

### Envio pra DLQ não é atômico

Mandar pra DLQ e apagar da fila de entrada são duas chamadas ao SQS. Se o processo morre entre as duas, a mensagem
volta e vai pra DLQ de novo. A DLQ é pra análise humana e o `MessageDeduplicationId` é o `MessageId` original, então
dentro da janela de 5 min o SQS descarta a cópia. Fora dela, aparece duplicada na DLQ, o que é aceitável.

### Hot wallet

O lock por wallet serializa as operações dela, então o throughput de **uma** wallet fica limitado ao tempo de uma
transação. É a troca consciente por correção: wallets diferentes continuam em paralelo. Sob contenção forte numa
wallet só, parte das requisições passa do `lock_timeout` e recebe 503, e o provedor reenvia com a msm key sem risco
de duplicar.

### Testes de concorrência

- As três instâncias da suíte `test/concurrency` usam portas fixas, 3101 a 3103. Se alguma estiver ocupada na máquina,
  a suíte não sobe.
- No Windows não tem `SIGTERM` de verdade entre processos: qualquer `kill` encerra na hora. Por isso o desligamento
  gracioso é testado dentro do processo, chamando o `stop()` do consumer e dos workers, e o teste multi-processo cobre o
  outro lado, a morte abrupta.
- O teste de reinício espera o visibility timeout de 30s da fila pra mensagem em voo na instância morta voltar. É o
  comportamento real, mas deixa a suíte mais lenta.

### LocalStack

- É uma emulação da API, não a AWS. O LocalStack responde às mesmas chamadas HTTP do SQS em
  localhost e mantém o estado em memória dentro do container. Alguns comportamentos podem divergir do SQS real,
  por exemplo a precisão do visibility timeout, latências, throughput e limites de throttling.
- IAM não é verificado. As credenciais `test`/`test` são aceitas sem validação, e permissões e políticas
  de fila não são exercitadas.
- Sem volume persistente, as filas são recriadas a cada subida pelo script de init e mensagens
  pendentes se perdem ao reiniciar o container. Isso não afeta a correção, porque o banco guarda o estado e o
  outbox reenvia o que não foi publicado, mas um teste de "reinício do broker" não reproduz fielmente a AWS.
- Tá numa versão fixada (`4.4`) e não recebe atualizações. foi escolhida por funcionar sem token de autenticação.
- Em produção, o mesmo código usaria o SQS real apenas removendo `AWS_ENDPOINT_URL` e fornecendo as credenciais reais.

---

## 11. O que eu faria com mais tempo

- _[quando terminar preciso lembrar de preencher]_
- **Branded types pros ids** (`WalletId`, `TransactionId`...). Impedem passar um id no lugar de outro já em tempo de
  compilação. Ficou de fora pelo timebox, hoje todos são `string`.
- **`exactOptionalPropertyTypes`**. Diferencia "campo ausente" de "campo `undefined`". Ia exigir ajustar todos os
  estados opcionais (`processedAt`, `failureCode`...), então ficou pra depois.
- **OpenAPI/Swagger** gerado a partir dos DTOs, pra documentar os contratos sem depender do README.
- **`SendMessageBatch`** na outbox, mandando até 10 eventos por chamada ao SQS em vez de um por vez.
- **Renovar a visibility** de cada mensagem antes de processar no consumer, e processar grupos diferentes do lote em
  paralelo em vez de um por vez.