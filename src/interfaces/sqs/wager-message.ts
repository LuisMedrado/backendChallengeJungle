import { plainToInstance, Type } from 'class-transformer';
import { Equals, IsDefined, IsISO8601, IsNotEmpty, IsString, MaxLength, ValidateNested, validate } from 'class-validator';
import { SubmitWagerDto } from '../http/dto';

// msmos campos do POST /wagering/transactions, mais a idempotencyKey que na fila vem no corpo
export class WagerMessageDataDto extends SubmitWagerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  idempotencyKey!: string;
}

// formato de mensagem definido no enunciado
export class WagerTransactionRequestedMessage {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  messageId!: string;

  @Equals('WagerTransactionRequested')
  type!: string;

  @IsISO8601()
  occurredAt!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => WagerMessageDataDto)
  data!: WagerMessageDataDto;
}

export class InvalidMessageError extends Error {}

export async function parseWagerMessage(body: string): Promise<WagerTransactionRequestedMessage> {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new InvalidMessageError('corpo da mensagem não é JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidMessageError('corpo da mensagem não é um objeto');
  }

  const message = plainToInstance(WagerTransactionRequestedMessage, raw);
  // campo a mais vindo do produtor é ignorado, não recusado, pra não quebrar com versão nova da mensagem
  const errors = await validate(message, { whitelist: true });
  if (errors.length > 0) {
    throw new InvalidMessageError(`mensagem inválida: ${errors.map((e) => e.property).join(', ')}`);
  }
  return message;
}
