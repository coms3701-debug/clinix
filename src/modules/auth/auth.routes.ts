import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { z } from 'zod';

const TOKEN_EXPIRY_MS = 8 * 60 * 60 * 1000; // 8 horas
const SESSION_COOKIE = 'clinix_session';

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

// Lê um cookie do header sem depender de plugin externo.
function readCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers['cookie'];
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function sessionCookie(token: string, maxAgeSec: number): string {
  const secure = process.env['NODE_ENV'] === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secure}`;
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
    // Cookie de sessão: protege também as páginas estáticas (/, /demo).
    reply.header('Set-Cookie', sessionCookie(token, TOKEN_EXPIRY_MS / 1000));
    return { token, expiresIn: TOKEN_EXPIRY_MS / 1000 };
  });

  app.post('/v1/auth/logout', async (_req, reply) => {
    reply.header('Set-Cookie', sessionCookie('', 0)); // expira o cookie
    return { ok: true };
  });
}

// Gate global: NADA é público, exceto a porta de entrada do login,
// o health check e o webhook do Twilio.
export function requireAuth(app: FastifyInstance) {
  // Prefixos liberados sem autenticação.
  const publicPrefixes = [
    '/health',          // health check do provedor
    '/webhooks',        // entrega de mensagens do Twilio
    '/v1/auth/login',   // endpoint de login
    '/admin',           // SPA de login (mostra a tela de senha; dados em /v1 seguem protegidos)
    '/favicon',         // evita redirect no favicon do browser
  ];

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (publicPrefixes.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p))) {
      return;
    }

    const header = req.headers['authorization'];
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const token = bearer ?? readCookie(req, SESSION_COOKIE);

    if (token && verifyToken(token)) return;

    // Navegação de browser → manda pro login. Chamada de API → 401.
    const accept = String(req.headers['accept'] ?? '');
    if (accept.includes('text/html')) {
      return reply.redirect('/admin');
    }
    return reply.status(401).send({ error: 'Não autorizado. Faça login novamente.' });
  });
}
