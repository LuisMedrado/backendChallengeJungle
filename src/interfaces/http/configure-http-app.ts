import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpErrorFilter } from './http-error.filter';
import { requestLogging } from './request-logging';

// configuração http compartilhada entre main.ts e os testes
export function configureHttpApp(app: INestApplication): void {
  // correlationId e log de cada requisição, antes de tudo pra valer até pra rota que não existe
  app.use(requestLogging);
  // campo desconhecido no payload é erro, não é ignorado em silêncio
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpErrorFilter());
}
