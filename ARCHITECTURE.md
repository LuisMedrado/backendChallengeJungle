# ARCHITECTURE do Distributed Wagering Processor

## [INDICE]

1. [Overview](#1-visão-geral)
2. [Stack](#2-stack-e-ambiente-local)
3. [Mensageria](#3-mensageria-sqs)
4. [Modelo de domínio](#4-modelo-de-domínio)
5. [Persistência e schema](#5-persistência-e-schema)
6. [Processamento e API](#6-processamento-e-api)
7. [Observabilidade](#7-observabilidade)
8. [Autenticação](#8-autenticação)
9. [Códigos de falha](#9-códigos-de-falha)
10. [Interpretações das regras](#10-interpretações-das-regras)
11. [Testes](#11-testes)
12. [Limitações](#12-limitações-conhecidas)
13. [O que eu faria com mais tempo](#13-o-que-eu-faria-com-mais-tempo)

---

## 1. Visão geral

Serviço que recebe operações de aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) por HTTP e por SQS, aplica cada
uma exatamente uma vez na wallet do jogador e publica eventos de integração.

Quem manda é o banco. FIFO e deduplicação do broker ajudam, mas unicidade, imutabilidade e saldo não negativo são
constraints do Postgres.

---

## 2. Stack e ambiente local

Bun 1.x, TypeScript estrito, NestJS 11, PostgreSQL 17, LocalStack 4.4 pro SQS e Docker Compose. Tudo isso o enunciado
exige.

- **LocalStack fixado em `4.4`.** As imagens mais novas pedem token de conta. A 4.4 sobe sem credencial.
- **`docker compose up --wait`.** Só volta quando o Postgres aceita conexão e as filas existem, então teste nenhum
  roda contra infra pela metade.
- **Banco de teste separado**, `wagering_test`, criado pelo `init.sql` na primeira subida do volume.
- **TypeScript além do `strict`:** `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `useUnknownInCatchVariables` e `verbatimModuleSyntax`. Classe injetada pelo Nest continua com import de valor, porque a
  DI lê a metadata em runtime.
- **Portas só em `127.0.0.1`**, já que as credenciais de dev são fixas.
- **`.gitattributes` força LF** em `*.sh` e `*.sql`. Os scripts rodam em container Linux e com CRLF o bash quebra.

---

## 3. Mensageria (SQS)

| Fila | Configuração |
|---|---|
| `wager-transactions.fifo` | entrada. `ContentBasedDeduplication=false`, `VisibilityTimeout=30`, redrive pra DLQ com `maxReceiveCount=5` |
| `wager-transactions-dlq.fifo` | DLQ |
| `wager-events.fifo` | saída dos eventos da outbox. O enunciado não nomeia essa (seção 10) |

O dedup do broker é desligado porque o produtor manda o `MessageDeduplicationId`. Assim dois payloads iguais com
significado diferente não somem. O `MessageGroupId` é a `walletId`, mas a correção vem do lock no banco e da inbox, não
da FIFO.

### Transactional outbox

Os eventos entram na `outbox_messages` na mesma transação SQL da operação. Antes do commit eles nem existem pra quem tá
fora, então nada é publicado antes da hora.

O `OutboxPublisherWorker` roda em toda instância. Cada lote:

1. pega até `OUTBOX_BATCH_SIZE` eventos vencidos com `SELECT ... FOR UPDATE SKIP LOCKED`, em ordem de `sequence`;
2. publica no `wager-events.fifo` e marca `published_at`;
3. commit.

Com o `SKIP LOCKED` uma instância pula o que a outra travou. Ninguém espera ninguém e ninguém publica o mesmo evento ao
mesmo tempo. Se o processo morre antes do commit, o rollback destrava as linhas e outra instância publica.

**At-least-once, de propósito.** Se o processo publica e morre antes do commit, o evento volta pra pendente e sai de
novo. Banco e broker não têm transação em comum, então sempre existe esse instante. A outra opção seria marcar antes de
publicar, e aí o evento pode nunca sair. Perder evento confirmado o enunciado proíbe, duplicado dá pra tratar:

- o `eventId` nasce uma vez, na gravação, e é o mesmo em toda republicação;
- `MessageDeduplicationId = eventId`, então dentro da janela de 5 min o próprio SQS descarta a cópia;
- o evento descreve fato, não comando: `WalletBalanceChanged` traz saldo antes, depois e `walletVersion`.

**SQS fora.** O lote para na primeira falha. O evento que falhou ganha backoff de 1s a 60s e os outros voltam sem
contar tentativa. Sem isso, um lote de 50 seguraria a transação por 50 timeouts. Não tem limite de tentativas: evento
confirmado nunca é descartado, e o travado aparece no outbox lag. Erro que não é do broker faz rollback do lote e o
loop segue no próximo ciclo.

### Consumer da fila de entrada

O `SqsWagerConsumer` entrega cada mensagem pro mesmo `ProcessWagerTransaction` do HTTP. A fila é só outra porta de
entrada, sem regra duplicada.

**Inbox na mesma transação.** O primeiro passo da transação SQL, antes do lock da wallet, é um insert de
`(consumer_name, message_id)` com `ON CONFLICT DO NOTHING`. Inseriu, segue e commita junto com saldo, ledger e outbox.
Já existia, é redelivery: para ali e faz ack. Deu erro depois, o rollback leva a inbox junto e a próxima entrega
processa do zero. Duas entregas simultâneas também ficam seguras, porque a segunda espera o índice único.

A inbox reconhece a mesma *mensagem*. A idempotency key reconhece a mesma *operação* vinda em mensagens diferentes. As duas
moram no banco.

**Ack só depois do commit.** Se o processo morre entre os dois, a mensagem volta depois do visibility timeout e a inbox
segura.

| Falha | Exemplos | Destino |
|---|---|---|
| Negócio | saldo insuficiente, referência inválida, moeda errada | **ack**. Já foi gravada como `REJECTED`, reenviar daria o mesmo resultado |
| Transitória | banco fora, `lock_timeout`, deadlock, version mudou | **sem ack**, visibility com backoff de 1s a 60s. Depois de 5 recebimentos o redrive manda pra DLQ |
| Permanente | JSON quebrado, campo inválido, `OPENING` pela fila, wallet inexistente, key com outro payload | **direto pra DLQ**, sem gastar as 5 tentativas |

Erro inesperado conta como transitório. Se for bug, esgota as tentativas e cai na DLQ sem perder a mensagem.

**Ordem no grupo.** Se uma mensagem falha com erro transitório, as próximas do mesmo grupo no lote voltam pra fila sem
processar, pra nenhuma passar na frente.

**SIGTERM.** O `onModuleDestroy` para consumer e workers antes do pool fechar. O consumer corta o long polling na hora,
deixa terminar a mensagem que já tá em processamento e devolve o resto do lote com visibility zero. Os workers esperam
o ciclo atual acabar.

---

## 4. Modelo de domínio

Código em `src/domain/`, sem Nest nem ORM. Construtor `private` em tudo: `create`/`open`/`receive`/`enqueue` validam,
`rehydrate` só reconstrói o que veio do banco.

| Classe | Papel |
|---|---|
| `Money` | imutável. Moeda diferente lança `CurrencyMismatchError` |
| `Wallet` | aggregate root. `debit`/`credit` mudam o saldo e devolvem o lançamento, então os dois não divergem |
| `WalletLedgerEntry` | imutável. Valida `balanceBefore ± money === balanceAfter` e saldo final não negativo |
| `WagerTransaction` | máquina de estados. Guarda `balanceAfter` pro replay |
| `WagerSettlement` | serviço de domínio puro com as regras de cada kind, sobre uma wallet já travada |
| `InboxMessage` / `OutboxMessage` | dedup de entrada e eventos a publicar |
| `IntegrationEvent` | envelope. Cada evento é uma subclasse |

Mantive `enum` pros kinds, status e `FailureCode` porque é o que os esqueletos do enunciado usam. O `SettlementResult` é
uma união discriminada por `status`, então só dá pra ler `failureCode` ou `ledgerEntry` depois de checar o status. E
não tem `!`: campo que o status garante passa por uma checagem que lança `InvalidTransactionStateError`.

### Money

`bigint` em centavos. Conta exata, sem float e sem lib. A entrada exige exatamente 2 casas: `"25.00"` passa, `"25"` e
`"25.5"` não. Com isso cada valor tem uma representação só e o `payloadHash` fica estável, e não existe arredondamento
pra decidir. Também recusa sinal, notação científica, `NaN`, zero à esquerda, vírgula, espaço e qualquer coisa acima
de `NUMERIC(19,2)`. Negativo só aparece como resultado interno.

### Estados da WagerTransaction

```
PENDING ──► PROCESSED | REJECTED | FAILED          (terminais)
   └──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
              └──► PENDING_REFERENCE   (nova tentativa)
```

Sair de estado terminal lança erro. O `WagerSettlement` checa isso antes de mexer na wallet (achado 1).

### payloadHash

SHA-256 do JSON canônico de `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money,
referenceExternalTransactionId`. Header e metadado de transporte ficam de fora, então a mesma operação dá o mesmo hash por
HTTP ou pela fila. Referência vazia vale como ausente.

---

## 5. Persistência e schema

### ORM e migrations

**MikroORM**, o preferencial do enunciado, cuida de transação, pool e migrations. Os repositórios escrevem SQL
explícito com `em.execute()`. O que importa aqui é SQL que eu quero ver e testar: `FOR UPDATE` na wallet, violação de
unique virando decisão, o join que traz a moeda. O domínio já tem classes ricas, então uma camada de entidade do ORM
seria mais um mapeamento sem ganho. Em troca abro mão do Identity Map e do `LockMode`, e mapeio linha → domínio à mão.
Esse driver devolve `timestamptz` como string, por isso os mappers convertem (achado 2).

As migrations são SQL à mão, com `up` e `down`, numa lista explícita em `migrations/index.ts`, rodando em transação com
`allOrNothing`. O teste faz up → down → up.

Dinheiro é `NUMERIC(19,2)` mais `CHAR(3)` em colunas separadas. O pg devolve o `NUMERIC` como string e ele entra direto
no `Money.from`, sem passar por float.

### Garantias no schema

| Garantia | Como |
|---|---|
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` na wallet, `balance_before/after >= 0` no ledger |
| Idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Referência na mesma wallet | FK composta `(reference_transaction_id, wallet_id) → (id, wallet_id)` |
| Uma reversão por tipo | único parcial `(reference_transaction_id, kind) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| Um OPENING por wallet | único parcial `(wallet_id) WHERE kind = 'OPENING'` |
| Regras por kind e status | `CHECK`s: reversão exige referência, valor zero só em LOSS, `failure_code` só em REJECTED/FAILED etc |
| Lançamento coerente | `UNIQUE (transaction_id, wallet_id)`, FKs compostas pra transação e moeda, `CHECK (balance_after = balance_before ± amount)` |
| Ledger imutável | trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE` |
| Transação imutável | trigger: terminal não muda, campo do provedor nunca muda, não apaga |
| Dedup da inbox | `PRIMARY KEY (consumer_name, message_id)` |

Os triggers usam `ERRCODE = 'restrict_violation'` (23001). Assim a aplicação separa imutabilidade (23001), check
(23514) e duplicado (23505).

O `balance_after` da transação tá na moeda da wallet. Uma operação em USD recusada numa wallet BRL guarda o saldo em BRL.

### Índices

Só pras queries que existem, e conferi cada um com `EXPLAIN`:

| Índice | Atende |
|---|---|
| `outbox_pending_ix (sequence) WHERE published_at IS NULL` | publisher buscando pendentes em ordem |
| `wager_tx_pending_reference_due_ix (next_reference_check_at) WHERE status = 'PENDING_REFERENCE'` | worker buscando o que venceu o backoff |
| `wager_tx_waiting_for_reference_ix (provider_id, reference_external_transaction_id) WHERE status = 'PENDING_REFERENCE'` | achar quem esperava uma transação que acabou de chegar |
| `ledger_wallet_sequence_ix (wallet_id, sequence)` | paginação do ledger e reconciliação |

Ledger e outbox têm `sequence` `GENERATED ALWAYS AS IDENTITY`, que serve de cursor estável sem depender de relógio. Os
índices não usam `CONCURRENTLY` porque a migration inicial roda em transação com tabela vazia. Em produção, com dado, seria
uma migration separada.

---

## 6. Processamento e API

### Fluxo de uma operação

HTTP e fila chamam o mesmo `ProcessWagerTransaction`, numa transação SQL só:

1. valida dinheiro e kind e calcula o `payloadHash`, ainda sem transação;
2. se veio da fila, grava a inbox. Já tava lá, para;
3. trava a wallet com `SELECT ... FOR UPDATE`. Não existe, 404;
4. procura pela key ou por `(providerId, externalTransactionId)`. Mesma key e mesmo hash é replay, qualquer outra coisa é 409;
5. cria a `WagerTransaction`, busca a referência e roda o `WagerSettlement`;
6. grava transação, saldo (`UPDATE ... WHERE version = ?`), lançamento e outbox;
7. commit, e só aí sai a resposta ou o ack.

### Concorrência

Lock pessimista por wallet. Operações da mesma wallet fazem fila no banco, wallets diferentes rodam em paralelo, e não
existe lock global. Escolhi pessimista porque numa hot wallet o otimista vira retry em cascata. Cada transação trava uma
wallet só, então deadlock não tem como acontecer. O `UPDATE` ainda confere a `version`, e se não bater a resposta é 503.

O `SET LOCAL lock_timeout` (5s, `DB_LOCK_TIMEOUT_MS`) existe porque quem espera o lock segura uma conexão do pool. Sem
limite, uma wallet travada prenderia o pool inteiro e derrubaria as outras junto (achado 3). Quem passa do tempo leva
503 com `Retry-After` e nada é gravado.

O isolamento é `READ COMMITTED`. Depois do lock, cada SELECT já enxerga o que a transação anterior da wallet commitou.

**Corrida de idempotência.** Mesma key com `walletId` diferente trava wallets diferentes, e as duas passam pela checagem
juntas. Aí a unique barra a segunda, o rollback desfaz tudo e o use case tenta mais **uma** vez, quando acha a primeira
e vira replay ou 409.

### Referências fora de ordem

`REFUND`, `ROLLBACK` ou `WIN` que chega antes da referência fica `PENDING_REFERENCE` e responde 202. O
`PendingReferenceWorker` resolve depois. Em cada ciclo ele:

1. busca os vencidos pelo índice parcial, os mais atrasados primeiro;
2. abre uma transação por id, trava a **wallet** e só depois relê a transação. É a mesma ordem de lock do HTTP e da
   fila. Se outro worker já resolveu, pula;
3. decide. Referência decidida: aplica o `WagerSettlement`. Ausente com tentativa sobrando: agenda de novo (2s a 5 min).
   Ausente na 10ª tentativa: `REJECTED` com `REFERENCE_NOT_FOUND`;
4. grava, e se terminou, os eventos vão pra outbox na mesma transação.

Uma transação com problema não trava as outras. Ela continua vencida e volta no próximo ciclo. O
`WagerTransactionPendingReference` sai uma vez só, quando fica pendente. Senão uma referência que nunca chega geraria
10 eventos iguais.

**Acordar quem espera.** Quando qualquer transação termina, um `UPDATE` pelo `wager_tx_waiting_for_reference_ix` puxa
pra agora o próximo check de quem esperava por ela (achado 4). Vale na entrada direta e no worker, porque um `REFUND`
resolvido pode ser referência de um `ROLLBACK`.

### Status HTTP

| Situação | Status |
|---|---|
| Processada, inclusive replay | 200 `{ transactionId, status, balance, idempotentReplay }` |
| Rejeitada por regra de negócio | 422, mesmo corpo + `failureCode` |
| Aguardando referência | 202, `balance: null` |
| Payload, header ou cursor inválido | 400 `INVALID_PAYLOAD` |
| Wallet ou transação inexistente | 404 |
| Mesma key com outro payload, wallet duplicada | 409 |
| Banco fora, lock timeout, deadlock | 503 + `Retry-After` |

O replay devolve o status original, então uma rejeição reenviada continua 422 e o provedor decide só pelo status.
Rejeição não é exceção: a transação foi aceita, decidida e gravada como `REJECTED`, e o corpo é o de sempre com o
`failureCode` a mais.

### Outras decisões da API

- O DTO valida tipo, UUID, kind e campo desconhecido. O formato do dinheiro fica com o `Money.from`, pra regra não
  morar em dois lugares.
- `Idempotency-Key` obrigatória no header, até 255 caracteres.
- Ledger paginado por cursor opaco, `base64url` da `sequence`. Padrão 50, máximo 200.
- A reconciliação compara saldo com a soma do ledger. Divergência vira log e `consistent: false`, nunca correção. É
  `POST` porque tem efeito: log e métrica.
- Wallet com saldo inicial gera `OPENING` e `CREDIT` na mesma transação, com os eventos de sempre. Saldo zero não gera
  nada.
- IDs em UUID v7, ordenados por tempo, o que deixa o índice da PK compacto.

---

## 7. Observabilidade

### Logs

O `JsonLogger` substitui o logger do Nest desde o boot e escreve uma linha JSON por entrada. Objeto passado como
mensagem vira campo, então dá pra filtrar por id sem regex.

- requisição HTTP: `correlationId`, `method`, `path`, `status`, `durationMs`, `walletId`, `providerId`, `transactionId`;
- mensagem da fila: `messageId`, `correlationId`, `transactionId`, `walletId`, `providerId`, `outcome`;
- reconciliação divergente e falhas dos workers, com os ids envolvidos.

O `correlationId` vem do `x-correlation-id` ou é gerado, volta no header da resposta e vai pros eventos. Na fila o
`messageId` faz esse papel.

O código só loga id, nunca valor. Por garantia o `JsonLogger` troca por `[redacted]` qualquer campo `amount`, `balance`,
`money`, `difference`, `payload`, `body`, `authorization` ou `password`, em qualquer profundidade. Um teste confere que
nenhuma linha da suíte carrega os valores usados.

### Métricas

`GET /metrics`, formato Prometheus, por instância e sem auth.

| Métrica | Tipo |
|---|---|
| `wagering_transactions_total{channel, kind, status}` | counter |
| `wagering_duplicates_total{type}`: `idempotent_replay`, `inbox_message` | counter |
| `wagering_retries_total{source}`: `sqs_consumer`, `outbox`, `pending_reference` | counter |
| `wagering_dead_letters_total{reason}` | counter |
| `wagering_dlq_depth` | gauge |
| `wagering_lock_conflicts_total{type}`: `lock_timeout`, `deadlock`, `version_mismatch`, `idempotency_race` | counter |
| `wagering_outbox_pending` e `wagering_outbox_lag_seconds` | gauge |
| `wagering_processing_duration_seconds{channel, outcome}` | histogram |
| `wagering_reconciliation_divergences_total` | counter |

Os use cases só conhecem a porta `Metrics`, e o `PrometheusMetrics` implementa. Os gauges de outbox e DLQ são lidos do
banco e do SQS na hora do scrape. Assim não desviam se um processo morrer, e a DLQ conta até o que chegou pelo redrive.
Cada instância tem registry próprio, o que evita conflito de nome quando os testes sobem várias apps no mesmo processo.

### Health checks

`/health/live` não toca em nada externo. `/health/ready` confere Postgres e a fila de entrada, com timeout, e responde
503 se algum cair.

---

## 8. Autenticação

**Não implementei.** O enunciado diz que não pontua e que não deve competir com correção, concorrência e idempotência.

O ponto de extensão é o `ProviderAuthGuard` (`src/interfaces/http/provider-auth.guard.ts`). Ele tá nas rotas de wallet
e de transação e hoje libera tudo. Health e metrics ficam fora.

O desenho que eu faria, com Keycloak ou Zitadel no Compose:

1. cada provedor é um client OIDC e pega token por `client_credentials`;
2. o guard valida o JWT pelo JWKS do IdP e confere `iss`, `aud` e `exp`;
3. o provedor do token vira o `providerId` da requisição. Corpo com outro `providerId` leva 403. Hoje o corpo é
   confiado;
4. wallet e reconciliação pedem papel de operador.

A fila é canal interno confiável, como o enunciado define, mas o provedor da mensagem passa pelas mesmas validações de
domínio.

---

## 9. Códigos de falha

Ficam em `failure_code`. Reenviar a mesma key devolve sempre o resultado original, então corrigir é mandar uma
transação nova.

| Código | Quando | Pro provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | não reenviar |
| `REVERSAL_WOULD_OVERDRAW` | ROLLBACK de WIN/REFUND deixaria saldo negativo | tratamento operacional |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da wallet | corrigir payload |
| `WALLET_PLAYER_MISMATCH` | `playerId` não é dono da wallet | corrigir payload |
| `REFERENCE_NOT_FOUND` | referência não chegou no limite de tentativas | desistir |
| `REFERENCE_MISMATCH` | referência de outro provider, player, wallet, moeda ou rodada | corrigir payload |
| `REFERENCE_KIND_NOT_ALLOWED` | tipo de referência não permitido, tipo REFUND de um WIN | corrigir payload |
| `REFERENCE_NOT_PROCESSED` | referência terminou REJECTED/FAILED | desistir |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida pelo mesmo tipo | desistir |
| `REFERENCE_AMOUNT_MISMATCH` | valor da reversão ≠ valor da referência | corrigir payload |
| `PERMANENT_PROCESSING_FAILURE` | erro permanente de infra, status `FAILED` | investigar |

---

## 10. Interpretações das regras

| Ambiguidade | O que fiz |
|---|---|
| Quem aceita referência | `REFUND` e `ROLLBACK` exigem. `WIN` e `LOSS` aceitam, só de `BET`. `BET` com referência é payload inválido |
| "Revertida duas vezes **pelo mesmo tipo**" | Literal: no máximo um `REFUND` e um `ROLLBACK` por referência. Uma `BET` pode ser creditada duas vezes (seção 12) |
| Referência existe mas tá pendente | Conta como ausente. Se esgotar assim, `REFERENCE_NOT_FOUND` |
| Limite de espera | 10 tentativas, uns 18 min. Provedor manda a referência em segundos, e quem espera é acordado quando ela chega |
| Referência `REJECTED`/`FAILED` | `REFERENCE_NOT_PROCESSED` na hora |
| Valor zero | só `LOSS` |
| `playerId` diferente do dono | `REJECTED` com `WALLET_PLAYER_MISMATCH`, gravado |
| Erro permanente da fila | payload inválido, wallet inexistente e conflito de key vão direto pra DLQ |
| Status `FAILED` | Nenhuma rota grava hoje. Mensagem que esgota tentativas por infra nunca commitou nada, então não tem linha pra marcar. O registro dela é a DLQ, com o motivo no atributo `reason`, e o log |
| `correlationId` vindo da fila | A mensagem não tem. O `messageId` vira `correlationId` e `causationId` dos eventos |
| Destino da outbox | `wager-events.fifo`, grupo `walletId`, dedup `eventId` |
| Formato dos ids | `playerId` e `walletId` são UUID como nos exemplos. Os outros são texto livre |

---

## 11. Testes

### Teste antes do código

Da Fase 2 em diante o teste veio antes: escrevo, vejo falhar, implemento até passar. Assim ele descreve o
comportamento e não espelha o código. A Fase 1, o domínio, foi código primeiro e teste logo depois. Os testes da Fase 7
são de caracterização, conferem garantias das fases anteriores e já nasceram verdes. Pra ter certeza de que o de
reinício não passava por sorte, ele exige ao menos um failover.

### Achados

1. **Débito duplicado ao reaplicar transação (Fase 1).** O teste esperava erro ao reaplicar uma BET processada. O erro
   vinha, mas a wallet já tinha sido debitada. O `WagerSettlement` mexia no saldo antes da transição de estado. Agora
   checa se é terminal antes de qualquer mutação.
2. **Data chegando como string (Fase 3).** Os e2e de consulta davam 500 com `createdAt.toISOString is not a function`.
   O driver do MikroORM devolve `timestamptz` como string, ao contrário do `pg` puro. Os mappers convertem com `toDate`.
3. **Hot wallet esgotando o pool (Fase 3).** Quem espera `FOR UPDATE` segura conexão, e uma wallet travada prende o
   pool inteiro. Um e2e trava a wallet por outra conexão e manda aposta: antes ficava pendurada até o timeout do teste.
   A correção foi o `lock_timeout`.
4. **Índice que ninguém usava (Fase 6).** O `wager_tx_waiting_for_reference_ix` nasceu na Fase 2 e nenhuma query usava.
   Por trás disso, uma pendente só era reavaliada no fim do backoff, mesmo com a referência já lá, até 64s à toa. O
   teste empurra o backoff pra longe, manda a referência e espera resolver sem o relógio andar.

### Camadas

| Tipo | Onde | Usa |
|---|---|---|
| Unidade | `test/unit` | só domínio, milissegundos |
| Integração | `test/integration` | Postgres e LocalStack reais, sem mock |
| Concorrência | `test/concurrency` | três processos `bun src/main.ts` em portas livres, mesmo banco e mesmas filas |

Cada arquivo de integração começa com migration down → up. `TRUNCATE` não serve, porque o ledger bloqueia, e é pra
bloquear mesmo. Os testes de schema violam cada garantia via SQL e conferem o código de erro **e o nome da
constraint**, pra não passar por acidente graças a outra regra.

Toda suíte termina conferindo `balance == ledger` pra **todas** as wallets do banco. Ficam fora só a de schema, que
insere linha crua, e a de wallets, que corrompe um saldo pra provar que a reconciliação acha.

Os testes de concorrência disparam tudo junto com `Promise.all`. O cliente que distribui as requisições entre os três
processos age como provedor: se a instância cai ou dá 503, reenvia pra próxima com a mesma key.

### Cobertura da seção 13 do enunciado

| Cenário | Onde |
|---|---|
| A mesma aposta 50 vezes em paralelo | `wagering.e2e`, e 60 vezes entre 3 processos em `multi-instance` |
| Disputa de saldo, o 100 / 80 / 80 | `wagering.e2e`, e 30 apostas pra um saldo de 10 entre 3 processos |
| Wallets distintas em paralelo | `wagering.e2e`: com a A travada, a B responde em menos de 250ms |
| Três ou mais processos | `multi-instance`, HTTP e fila |
| Worker morto entre commit e ack | `sqs-consumer` simulando, `multi-instance` matando de verdade |
| Dois publishers na mesma outbox | `outbox-publisher`, pools separados |
| `ROLLBACK`/`REFUND` antes da referência | `pending-reference` e `pending-reference.e2e` |
| Reinício com consistência final | `multi-instance` |

O de reinício: 10 wallets, 200 apostas, metade HTTP e metade fila. Com 40 processadas, `SIGKILL` numa instância e sobe
ela de novo. Espera fila vazia, inclusive o que tava em voo e só volta depois de 30s, e outbox publicada. No fim:
20 débitos e saldo certo por wallet, DLQ vazia, `balance == ledger` e pelo menos um failover.

---

## 12. Limitações conhecidas

- **Reversão por tipo.** Seguindo o enunciado, uma `BET` pode receber `REFUND` e também `ROLLBACK` direto e ser
  creditada duas vezes. Com mais contexto do domínio eu limitaria a uma reversão por referência.
- **`NUMERIC(19,2)` arredonda calado** um valor com mais casas antes de qualquer `CHECK`. Por isso a escala é validada
  no `Money.from`.
- **Saldo == ledger não é constraint**, exigiria somar o ledger a cada escrita. A aplicação grava os dois juntos e a
  reconciliação confere.
- **Usuário do banco.** Em dev o app é dono das tabelas. Em produção, um role sem `UPDATE`/`DELETE` no ledger seria
  outra barreira além do trigger.
- **Ordem dos eventos é melhor esforço.** Com várias instâncias, dois eventos da mesma wallet podem sair em lotes
  diferentes e fora de ordem. Quem precisa de ordem estrita usa o `walletVersion`.
- **Lote da outbox com transação aberta** durante as chamadas ao SQS. Morreu no meio, o rollback devolve tudo, o que é
  simples e seguro. O custo é limitado pelo tamanho do lote, pelo timeout de 5s e por parar no primeiro erro. A
  alternativa é lease com `claimed_until`.
- **Visibility do lote no consumer.** São até 10 mensagens processadas uma por vez, com os 30s contando do receive pra
  todas. Se várias baterem no `lock_timeout`, as últimas podem reaparecer pra outra instância. A inbox e o lock seguram
  a correção, mas sobra retrabalho. Não renovei a visibility porque não consegui um teste que falhasse sem mexer no timeout
  que os outros testes usam.
- **DLQ não é atômica.** Mandar pra DLQ e apagar da fila são duas chamadas. Morrendo no meio, a mensagem vai de novo,
  e fora da janela de 5 min de dedup aparece duplicada na DLQ. Pra análise humana isso é aceitável.
- **Hot wallet.** O throughput de uma wallet é o de uma transação por vez. É a troca por correção. Sob contenção forte
  parte leva 503 e o provedor reenvia com a mesma key.
- **Windows não tem `SIGTERM` real** entre processos. O desligamento gracioso é testado dentro do processo e o teste
  multi-processo cobre a morte abrupta.
- **LocalStack não é AWS.** Latência, precisão do visibility timeout e throttling podem divergir, IAM não é checado e
  as filas somem quando o container reinicia. A correção não depende disso, porque o estado tá no banco. Em produção bastaria
  tirar o `AWS_ENDPOINT_URL` e passar credenciais reais.

---

## 13. O que eu faria com mais tempo

- **Branded types pros ids**, pra um `WalletId` não passar onde se espera `TransactionId`. Hoje todos são `string`.
- **OpenAPI/Swagger** a partir dos DTOs.
- **Renovar a visibility** de cada mensagem antes de processar e rodar grupos diferentes do lote em paralelo.
- **Autenticação de verdade** com Keycloak, seguindo a seção 8.
- **Dashboard e alertas**: outbox lag subindo, DLQ com mensagem, `lock_timeout` alto e divergência de reconciliação,
  que deveria ser sempre zero.
