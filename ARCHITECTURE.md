# ARCHITECTURE — Distributed Wagering Processor

## [INDICE]

1. [Overview](#1-visão-geral)
2. [Stack](#2-stack-e-ambiente-local)
3. [Mensageria](#3-mensageria-sqs)
4. [Limitações](#4-limitações-conhecidas)
5. [O que eu faria com mais tempo](#5-o-que-eu-faria-com-mais-tempo)

---

## 1. Visão geral

Serviço que recebe operações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) por HTTP e SQS,
aplica cada uma exatamente uma vez sobre a wallet do jogador e publica eventos de integração.

Parte do princípio que o banco domina a verdade sobre os estados. Recursos do broker (FIFO, deduplicação por exemplo) são otimização,
as garantias de unicidade, imutabilidade e not null ficam em constraints do banco.

---

## 2. Stack e ambiente local

| Item | Escolha | Motivo |
|---|---|---|
| Runtime / pacotes / testes | Bun 1.x | Exigido no projeto, executa TypeScript e carrega as deps. |
| Framework | NestJS 11 | Exigido no projeto, DI e hooks (como o `enableShutdownHooks`) usados no shutdown. |
| Banco | PostgreSQL 17 | Exigido no projeto, Versão estável atual. |
| Mensageria | LocalStack 4.4 (SQS) | Exigido (LocalStack ou MiniStack). Tem limitações, descritas na seção 14. |
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
  - `noImplicitOverride`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`.
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

## 4. Limitações conhecidas

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

## 5. O que eu faria com mais tempo

- _[quando terminar preciso lembrar de preencher]_
