import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { IdGenerator } from '../../application/ports';
import { ProcessWagerTransaction } from '../../application/use-cases/process-wager-transaction';
import { GetWagerTransaction } from '../../application/use-cases/queries';
import { ID_GENERATOR } from '../../infrastructure/tokens';
import { SubmitWagerDto } from './dto';
import { httpStatusFor, presentSubmitResult, presentTransaction } from './presenters';
import { requireIdempotencyKey, traceFrom } from './request-context';

interface StatusResponse {
  status(code: number): unknown;
}

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(GetWagerTransaction) private readonly getTransaction: GetWagerTransaction,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: SubmitWagerDto,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    const result = await this.processWager.execute({
      ...body,
      idempotencyKey: requireIdempotencyKey(idempotencyKey),
      trace: traceFrom(correlationId, this.ids),
    });
    // replay devolve o msm status da resposta original
    response.status(httpStatusFor(result.transaction));
    return presentSubmitResult(result);
  }

  @Get('wagering/transactions/:transactionId')
  async findById(@Param('transactionId', ParseUUIDPipe) transactionId: string) {
    return presentTransaction(await this.getTransaction.byId(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return presentTransaction(await this.getTransaction.byExternalId(providerId, externalTransactionId));
  }
}
