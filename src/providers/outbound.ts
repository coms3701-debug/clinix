import { config } from '../config.js';
import { twilioAdapter } from './twilio.adapter.js';

/**
 * Envio de mensagens que a EMPRESA inicia (lembrete, aviso de vaga).
 *
 * O WhatsApp só entrega texto livre até 24h após a última mensagem do
 * paciente; fora disso exige modelo aprovado pela Meta. Usa o modelo quando
 * ele já está aprovado e cai no texto livre enquanto não está — assim a
 * aprovação passa a valer sozinha, sem novo deploy.
 */

const APPROVAL_TTL_MS = 60 * 60 * 1000;
const approvalCache = new Map<string, { approved: boolean; checkedAt: number }>();

async function isTemplateApproved(contentSid: string): Promise<boolean> {
  const cached = approvalCache.get(contentSid);
  if (cached && Date.now() - cached.checkedAt < APPROVAL_TTL_MS) return cached.approved;

  let approved = false;
  try {
    const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
    const res = await fetch(`https://content.twilio.com/v1/Content/${contentSid}/ApprovalRequests`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as { whatsapp?: { status?: string } };
    approved = json.whatsapp?.status === 'approved';
  } catch (err) {
    console.warn(`[Outbound] Não consegui checar a aprovação do modelo ${contentSid}:`, err);
  }
  approvalCache.set(contentSid, { approved, checkedAt: Date.now() });
  return approved;
}

export async function sendBusinessInitiated(params: {
  to: string;
  templateSid: string;
  variables: Record<string, string>;
  fallbackText: string;
}): Promise<'template' | 'text'> {
  if (params.templateSid && (await isTemplateApproved(params.templateSid))) {
    await twilioAdapter.sendTemplate({ to: params.to, contentSid: params.templateSid, variables: params.variables });
    return 'template';
  }
  await twilioAdapter.sendText({ to: params.to, body: params.fallbackText });
  return 'text';
}
