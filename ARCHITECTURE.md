# ARCHITECTURE do Distributed Wagering Processor

## [INDICE]

1. [Overview](#1-visão-geral)
2. [Stack](#2-stack-e-ambiente-local)
3. [Mensageria](#3-mensageria-sqs)
4. [Modelo de domínio](#4-modelo-de-domínio)
5. [Persistência e schema](#5-persistência-e-schema)
6. [Códigos de falha](#6-códigos-de-falha)
7. [Interpretações das regras](#7-interpretações-das-regras)
8. [Testes](#8-testes)
9. [Limitações](#9-limitações-conhecidas)
10. [O que eu faria com mais tempo](#10-o-que-eu-faria-com-mais-tempo)

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
| Mensageria | LocalStack 4.4 (SQS) | Exigido (LocalStack ou MiniStack). Tem limitações, descritas na seção 9. |
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

Filas com os nomes definidos no enunciado:

| Fila | Configuração |
|---|---|
| `wager-transactions.fifo` | FIFO, `ContentBasedDeduplication=false`, `VisibilityTimeout=30`, `RedrivePolicy` → DLQ com `maxReceiveCount=5` |
| `wager-transactions-dlq.fifo` | FIFO |

- **`ContentBasedDeduplication=false`**: o produtor informa `MessageDeduplicationId` explicitamente, evitando
  que dois payloads idênticos com significados distintos sejam descartados pelo broker.
- **`maxReceiveCount=5`**: limite de tentativas antes da DLQ (seção 10 do enunciado). A DLQ é criada antes da fila
  principal porque a `RedrivePolicy` referencia o ARN dela.
- **`VisibilityTimeout=30`**: tempo para processar uma mensagem antes que ela volte a ficar visível.
  _[a revisar]_ ajustar conforme a latência medida do processamento.
- **FIFO não é garantia de consistência.** O `MessageGroupId` (planejado: `walletId`) reduz contenção, mas
  a correção depende do lock no banco e da inbox persistente.

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

- **MikroORM** (o preferencial do enunciado). Unit of Work, `em.transactional()` e `LockMode` explícitos combinam
  com o que o processamento precisa: travar a wallet, aplicar tudo e commitar junto.
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

## 6. Códigos de falha

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

## 7. Interpretações das regras

| Regra / ambiguidade | Interpretação adotada |
|---|---|
| Quais kinds aceitam referência | `REFUND` e `ROLLBACK` exigem. `WIN` e `LOSS` aceitam opcionalmente (só `BET`). `BET` com referência é payload inválido. |
| "Não pode ser revertida duas vezes **pelo mesmo tipo**" | Seguida literalmente (regra 4 da seção 7 do enunciado): uma referência aceita no máximo um `REFUND` e no máximo um `ROLLBACK`. Consequência: uma `BET` com `REFUND` e também `ROLLBACK` é creditada duas vezes. Ver limitações. |
| Referência existe mas ainda não foi decidida (ex.: está `PENDING_REFERENCE`) | Tratada como ausente: a transação fica `PENDING_REFERENCE` e tenta de novo. |
| Referência existe e terminou `REJECTED`/`FAILED` | `REJECTED` com `REFERENCE_NOT_PROCESSED`, sem esperar. |
| Valor zero | Só `LOSS` aceita `"0.00"`. Os demais kinds exigem valor positivo. |
| `playerId` diferente do dono da wallet | `REJECTED` com `WALLET_PLAYER_MISMATCH` (persistido e auditável). |
| Wallet aberta com saldo zero | Não gera transação `OPENING` nem lançamento. |
| Formato de `playerId` e `walletId` | UUID, como nos exemplos do enunciado (coluna `uuid` no banco). `providerId`, `externalTransactionId`, `roundId` e `gameId` são texto livre. |

---

## 8. Testes

### Teste antes do código

A partir da Fase 2 os testes são escritos **antes** da implementação. O fluxo é escrever o teste, rodar e ver falhar,
e só depois implementar até passar. Assim o teste descreve o comportamento esperado e não vira um espelho do código que
já existe (teste feito pra passar).

A Fase 1 (domínio) foi feita com o código primeiro e os testes logo depois. Mesmo assim, um deles pegou um bug real:
reaplicar uma transação já decidida debitava a wallet de novo antes de falhar.

### Camadas

| Tipo | Onde | O que usa |
|---|---|---|
| Unidade | `test/unit` | Só o domínio, sem banco nem fila. Roda em milissegundos. |
| Integração | `test/integration` | PostgreSQL e LocalStack reais em container, sem mock (o enunciado elimina quem mocka os dois). |

Os testes de integração usam o banco `wagering_test`, separado do de desenvolvimento. Cada arquivo começa com
migration down → up, então parte de um schema limpo. Não dá pra limpar com `TRUNCATE` pq o ledger bloqueia, e isso é
proposital.

Os testes de schema (`test/integration/schema.test.ts`) tentam violar cada garantia direto via SQL e conferem o código
de erro **e o nome da constraint**. Assim um teste não passa por acidente por causa de outra regra.

---

## 9. Limitações conhecidas

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

## 10. O que eu faria com mais tempo

- _[quando terminar preciso lembrar de preencher]_