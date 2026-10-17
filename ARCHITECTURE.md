# ARCHITECTURE do Distributed Wagering Processor

## [INDICE]

1. [Overview](#1-visão-geral)
2. [Stack](#2-stack-e-ambiente-local)
3. [Mensageria](#3-mensageria-sqs)
4. [Modelo de domínio](#4-modelo-de-domínio)
5. [Códigos de falha](#5-códigos-de-falha)
6. [Interpretações das regras](#6-interpretações-das-regras)
7. [Limitações](#7-limitações-conhecidas)
8. [O que eu faria com mais tempo](#8-o-que-eu-faria-com-mais-tempo)

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
| Mensageria | LocalStack 4.4 (SQS) | Exigido (LocalStack ou MiniStack). Tem limitações, descritas na seção 7. |
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

## 5. Códigos de falha

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

## 6. Interpretações das regras

| Regra / ambiguidade | Interpretação adotada |
|---|---|
| Quais kinds aceitam referência | `REFUND` e `ROLLBACK` exigem. `WIN` e `LOSS` aceitam opcionalmente (só `BET`). `BET` com referência é payload inválido. |
| "Não pode ser revertida duas vezes **pelo mesmo tipo**" | Seguida literalmente (regra 4 da seção 7 do enunciado): uma referência aceita no máximo um `REFUND` e no máximo um `ROLLBACK`. Consequência: uma `BET` com `REFUND` e também `ROLLBACK` é creditada duas vezes. Ver limitações. |
| Referência existe mas ainda não foi decidida (ex.: está `PENDING_REFERENCE`) | Tratada como ausente: a transação fica `PENDING_REFERENCE` e tenta de novo. |
| Referência existe e terminou `REJECTED`/`FAILED` | `REJECTED` com `REFERENCE_NOT_PROCESSED`, sem esperar. |
| Valor zero | Só `LOSS` aceita `"0.00"`. Os demais kinds exigem valor positivo. |
| `playerId` diferente do dono da wallet | `REJECTED` com `WALLET_PLAYER_MISMATCH` (persistido e auditável). |
| Wallet aberta com saldo zero | Não gera transação `OPENING` nem lançamento. |

---

## 7. Limitações conhecidas

### Reversão por tipo

Seguindo o enunciado, a unicidade da reversão é por `(referência, tipo)`. Uma `BET` que recebe `REFUND` e depois
`ROLLBACK` direto (e não um `ROLLBACK` do `REFUND`) é creditada duas vezes. Com mais contexto do domínio, eu avaliaria
restringir a uma reversão por referência, independentemente do tipo.

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

## 8. O que eu faria com mais tempo

- _[quando terminar preciso lembrar de preencher]_