// codigos de falha estaveis e padronizados
export enum FailureCode {
// BET maior que o saldo
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
// ROLLBACK de WIN/REFUND deixaria o saldo negativo
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
// Moeda da operação diferente da moeda da wallet, tem q corrigir o payload
  CurrencyMismatch = 'CURRENCY_MISMATCH',
// playerId não é o dono da wallet
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
// ref não chegou dentro do limite de tentativas
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
// ref de outro player, wallet, moeda ou rodada
  ReferenceMismatch = 'REFERENCE_MISMATCH',
// tipo não pode referenciar o kind alvo
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
// ref terminou REJECTED/FAILED
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
// ref já revertida por este tipo de operação
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
// valor da reversão diferente do valor da referência
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
// erro permanente ao processar, precisa ser investigado
  PermanentProcessingFailure = 'PERMANENT_PROCESSING_FAILURE',
}
