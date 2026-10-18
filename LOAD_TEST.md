# Teste de carga

```bash
bun run test:load
```

Precisa da infra de pé (`bun run infra:up`). O script zera o banco `wagering_test` e esvazia as filas, então não roda
junto com a suíte de testes. Leva uns 3 minutos e grava o relatório bruto em `load-test-results.md`. Os parâmetros
mudam por variável de ambiente: `LOAD_DURATION_SECONDS`, `LOAD_WARMUP_SECONDS`, `LOAD_CONCURRENCY`, `LOAD_WALLETS` e
`LOAD_QUEUE_MESSAGES`.

O código fica em `test/load/`. As funções de percentil e de leitura do `/metrics` têm teste próprio
(`test/load/stats.test.ts`), escrito antes delas.

## Ambiente

- Intel i7-12700H (20 threads), 24 GB de RAM, Windows 11 com Docker Desktop
- Bun 1.4.3, PostgreSQL 17.11 e LocalStack 4.4 em container
- 3 instâncias da aplicação, cada uma com o pool padrão do MikroORM, até 10 conexões
- gerador de carga, aplicação, Postgres e LocalStack na mesma máquina

## Metodologia

- **Malha fechada.** 32 clientes, cada um manda a próxima aposta assim que a anterior volta. Sem retry, então um 503
  aparece como erro e não some.
- **3s de aquecimento** fora da conta, depois **20s medidos** por cenário.
- Toda requisição é uma `BET` de 1.00 com idempotency key nova, em rodízio entre as 3 instâncias. As wallets começam
  com 1.000.000,00, pra nenhuma aposta ser rejeitada por saldo e a medida ser só do caminho feliz.
- **Latência no cliente**, do envio ao fim da resposta. A média do servidor vem do histograma
  `wagering_processing_duration_seconds`.
- **Conflitos de lock** são a diferença do `wagering_lock_conflicts_total` das 3 instâncias antes e depois.
- **Outbox lag** amostrado no `/metrics` a cada 500ms. A vazão da outbox é medida no banco, do primeiro evento do
  cenário até o último publicado. Cada cenário só começa com a outbox zerada, pra o backlog de um não contaminar o
  próximo.
- **Correção conferida no fim de cada cenário:** BETs `PROCESSED` no banco tem que ser igual ao número de respostas
  200, e saldo == ledger em todas as wallets.

Três cenários:

1. **distribuído:** carga espalhada em 200 wallets;
2. **hot wallet:** toda a carga numa wallet só;
3. **fila:** 2000 mensagens jogadas no `wager-transactions.fifo` por 25 produtores, em 50 wallets, com os 3 consumers
   ligados.

## Resultado

Rodada de 18/10/2026.

| | distribuído | hot wallet |
|---|---|---|
| requisições medidas | 18.600 | 2.251 |
| throughput | **930 req/s** | **112 req/s** |
| p50 / p95 / p99 | 33 / 48 / 55 ms | 328 / 413 / 446 ms |
| máximo | 79 ms | 509 ms |
| média no servidor | 33 ms | 282 ms |
| taxa de erro | 0% | 0% |
| `lock_timeout` / `version_mismatch` / deadlock | 0 / 0 / 0 | 0 / 0 / 0 |
| eventos gerados | 42.020 | 5.234 |
| vazão da outbox | **459 eventos/s** | 225 eventos/s |
| outbox pendente máx. | **36.236** | 24 |
| outbox lag máx. | **68,4 s** | 0,15 s |
| outbox zerada depois da carga | 68,6 s | 0,1 s |
| correção | ok | ok |

| fila | |
|---|---|
| throughput | **130 msg/s** |
| tempo pra enfileirar as 2000 | 3,7 s |
| tempo até processar todas | 15,3 s |
| p50 / p95 / p99, do envio ao `processed_at` | 7,3 / 11,5 / 11,9 s |
| DLQ / duplicatas pela inbox | 0 / 0 |
| correção | ok |

Uma rodada anterior, idêntica, deu 781 req/s no distribuído e 105 no hot wallet. Então a variação entre rodadas fica
na casa de 15%, e os números acima valem como ordem de grandeza, não como medida fina.

## Análise

**Correção não cedeu.** Nos três cenários, cada resposta 200 virou exatamente uma BET no banco, o saldo bateu com o
ledger em todas as wallets e nada caiu na DLQ. Nenhum `version_mismatch` nem deadlock, o que confirma que o lock por
wallet já serializa tudo antes do `UPDATE` com version.

**O gargalo é a outbox.** No distribuído a aplicação gerou uns 1.830 eventos/s, dois por aposta, e a outbox publicou
459/s. A fila de eventos cresceu sem parar enquanto durou a carga: 36 mil pendentes e 68s de lag no pico, e mais 68s
pra zerar depois que a carga parou. Nenhum evento se perdeu, mas um consumidor dos eventos veria o saldo com mais de um
minuto de atraso. A causa é o desenho do publisher: um `SendMessage` por evento, um depois do outro, dentro da
transação do lote. As 3 instâncias somadas chegam a uns 460/s. No hot wallet a vazão de 225/s é só o ritmo em que os
eventos nasceram, não o limite.

O que eu faria, nessa ordem: `SendMessageBatch`, que manda 10 eventos por chamada, e publicar lotes de grupos
diferentes em paralelo. Os dois são seguros pelo `eventId` estável e pela deduplicação do SQS, mas exigem tratar
falha parcial sem quebrar a ordem por wallet.

**Hot wallet é o lock funcionando.** Com uma wallet só, as operações fazem fila no `FOR UPDATE`. 112 req/s dá uns 9ms
por transação serializada, e com 32 clientes esperando a latência fica perto de 32 × 10ms, que é o p50 de 328ms. É a
troca escolhida: correção em vez de throughput numa wallet. Não apareceu `lock_timeout` porque a espera ficou bem abaixo
dos 5s. E tem um limite que o teste mostra de quebra: só 30 transações esperam o lock ao mesmo tempo, uma por conexão
das 3 instâncias. O resto espera conexão no pool, não lock, então aumentar os clientes estoura primeiro o tempo de
aquisição do pool, e não o `lock_timeout`.

**A fila consome devagar.** Os 25 produtores enfileiraram as 2000 mensagens em 3,7s, uns 540/s, e os consumers
processaram 130/s. A latência de 7 a 12s é quase toda espera na fila. Cada instância processa as mensagens do lote uma
por vez, com receive, transação e delete em sequência, o que dá uns 23ms por mensagem e uns 43/s por instância.
Processar grupos diferentes do lote em paralelo atacaria isso direto.

**Distribuído escala até a máquina.** 930 req/s com p99 de 55ms e nenhum conflito. A média do servidor, 33ms, é quase o
p50 do cliente, então quase todo o tempo é dentro da aplicação. Com tudo dividindo a mesma CPU, esse número diz mais
sobre o notebook do que sobre o serviço.

## O que esse teste não prova

- **Tudo na mesma máquina.** O gerador de carga, as 3 instâncias, o Postgres e o LocalStack disputam as mesmas 20
  threads. Com o banco numa máquina separada, os números mudariam, provavelmente pra cima.
- **LocalStack não é SQS.** A latência de cada chamada é a de um container local, e não tem throttling. No SQS real cada
  `SendMessage` custa mais, o que deixaria o gargalo da outbox pior.
- **Docker Desktop no Windows** passa o Postgres por uma VM, com overhead de rede e disco que um Linux não teria.
- **Só caminho feliz.** Toda aposta é uma BET aprovada. Não tem rejeição, referência fora de ordem, replay nem mistura
  de kinds.
- **20s é pouco.** Não mostra autovacuum, crescimento de índice nem o ledger com milhões de linhas.
- **Log por requisição.** Cada instância grava uma linha JSON por requisição num arquivo, o que pesa no throughput.
- **Poucas rodadas.** Foram duas, com uns 15% de diferença. Pra comparar mudanças eu rodaria várias vezes e olharia a
  mediana.
