import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../../../src/app.module';
import { configureHttpApp } from '../../../src/interfaces/http/configure-http-app';
import { testDatabaseUrl } from './database';

export interface HttpResponse<T = any> {
  status: number;
  body: T;
}

export interface TestApp {
  app: INestApplication;
  get<T = any>(path: string): Promise<HttpResponse<T>>;
  post<T = any>(path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResponse<T>>;
  close(): Promise<void>;
}

// sobe a api de verdade numa porta aleatória apontando pro banco de teste
// o publisher da outbox fica desligado por padrão pra não mexer na fila nos testes que não são dele
export async function startTestApp(
  options: { outboxPublisher?: boolean; sqsConsumer?: boolean; pendingReferenceWorker?: boolean } = {},
): Promise<TestApp> {
  process.env.PENDING_REFERENCE_WORKER_ENABLED = options.pendingReferenceWorker ? 'true' : 'false';
  process.env.PENDING_REFERENCE_POLL_INTERVAL_MS = '50';
  process.env.DATABASE_URL = testDatabaseUrl();
  // timeout curto pro teste de lock não demorar
  process.env.DB_LOCK_TIMEOUT_MS = '300';
  process.env.OUTBOX_PUBLISHER_ENABLED = options.outboxPublisher ? 'true' : 'false';
  process.env.OUTBOX_POLL_INTERVAL_MS = '50';
  // consumer desligado por padrão pra não roubar mensagem dos testes que não são dele
  process.env.SQS_CONSUMER_ENABLED = options.sqsConsumer ? 'true' : 'false';
  process.env.SQS_WAIT_TIME_SECONDS = '1';
  const app = await NestFactory.create(AppModule, { logger: false });
  configureHttpApp(app);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const request = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };

  return {
    app,
    get: (path) => request('GET', path),
    post: (path, body, headers) => request('POST', path, body, headers),
    close: () => app.close(),
  };
}
