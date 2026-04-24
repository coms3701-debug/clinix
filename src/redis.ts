import { Redis as IORedis } from 'ioredis';
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
