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
import { authRoutes, requireAuth } from './modules/auth/auth.routes.js';
import { prisma } from './database.js';
import { sendBusinessInitiated } from './providers/outbound.js';
import { addDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { localDayBounds, localYMD } from './utils/tz.js';

process.stdout.write('🚀 Clinix: iniciando servidor...\n');

// ── Guarda de produção: recusa subir com credenciais ausentes/fracas ──
// Os fallbacks de dev (admin/clinix2024, dev-secret) são públicos no repo;
// em produção o boot falha em vez de aceitar esses valores conhecidos.
if (config.nodeEnv === 'production') {
  const problems: string[] = [];
  if (!process.env['ADMIN_USERNAME']) problems.push('ADMIN_USERNAME não definido');
  if (!process.env['ADMIN_PASSWORD'] || process.env['ADMIN_PASSWORD'] === 'clinix2024') {
    problems.push('ADMIN_PASSWORD ausente ou igual ao default público');
  }
  if (!process.env['JWT_SECRET'] || process.env['JWT_SECRET'] === 'dev-secret-troque-em-producao') {
    problems.push('JWT_SECRET ausente ou igual ao default público');
  }
  if (problems.length) {
    console.error('❌ Boot bloqueado por segurança:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  // Atrás do proxy do Render/Fly: faz request.protocol refletir o https real
  // (x-forwarded-proto), essencial p/ a validação de assinatura do Twilio.
  trustProxy: true,
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
});

// ── Autenticação ───────────────────────────────────────────────
await app.register(authRoutes);
requireAuth(app);

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
  const tomorrow = localDayBounds(localYMD(addDays(now, 1), config.timezone), config.timezone);
  const appointments = await prisma.appointment.findMany({
    where: {
      status: { in: ['SCHEDULED', 'CONFIRMED'] },
      startsAt: { gte: tomorrow.start, lte: tomorrow.end },
      remindersSent: 0,
    },
    include: {
      patient: { select: { id: true, whatsappNumber: true, fullName: true } },
      professional: { select: { name: true } },
      clinic: { select: { name: true, timezone: true } },
    },
  });

  app.log.info(`[Reminders] Enviando ${appointments.length} lembretes`);

  for (const appt of appointments) {
    try {
      const when = formatInTimeZone(appt.startsAt, appt.clinic.timezone, "EEEE, dd/MM 'às' HH:mm", { locale: ptBR });
      const firstName = appt.patient.fullName?.split(' ')[0] || 'paciente';
      // Mesmo texto do modelo aprovado (clinix_lembrete_consulta).
      const msg =
        `Olá, ${firstName}! Lembrete da sua consulta na ${appt.clinic.name}: ${when}, com ${appt.professional.name}.\n\n` +
        `Responda CONFIRMAR, REMARCAR ou CANCELAR.`;

      // A consulta costuma ter sido marcada dias antes: fora da janela de
      // 24h do WhatsApp, só o modelo aprovado é entregue.
      await sendBusinessInitiated({
        to: appt.patient.whatsappNumber,
        templateSid: config.twilio.templates.reminder,
        variables: { '1': firstName, '2': appt.clinic.name, '3': when, '4': appt.professional.name },
        fallbackText: msg,
      });

      // Registra na conversa para a Bella entender a resposta do paciente.
      const conversation = await prisma.conversation.findFirst({
        where: { clinicId: appt.clinicId, patientId: appt.patient.id },
        orderBy: { updatedAt: 'desc' },
      });
      if (conversation) {
        await prisma.message.create({ data: { conversationId: conversation.id, direction: 'OUTBOUND', body: msg } });
      }
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
  let lastRunDay: string | null = null;

  setInterval(async () => {
    const now = new Date();
    // Hora e dia no fuso da clínica (o servidor roda em UTC).
    const hour = toZonedTime(now, config.timezone).getHours();
    const today = localYMD(now, config.timezone);

    if (hour === config.reminderHour && lastRunDay !== today) {
      app.log.info('[Scheduler] Disparando envio de lembretes de véspera...');
      try {
        await scheduleReminders();
        lastRunDay = today;
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
