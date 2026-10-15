/**
 * Interface genérica de mensageria — permite trocar de provedor (Twilio, Meta Direct, etc.)
 * sem alterar o restante do sistema.
 */
export interface SendTextOptions {
  to: string;   // número no formato international: +5511999999999
  body: string;
}

/**
 * Mensagem por modelo aprovado pela Meta. Obrigatória quando a empresa
 * inicia a conversa (lembrete, aviso de vaga): texto livre só é entregue
 * até 24h após a última mensagem do paciente.
 */
export interface SendTemplateOptions {
  to: string;
  contentSid: string;                  // HX... (Twilio Content API)
  variables: Record<string, string>;   // {"1": "...", "2": "..."}
}

export interface MessagingProvider {
  sendText(options: SendTextOptions): Promise<void>;
  sendTemplate(options: SendTemplateOptions): Promise<void>;
}
