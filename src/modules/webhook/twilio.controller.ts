import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { validateTwilioSignature } from '../../providers/twilio.adapter.js';
import { processMessage } from '../conversation/conversation.engine.js';

/**
 * Payload que o Twilio envia via POST (form-encoded) quando uma mensagem WhatsApp chega.
 * Referência: https://www.twilio.com/docs/messaging/guides/webhook-request
 */
interface TwilioWebhookBody {
  MessageSid: string;
  AccountSid: string;
  From: string;        // "whatsapp:+5511999999999"
  To: string;          // "whatsapp:+5511888888888" (número da clínica)
  Body: string;        // Texto da mensagem
  NumMedia?: string;
  MediaUrl0?: string;
  ProfileName?: string;
  WaId?: string;       // WhatsApp ID do remetente
}

export async function twilioWebhookRoutes(app: FastifyInstance) {
  /**
   * POST /webhooks/twilio
   *
   * Twilio envia form-encoded (Content-Type: application/x-www-form-urlencoded).
   * O Fastify com @fastify/formbody faz o parse automaticamente.
   *
   * Configurar no Twilio Console:
   *   Messaging → WhatsApp → Sandbox (ou número) → When a message comes in:
   *   POST https://seu-dominio.com/webhooks/twilio
   */
  app.post<{ Body: TwilioWebhookBody }>(
    '/webhooks/twilio',
    { config: { rawBody: true } },
    async (request: FastifyRequest<{ Body: TwilioWebhookBody }>, reply: FastifyReply) => {
      try {
        // ── Validação de assinatura Twilio ────────────────────
        // Em produção sempre valide. Em dev pode desabilitar.
        if (process.env.NODE_ENV === 'production') {
          const signature = (request.headers['x-twilio-signature'] as string) ?? '';
          const webhookUrl = process.env.TWILIO_WEBHOOK_URL ?? `${request.protocol}://${request.hostname}/webhooks/twilio`;
          const params = request.body as unknown as Record<string, string>;

          const valid = validateTwilioSignature(signature, webhookUrl, params);
          if (!valid) {
            request.log.warn('Assinatura Twilio inválida — requisição rejeitada');
            return reply.status(403).send({ error: 'Invalid signature' });
          }
        }

        const { From, To, Body, MessageSid } = request.body;

        if (!From || !Body) {
          return reply.status(400).send({ error: 'Payload incompleto' });
        }

        request.log.info({ from: From, to: To, messageSid: MessageSid }, 'Mensagem WhatsApp recebida');

        // Processar de forma assíncrona — responder ao Twilio imediatamente (200)
        setImmediate(() => {
          processMessage({
            clinicWhatsappNumber: To,
            from: From,
            body: Body,
          }).catch((err) => request.log.error(err, 'Erro ao processar mensagem'));
        });

        // Twilio espera 200 com TwiML vazio (ou texto simples)
        reply.header('Content-Type', 'text/xml');
        return reply.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
      } catch (err) {
        request.log.error(err, 'Erro no webhook Twilio');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // Health check específico
  app.get('/webhooks/twilio/health', async (_req, reply) => {
    return reply.send({ status: 'ok', provider: 'twilio' });
  });
}
