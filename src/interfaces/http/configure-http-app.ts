import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpErrorFilter } from './http-error.filter';

// configuração http compartilhada entre main.ts e os testes
export function configureHttpApp(app: INestApplication): void {
  // campo desconhecido no payload é erro, não é ignorado em silêncio
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpErrorFilter());
}
