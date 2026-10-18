import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { IdGenerator } from '../../application/ports';
import { CreateWallet } from '../../application/use-cases/create-wallet';
import { GetWallet, GetWalletLedger, ReconcileWallet } from '../../application/use-cases/queries';
import { ID_GENERATOR } from '../../infrastructure/tokens';
import { CreateWalletDto, LedgerQueryDto } from './dto';
import { presentLedgerItem, presentReconciliation, presentWallet } from './presenters';
import { traceFrom } from './request-context';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(GetWallet) private readonly getWallet: GetWallet,
    @Inject(GetWalletLedger) private readonly getWalletLedger: GetWalletLedger,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post()
  async create(@Body() body: CreateWalletDto, @Headers('x-correlation-id') correlationId?: string) {
    const wallet = await this.createWallet.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
      trace: traceFrom(correlationId, this.ids),
    });
    return presentWallet(wallet);
  }

  @Get(':walletId')
  async findOne(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return presentWallet(await this.getWallet.execute(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId', ParseUUIDPipe) walletId: string, @Query() query: LedgerQueryDto) {
    const page = await this.getWalletLedger.execute(walletId, query.cursor, query.limit);
    return { items: page.items.map(presentLedgerItem), nextCursor: page.nextCursor };
  }

  // POST pq é uma verificação sob demanda que loga e conta divergência, não uma leitura pura
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return presentReconciliation(await this.reconcileWallet.execute(walletId));
  }
}
