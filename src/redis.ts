import IORedis from 'ioredis';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { config } from './config.js';

export const redis = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null, // obrigatório para BullMQ
  enableReadyCheck: false,
});

redis.on('error', (err: Error) => {
  console.error('[Redis] Erro de conexão:', err.message);
});

redis.on('connect', () => {
  console.info('[Redis] Conectado com sucesso');
});
