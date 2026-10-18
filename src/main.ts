import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JsonLogger } from './infrastructure/observability/json-logger';
import { configureHttpApp } from './interfaces/http/configure-http-app';

async function bootstrap(): Promise<void> {
  // log em JSON desde o boot, uma linha por entrada
  const logger = new JsonLogger();
  const app = await NestFactory.create(AppModule, { logger });
  configureHttpApp(app);
  // preciso disso pro shutdown correto com sigterm do consumer sqs
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log({ msg: 'wagering-processor ouvindo', port }, 'Bootstrap');
}

// falha no boot encerra com código != 0 em vez de ficar solto
bootstrap().catch((error: unknown) => {
  new JsonLogger().error(
    { msg: 'falha ao iniciar wagering-processor', error: error instanceof Error ? error.message : String(error) },
    error instanceof Error ? error.stack : undefined,
    'Bootstrap',
  );
  process.exit(1);
});
