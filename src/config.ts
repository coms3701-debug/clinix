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
  },

  timezone: optional('DEFAULT_TIMEZONE', 'America/Sao_Paulo'),
  reminderHour: parseInt(optional('REMINDER_HOUR', '18'), 10),

  jwt: {
    secret: optional('JWT_SECRET', 'dev-secret-troque-em-producao'),
  },

  gemini: {
    apiKey: process.env['GEMINI_API_KEY'] ?? '',   // opcional — ativa IA quando preenchido
    model: optional('GEMINI_MODEL', 'gemini-3-flash-preview'),
  },
} as const;
