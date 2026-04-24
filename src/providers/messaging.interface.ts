/**
 * Interface genérica de mensageria — permite trocar de provedor (Twilio, Meta Direct, etc.)
 * sem alterar o restante do sistema.
 */
export interface SendTextOptions {
  to: string;   // número no formato international: +5511999999999
  body: string;
}

export interface MessagingProvider {
  sendText(options: SendTextOptions): Promise<void>;
}
