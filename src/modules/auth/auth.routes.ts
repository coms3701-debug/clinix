import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { z } from 'zod';

const TOKEN_EXPIRY_MS = 8 * 60 * 60 * 1000; // 8 horas

function getSecret(): string {
  return process.env['JWT_SECRET'] ?? 'dev-secret-troque-em-producao';
}

export function createToken(userId: string): string {
  const expires = Date.now() + TOKEN_EXPIRY_MS;
  const nonce = randomBytes(8).toString('hex');
  const payload = `${userId}|${expires}|${nonce}`;
  const sig = createHmac('sha256', getSecret()).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

export function verifyToken(token: string): boolean {
  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const parts = decoded.split('|');
    if (parts.length !== 4) return false;
    const [userId, expiresStr, nonce, sig] = parts;
    const payload = `${userId}|${expiresStr}|${nonce}`;
    const expectedSig = createHmac('sha256', getSecret()).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig ?? '', 'hex');
    const expectedBuf = Buffer.from(expectedSig, 'hex');
    if (sigBuf.length !== expectedBuf.length) return false;
    const valid = timingSafeEqual(sigBuf, expectedBuf);
    const notExpired = Date.now() < parseInt(expiresStr ?? '0', 10);
    return valid && notExpired;
  } catch {
    return false;
  }
}

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown }>('/v1/auth/login', async (req, reply) => {
    const schema = z.object({
      username: z.string().min(1),
      password: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Dados inválidos' });

    const adminUser = process.env['ADMIN_USERNAME'] ?? 'admin';
    const adminPass = process.env['ADMIN_PASSWORD'] ?? 'clinix2024';

    const userMatch = parsed.data.username === adminUser;
    const passMatch = parsed.data.password === adminPass;

    if (!userMatch || !passMatch) {
      await new Promise((r) => setTimeout(r, 500)); // Delay contra brute-force
      return reply.status(401).send({ error: 'Usuário ou senha incorretos' });
    }

    const token = createToken(parsed.data.username);
    return { token, expiresIn: TOKEN_EXPIRY_MS / 1000 };
  });
}

// Hook para proteger rotas admin
export function requireAuth(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    // Rotas públicas — não precisam de token
    const publicPaths = ['/health', '/v1/auth/login', '/webhooks'];
    if (publicPaths.some((p) => req.url.startsWith(p))) return;
    if (!req.url.startsWith('/v1/')) return;

    const auth = req.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

    if (!token || !verifyToken(token)) {
      return reply.status(401).send({ error: 'Não autorizado. Faça login novamente.' });
    }
  });
}
