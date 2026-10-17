import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // preciso disso pro shutdown correto com sigterm do consumer sqs
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`wagering-processor ouvindo na porta ${port}`);
}

// falha no boot encerra com código != 0 em vez de ficar solto
bootstrap().catch((error: unknown) => {
  console.error('falha ao iniciar wagering-processor', error);
  process.exit(1);
});
