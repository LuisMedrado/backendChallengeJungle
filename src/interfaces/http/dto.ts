import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { LEDGER_MAX_LIMIT } from '../../application/use-cases/queries';

// formato do amount é validado pelo Money.from no domínio, aqui só o tipo
export class MoneyDto {
  @IsString()
  amount!: string;

  @IsString()
  currency!: string;
}

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

// OPENING fica de fora, é só interno
const SUBMITTABLE_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'];

export class SubmitWagerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  gameId!: string;

  @IsIn(SUBMITTABLE_KINDS)
  kind!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  referenceExternalTransactionId?: string;
}

export class LedgerQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LEDGER_MAX_LIMIT)
  limit?: number;
}
