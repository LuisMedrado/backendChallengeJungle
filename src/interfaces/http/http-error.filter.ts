import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import {
  ConcurrentModificationError,
  IdempotencyConflictError,
  InvalidRequestError,
  TransientInfrastructureError,
  WagerTransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import { CurrencyMismatchError, InvalidMoneyError, InvalidWagerTransactionError } from '../../domain/shared/errors';

interface HttpResponseLike {
  status(code: number): HttpResponseLike;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

interface ErrorMapping {
  status: number;
  code: string;
  message: string;
}

// um formato só de erro pra api inteira: { error: { code, message } }
// rejeição de regra de negócio não passa por aqui, ela é resposta normal com 422
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponseLike>();
    const { status, code, message } = this.map(exception);

    if (status >= 500) this.logger.error(`${code}: ${message}`, exception instanceof Error ? exception.stack : undefined);
    // falha transitória: provedor pode reenviar a msm requisição depois
    if (status === 503) response.setHeader('Retry-After', '1');
    response.status(status).json({ error: { code, message } });
  }

  private map(exception: unknown): ErrorMapping {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { status, code: status === 400 ? 'INVALID_PAYLOAD' : status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR', message: messageOf(exception) };
    }
    if (
      exception instanceof InvalidRequestError ||
      exception instanceof InvalidMoneyError ||
      exception instanceof InvalidWagerTransactionError ||
      exception instanceof CurrencyMismatchError
    ) {
      return { status: 400, code: 'INVALID_PAYLOAD', message: exception.message };
    }
    if (exception instanceof WalletNotFoundError || exception instanceof WagerTransactionNotFoundError) {
      return { status: 404, code: exception.code, message: exception.message };
    }
    if (exception instanceof WalletAlreadyExistsError || exception instanceof IdempotencyConflictError) {
      return { status: 409, code: exception.code, message: exception.message };
    }
    if (exception instanceof TransientInfrastructureError || exception instanceof ConcurrentModificationError) {
      return { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'indisponibilidade temporária, tente novamente' };
    }
    // não vaza stack nem detalhe interno pro cliente
    return { status: 500, code: 'INTERNAL_ERROR', message: 'erro interno' };
  }
}

function messageOf(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  const message = (body as { message?: unknown }).message;
  return Array.isArray(message) ? message.join('; ') : String(message ?? exception.message);
}
