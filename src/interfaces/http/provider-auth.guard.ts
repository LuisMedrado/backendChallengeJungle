import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

// ponto de extensão da autenticação dos provedores, hoje libera tudo de propósito
// o desenho com um IdP externo tá no ARCHITECTURE: validar o token OIDC do provedor e conferir
// que o providerId do token é o msm do corpo da requisição
// health e metrics ficam de fora, como o enunciado pede
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
