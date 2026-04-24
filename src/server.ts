import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifySensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import fastifyFormBody from '@fastify/formbody';
import { config } from './config.js';
import { twilioWebhookRoutes } from './modules/webhook/twilio.controller.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { prisma } from './database.js';
import { twilioAdapter } from './providers/twilio.adapter.js';
import { addDays, startOfDay, endOfDay, format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

process.stdout.write('🚀 Clinix: iniciando servidor...\n');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: {
    level: config.logLevel,
    ...(config.nodeEnv === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  },
});

// ── Plugins ────────────────────────────────────────────────────
await app.register(fastifyCors, { origin: true });
await app.register(fastifyHelmet, {
  contentSecurityPolicy: false, // Relaxado para servir o painel local
});
await app.register(fastifySensible);
await app.register(fastifyFormBody); // Necessário para parsear form-encoded do Twilio

// ── Arquivos estáticos (painel admin e demo) ──────────────────
await app.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/',
  decorateReply: false,
});

// ── Rotas ──────────────────────────────────────────────────────
await app.register(twilioWebhookRoutes);
await app.register(adminRoutes);

// ── Fallback SPA ───────────────────────────────────────────────
app.setNotFoundHandler(async (req, reply) => {
  if (!req.url.startsWith('/v1') && !req.url.startsWith('/webhooks')) {
    return reply.sendFile('index.html');
  }
  return reply.status(404).send({ error: 'Rota não encontrada' });
});

// ── Envio direto de lembretes (sem Redis/BullMQ) ───────────────
async function scheduleReminders() {
  const now = new Date();
  const tomorrow = addDays(now, 1);
  const appointments = await prisma.appointment.findMany({
    where: {
      status: { in: ['SCHEDULED', 'CONFIRMED'] },
      startsAt: { gte: startOfDay(tomorrow), lte: endOfDay(tomorrow) },
      remindersSent: 0,
    },
    include: {
      patient: { select: { whatsappNumber: true, fullName: true } },
      professional: { select: { name: true } },
      clinic: { select: { name: true, timezone: true } },
    },
  });

  app.log.info(`[Reminders] Enviando ${appointments.length} lembretes`);

  for (const appt of appointments) {
    try {
      const dateLocal = toZonedTime(appt.startsAt, appt.clinic.timezone);
      const dateFormatted = format(dateLocal, "dd/MM/yyyy 'às' HH:mm");
      const msg =
        `Olá ${appt.patient.fullName || 'paciente'}! 👋\n\n` +
        `Lembrete: você tem uma consulta *amanhã* (${dateFormatted}) com *${appt.professional.name}* na ${appt.clinic.name}.\n\n` +
        `Responda:\n✅ CONFIRMAR\n🔄 REMARCAR\n❌ CANCELAR`;

      await twilioAdapter.sendText({ to: appt.patient.whatsappNumber, body: msg });
      await prisma.appointment.update({
        where: { id: appt.id },
        data: { remindersSent: { increment: 1 } },
      });
    } catch (err) {
      app.log.error(err, `[Reminders] Erro ao enviar lembrete para consulta ${appt.id}`);
    }
  }
}

// ── Inicializar lembretes (cron simples via setInterval) ───────
function startReminderScheduler() {
  const checkInterval = 60 * 60 * 1000; // a cada 1 hora
  let lastRun: Date | null = null;

  setInterval(async () => {
    const now = new Date();
    const hour = now.getHours();
    const alreadyRanToday =
      lastRun !== null &&
      lastRun.getDate() === now.getDate() &&
      lastRun.getMonth() === now.getMonth();

    if (hour === config.reminderHour && !alreadyRanToday) {
      app.log.info('[Scheduler] Disparando envio de lembretes de véspera...');
      try {
        await scheduleReminders();
        lastRun = now;
      } catch (err) {
        app.log.error(err, '[Scheduler] Erro ao agendar lembretes');
      }
    }
  }, checkInterval);
}

// ── Iniciar servidor ───────────────────────────────────────────
try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`🚀 Clinix rodando em http://localhost:${config.port}`);
  app.log.info(`📋 Painel admin: http://localhost:${config.port}/admin`);
  app.log.info(`💬 Demo WhatsApp: http://localhost:${config.port}/demo`);
  app.log.info(`📡 Webhook Twilio: POST http://localhost:${config.port}/webhooks/twilio`);

  if (config.nodeEnv !== 'test') {
    startReminderScheduler();
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
