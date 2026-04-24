import twilio from 'twilio';
import { config } from '../config.js';
import type { MessagingProvider, SendTextOptions } from './messaging.interface.js';

const client = twilio(config.twilio.accountSid, config.twilio.authToken);

/**
 * TwilioAdapter
 *
 * Envia mensagens WhatsApp via Twilio Messaging API.
 * O número de destino (`to`) deve ser passado sem prefixo — este adapter
 * adiciona automaticamente o prefixo "whatsapp:".
 *
 * Pré-requisitos no console Twilio:
 *   1. WhatsApp Business aprovado ou Sandbox ativo
 *   2. TWILIO_FROM_NUMBER = "whatsapp:+5511XXXXX" (ou sandbox: whatsapp:+14155238886)
 *   3. Webhook de entrada apontando para POST /webhooks/twilio
 */
export const twilioAdapter: MessagingProvider = {
  async sendText({ to, body }: SendTextOptions): Promise<void> {
    const toNumber = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

    await client.messages.create({
      from: config.twilio.fromNumber,
      to: toNumber,
      body,
    });
  },
};

/**
 * Valida a assinatura de uma requisição webhook do Twilio.
 * Chame isso no controller antes de processar a mensagem.
 */
export function validateTwilioSignature(
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  return twilio.validateRequest(config.twilio.authToken, signature, url, params);
}
