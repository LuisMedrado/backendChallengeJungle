import { describe, expect, it } from 'bun:test';
import { Logger } from '@nestjs/common';
import { JsonLogger } from '../../../src/infrastructure/observability/json-logger';

function capture() {
  const lines: string[] = [];
  const logger = new JsonLogger((line) => lines.push(line));
  const entries = () => lines.map((line) => JSON.parse(line));
  return { logger, lines, entries };
}

describe('JsonLogger', () => {
  it('escreve uma linha JSON por entrada com nível, contexto, hora e mensagem', () => {
    const { logger, lines, entries } = capture();
    logger.log('subiu', 'Bootstrap');

    expect(lines).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ level: 'info', context: 'Bootstrap', msg: 'subiu' });
    expect(Number.isNaN(Date.parse(entries()[0].time))).toBe(false);
  });

  it('objeto vira campos estruturados, não texto', () => {
    const { logger, entries } = capture();
    logger.log(
      { msg: 'transação decidida', correlationId: 'c-1', transactionId: 't-1', walletId: 'w-1', providerId: 'p-1' },
      'Wagering',
    );
    expect(entries()[0]).toMatchObject({
      level: 'info',
      msg: 'transação decidida',
      correlationId: 'c-1',
      transactionId: 't-1',
      walletId: 'w-1',
      providerId: 'p-1',
    });
  });

  it('redige campos financeiros e sensíveis, inclusive aninhados', () => {
    const { logger, lines, entries } = capture();
    logger.warn(
      {
        msg: 'algo',
        walletId: 'w-1',
        money: { amount: '25.00', currency: 'BRL' },
        balance: '975.00',
        details: { amount: '10.00', payload: { secret: 1 }, authorization: 'Bearer x' },
      },
      'Teste',
    );

    expect(lines[0]).not.toContain('25.00');
    expect(lines[0]).not.toContain('975.00');
    expect(lines[0]).not.toContain('10.00');
    expect(lines[0]).not.toContain('Bearer');
    expect(entries()[0]).toMatchObject({
      level: 'warn',
      walletId: 'w-1',
      money: '[redacted]',
      balance: '[redacted]',
      details: { amount: '[redacted]', payload: '[redacted]', authorization: '[redacted]' },
    });
  });

  it('erro leva o stack junto', () => {
    const { logger, entries } = capture();
    logger.error('quebrou', 'Error: quebrou\n    at x', 'Teste');
    expect(entries()[0]).toMatchObject({ level: 'error', msg: 'quebrou', context: 'Teste' });
    expect(entries()[0].stack).toContain('at x');
  });

  it('funciona como logger do nest pela classe Logger', () => {
    const { logger, entries } = capture();
    Logger.overrideLogger(logger);
    try {
      new Logger('Contexto').log({ msg: 'via nest', messageId: 'm-1' });
    } finally {
      Logger.overrideLogger(false);
    }
    expect(entries()[0]).toMatchObject({ level: 'info', context: 'Contexto', msg: 'via nest', messageId: 'm-1' });
  });
});
