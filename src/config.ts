import 'dotenv/config';

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '3000'), 10),
  logLevel: optional('LOG_LEVEL', 'info'),

  database: {
    url: required('DATABASE_URL'),
  },

  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },

  twilio: {
    accountSid: required('TWILIO_ACCOUNT_SID'),
    authToken: required('TWILIO_AUTH_TOKEN'),
    fromNumber: required('TWILIO_FROM_NUMBER'), // ex: whatsapp:+5511999999999
    // Modelos aprovados pela Meta (Twilio Content API) p/ mensagens que a
    // empresa inicia. Vazio = cai no texto livre (só entrega em até 24h
    // da última mensagem do paciente).
    templates: {
      reminder: optional('TWILIO_TEMPLATE_REMINDER', 'HXa514314e3c73ddaf1a835776eda064e6'),
      waitlistOpening: optional('TWILIO_TEMPLATE_WAITLIST', 'HXeed55c09b792c997f2210a2a5aa8f63e'),
    },
  },

  timezone: optional('DEFAULT_TIMEZONE', 'America/Sao_Paulo'),
  reminderHour: parseInt(optional('REMINDER_HOUR', '18'), 10),

  jwt: {
    secret: optional('JWT_SECRET', 'dev-secret-troque-em-producao'),
  },

  gemini: {
    apiKey: process.env['GEMINI_API_KEY'] ?? '',   // opcional — ativa IA quando preenchido
    // Principal: estável (GA) e rápido. Reserva: usado se o principal falhar
    // (sobrecarga/cota). Benchmark 15/10/2026 no fluxo real de agendamento.
    model: optional('GEMINI_MODEL', 'gemini-3.5-flash-lite'),
    fallbackModel: optional('GEMINI_FALLBACK_MODEL', 'gemini-3-flash-preview'),
  },
} as const;
