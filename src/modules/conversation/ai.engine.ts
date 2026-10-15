/**
 * ai.engine.ts — Bella com IA (Google Gemini via REST API)
 *
 * Usa fetch nativo do Node 22 — zero dependências extras.
 * Ativado quando GEMINI_API_KEY estiver configurada no .env.
 */

import { prisma } from '../../database.js';
import { config } from '../../config.js';
import { getAvailableSlots, groupSlotsByDate } from '../appointment/availability.service.js';
import { createAppointment, cancelAppointment, getPatientAppointments } from '../appointment/appointment.service.js';
import { ptBR } from 'date-fns/locale';
import { formatInTimeZone } from 'date-fns-tz';

// ─── Tipos da API REST do Gemini ──────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content: GeminiContent;
    finishReason?: string;
  }>;
  error?: { message: string; code: number };
}

// ─── Chamada à API REST do Gemini ────────────────────────────────────────────

class GeminiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// Sobrecarga/cota/instabilidade do Google: vale tentar de novo.
const RETRYABLE_STATUS = new Set([0, 429, 500, 502, 503, 504]);
// Ferramentas que alteram dados — não podem ser repetidas com o modelo reserva.
const WRITE_TOOLS = new Set(['create_booking', 'cancel_appointment', 'join_waitlist']);

async function callGemini(params: {
  model: string;
  contents: GeminiContent[];
  systemInstruction: string;
  tools: object[];
}): Promise<GeminiResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${params.model}:generateContent?key=${config.gemini.apiKey}`;

  const body = {
    system_instruction: {
      parts: [{ text: params.systemInstruction }],
    },
    contents: params.contents,
    tools: params.tools,
    generationConfig: {
      // Modelos com "thinking" gastam parte desse limite raciocinando; 600
      // podia esgotar antes do texto e deixar a resposta vazia.
      maxOutputTokens: 2048,
      temperature: 0.65,
    },
  };

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json().catch(() => ({}))) as GeminiResponse;
      if (!res.ok || json.error) {
        throw new GeminiError(
          `Gemini ${params.model} ${res.status}: ${json.error?.message ?? JSON.stringify(json).slice(0, 200)}`,
          res.status,
        );
      }
      return json;
    } catch (err) {
      const status = err instanceof GeminiError ? err.status : 0; // 0 = rede/timeout
      if (!RETRYABLE_STATUS.has(status) || attempt >= 2) throw err;
      console.warn(`[AI Engine Gemini] ${params.model} falhou (${status}), nova tentativa ${attempt + 1}/2`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

// ─── Definição das ferramentas (function declarations) ────────────────────────

const TOOLS = [
  {
    function_declarations: [
      {
        name: 'list_services',
        description: 'Lista os serviços disponíveis na clínica.',
        parameters: { type: 'OBJECT', properties: {}, required: [] },
      },
      {
        name: 'list_professionals',
        description: 'Lista profissionais que atendem um serviço.',
        parameters: {
          type: 'OBJECT',
          properties: {
            serviceId: { type: 'STRING', description: 'ID do serviço' },
          },
          required: ['serviceId'],
        },
      },
      {
        name: 'list_available_slots',
        description:
          'Busca horários disponíveis para agendamento. Retorna até 3 datas com 5 horários cada. ' +
          'OBRIGATÓRIO usar antes de propor qualquer horário — nunca invente disponibilidade.',
        parameters: {
          type: 'OBJECT',
          properties: {
            serviceId: { type: 'STRING', description: 'ID do serviço' },
            professionalId: { type: 'STRING', description: 'ID do profissional (omita para qualquer disponível)' },
          },
          required: ['serviceId'],
        },
      },
      {
        name: 'create_booking',
        description:
          'Cria um agendamento confirmado. Só chamar após ter nome completo, CPF e horário confirmados.',
        parameters: {
          type: 'OBJECT',
          properties: {
            serviceId:      { type: 'STRING', description: 'ID do serviço' },
            professionalId: { type: 'STRING', description: 'ID do profissional' },
            startsAt:       { type: 'STRING', description: 'Data/hora início em ISO 8601 UTC' },
            patientName:    { type: 'STRING', description: 'Nome completo do paciente' },
            patientCpf:     { type: 'STRING', description: 'CPF somente dígitos (11 caracteres)' },
          },
          required: ['serviceId', 'professionalId', 'startsAt', 'patientName', 'patientCpf'],
        },
      },
      {
        name: 'list_my_appointments',
        description: 'Lista os próximos agendamentos do paciente (futuros, não cancelados).',
        parameters: { type: 'OBJECT', properties: {}, required: [] },
      },
      {
        name: 'cancel_appointment',
        description: 'Cancela um agendamento do paciente. Confirmar com ele antes de chamar.',
        parameters: {
          type: 'OBJECT',
          properties: {
            appointmentId: { type: 'STRING', description: 'ID do agendamento' },
          },
          required: ['appointmentId'],
        },
      },
      {
        name: 'join_waitlist',
        description:
          'Inscreve o paciente na lista de encaixe por desistência. ' +
          'Chamar quando list_available_slots retornar vazio e o paciente aceitar entrar na lista. ' +
          'Quando um horário abrir, o paciente será notificado automaticamente pelo WhatsApp.',
        parameters: {
          type: 'OBJECT',
          properties: {
            serviceId: { type: 'STRING', description: 'ID do serviço desejado (opcional)' },
            professionalId: { type: 'STRING', description: 'ID do profissional preferido (opcional)' },
          },
          required: [],
        },
      },
    ],
  },
];

// ─── Contexto para execução das ferramentas ───────────────────────────────────

interface ToolCtx {
  clinic: {
    id: string;
    name: string;
    assistantName: string;
    timezone: string;
    services: Array<{ id: string; name: string; description: string | null; durationMin: number; active: boolean }>;
  };
  patient: { id: string; fullName?: string | null; cpf?: string | null };
}

// ─── Execução das ferramentas ─────────────────────────────────────────────────

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<unknown> {
  const str = (key: string) => String(args[key] ?? '');

  switch (name) {
    case 'list_services': {
      return ctx.clinic.services
        .filter((s) => s.active)
        .map((s) => ({
          id: s.id,
          name: s.name,
          durationMin: s.durationMin,
          ...(s.description ? { keywords: s.description } : {}),
        }));
    }

    case 'list_professionals': {
      const profs = await prisma.professional.findMany({
        where: {
          clinicId: ctx.clinic.id,
          active: true,
          services: { some: { serviceId: str('serviceId') } },
        },
        select: { id: true, name: true, bio: true },
      });
      return profs.length > 0 ? profs : { info: 'Nenhum profissional disponível para este serviço.' };
    }

    case 'list_available_slots': {
      const slots = await getAvailableSlots({
        clinicId: ctx.clinic.id,
        serviceId: str('serviceId'),
        professionalId: str('professionalId') || undefined,
        timezone: ctx.clinic.timezone,
        daysAhead: 14,
      });
      const grouped = groupSlotsByDate(slots, 3, 5);
      if (grouped.size === 0) {
        return {
          no_slots: true,
          message: 'Nenhum horário disponível nos próximos 14 dias. Informe o paciente com empatia e ofereça a lista de encaixe por desistência (join_waitlist). NÃO oriente a ligar para a recepção como primeiro recurso.',
        };
      }
      const result = [];
      for (const [date, daySlots] of grouped) {
        result.push({
          date,
          slots: daySlots.map((s) => ({
            time: s.time,
            professionalId: s.professionalId,
            professionalName: s.professionalName,
            startsAt: s.startsAt.toISOString(),
          })),
        });
      }
      return result;
    }

    case 'create_booking': {
      const serviceId      = str('serviceId');
      const professionalId = str('professionalId');
      const startsAt       = new Date(str('startsAt'));
      const patientName    = str('patientName');
      const patientCpf     = str('patientCpf').replace(/\D/g, '');

      if (patientCpf.length < 11) {
        return { error: 'CPF inválido. Solicite ao paciente o CPF com 11 dígitos.' };
      }

      await prisma.patient.update({
        where: { id: ctx.patient.id },
        data: {
          ...(patientName ? { fullName: patientName } : {}),
          ...(patientCpf  ? { cpf: patientCpf }       : {}),
        },
      });

      if (isNaN(startsAt.getTime())) {
        return { error: 'startsAt inválido. Chame list_available_slots e use exatamente o startsAt retornado.' };
      }

      // O histórico guarda só o texto das mensagens, não o resultado das
      // ferramentas — então o modelo pode chegar aqui com professionalId ou
      // startsAt "de memória". Só aceita um horário que esteja de fato livre,
      // e resolve o profissional a partir dele.
      const slots = await getAvailableSlots({
        clinicId: ctx.clinic.id,
        serviceId,
        timezone: ctx.clinic.timezone,
        daysAhead: 30,
      });
      const sameTime = slots.filter((s) => s.startsAt.getTime() === startsAt.getTime());
      const slot = sameTime.find((s) => s.professionalId === professionalId) ?? sameTime[0];
      if (!slot) {
        return {
          error:
            'Esse horário não está entre os disponíveis. Chame list_available_slots e use exatamente ' +
            'o startsAt e o professionalId retornados (ou ofereça outro horário ao paciente).',
        };
      }

      const result = await createAppointment({
        clinicId: ctx.clinic.id,
        patientId: ctx.patient.id,
        slot,
        serviceId,
      });

      if (!result.success) {
        return { error: 'Horário indisponível — alguém acabou de reservar. Use list_available_slots para buscar outro.' };
      }

      return {
        success: true,
        appointmentId: result.appointment?.id,
        service: result.appointment?.service.name,
        professional: result.appointment?.professional.name,
        startsAt: result.appointment?.startsAt,
      };
    }

    case 'list_my_appointments': {
      const appts = await getPatientAppointments(ctx.patient.id, ctx.clinic.id);
      if (appts.length === 0) return { info: 'Nenhum agendamento futuro encontrado.' };
      return appts.map((a) => ({
        id: a.id,
        service: (a as any).service?.name ?? '',
        professional: (a as any).professional?.name ?? '',
        startsAt: a.startsAt,
        status: a.status,
      }));
    }

    case 'cancel_appointment': {
      await cancelAppointment(str('appointmentId'), 'Cancelado pelo paciente via WhatsApp');
      return { success: true };
    }

    case 'join_waitlist': {
      const serviceId      = str('serviceId') || undefined;
      const professionalId = str('professionalId') || undefined;

      // Verifica se já está na lista de espera para evitar duplicata
      const existing = await prisma.waitlistEntry.findFirst({
        where: { clinicId: ctx.clinic.id, patientId: ctx.patient.id, status: 'WAITING' },
      });
      if (existing) {
        return { already_registered: true };
      }

      await prisma.waitlistEntry.create({
        data: {
          clinicId: ctx.clinic.id,
          patientId: ctx.patient.id,
          status: 'WAITING',
          ...(serviceId      ? { serviceId }      : {}),
          ...(professionalId ? { professionalId } : {}),
        },
      });
      return { success: true };
    }

    default:
      return { error: `Ferramenta desconhecida: ${name}` };
  }
}

// ─── Engine principal ─────────────────────────────────────────────────────────

export async function processWithAI(params: {
  clinic: ToolCtx['clinic'];
  patient: ToolCtx['patient'];
  conversationId: string;
  text: string;
  send: (msg: string) => Promise<void>;
}): Promise<void> {
  const { clinic, patient, conversationId, text, send } = params;

  // Carrega histórico (últimas 20 mensagens, exclui a atual)
  const recentMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: 21,
  });

  const historyRaw = recentMessages.slice(1).reverse();

  // Monta array de contents para o Gemini (role: user | model)
  // Mescla mensagens consecutivas do mesmo papel (requisito da API)
  const contents: GeminiContent[] = [];
  for (const m of historyRaw) {
    const role = m.direction === 'INBOUND' ? 'user' : 'model';
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text: m.body });
    } else {
      contents.push({ role, parts: [{ text: m.body }] });
    }
  }

  // Gemini exige que comece com 'user'
  while (contents.length > 0 && contents[0]!.role !== 'user') contents.shift();

  // Adiciona a mensagem atual
  contents.push({ role: 'user', parts: [{ text }] });

  // System prompt
  // No fuso da clínica: com o servidor em UTC, após as 21h (BRT) "hoje" viraria amanhã.
  const todayStr = formatInTimeZone(new Date(), clinic.timezone, "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR });
  const servicesList = clinic.services
    .filter((s) => s.active)
    .map((s) => `• ${s.name} — serviceId: "${s.id}" (${s.durationMin} min)`)
    .join('\n');

  const systemInstruction =
    `Você é ${clinic.assistantName}, assistente virtual da ${clinic.name}.\n` +
    `Ajuda pacientes a agendar, consultar e cancelar consultas via WhatsApp.\n` +
    `Seja simpática, profissional e objetiva. Emojis com moderação.\n` +
    `Responda SEMPRE em português brasileiro.\n` +
    `Hoje é ${todayStr}. Fuso horário: ${clinic.timezone}.\n\n` +
    `Serviços:\n${servicesList}\n\n` +
    `ESTILO DE CONVERSA:\n` +
    `- Converse de forma NATURAL, como uma atendente humana — NUNCA use listas numeradas (1. 2. 3.)\n` +
    `- NUNCA apresente menus ou opções numeradas. Faça perguntas diretas e naturais.\n` +
    `- Na primeira mensagem do paciente, apresente-se pelo nome e da clínica, depois pergunte como pode ajudar.\n` +
    `- Exemplo de saudação: "Olá! Sou a ${clinic.assistantName}, da ${clinic.name}. Como posso te ajudar? 😊"\n\n` +
    `INTELIGÊNCIA NO AGENDAMENTO:\n` +
    `- Os serviceIds estão listados acima em "Serviços" — use-os DIRETAMENTE em list_available_slots, sem chamar list_services antes.\n` +
    `- Entenda nomes abreviados: "consulta" = "Consulta Dermatológica", "botox" = serviço de botox, etc.\n` +
    `- Se o paciente mencionar serviço E profissional juntos, vá DIRETO para list_available_slots usando o serviceId correto da lista acima.\n` +
    `- Se mencionar só o serviço, chame list_available_slots imediatamente com o serviceId correspondente — não peça mais detalhes antes.\n` +
    `- Para obter o professionalId, chame list_professionals apenas se necessário. Nunca invente um ID.\n` +
    `- Minimize perguntas: só peça nome e CPF DEPOIS de mostrar os horários e o paciente escolher um.\n` +
    `- Se o paciente escolher um horário, confirme assim: "Ótimo! Para finalizar, me diz seu nome completo e CPF 😊"\n\n` +
    `REGRAS:\n` +
    `- NUNCA invente horários — use list_available_slots sempre\n` +
    `- Fluxo ideal: entender serviço → list_available_slots → paciente escolhe → pedir nome+CPF → create_booking\n` +
    `- Resultados de ferramentas de mensagens anteriores NÃO ficam no histórico: antes de create_booking, ` +
    `chame list_available_slots de novo para obter o startsAt e o professionalId exatos do horário escolhido. Nunca invente IDs.\n` +
    `- Respostas curtas (máx. 300 caracteres quando possível)\n` +
    `- Horários: "📅 Ter, 29/04 – 09:00 / 10:00 / 11:00"\n` +
    `- Após agendar: envie resumo com serviço, profissional, data e horário\n` +
    `- Paciente identificado pelo WhatsApp (ID: ${patient.id})\n\n` +
    `QUANDO NÃO HÁ HORÁRIOS DISPONÍVEIS (list_available_slots retornar no_slots: true):\n` +
    `- Use EXATAMENTE este texto: "No momento nossa agenda está sem horários disponíveis para os próximos dias. 😔\n\nMas posso te colocar na *lista de encaixe* — se algum paciente cancelar, você será avisado(a) na hora pelo WhatsApp para garantir o horário. Quer entrar na lista? 😊"\n` +
    `- Se o paciente confirmar (sim/quero/pode ser/etc.), chame join_waitlist e confirme: "✅ Prontinho! Você está na nossa lista de encaixe. Assim que surgir uma vaga, te avisamos aqui pelo WhatsApp. 😊"\n` +
    `- Se o paciente já estiver na lista (already_registered: true), diga: "✅ Você já está na nossa lista de encaixe! Assim que surgir uma vaga, te avisamos aqui pelo WhatsApp. 😊"\n` +
    `- Só mencione a recepção se o paciente explicitamente pedir ou recusar a lista de encaixe.`;

  const toolCtx: ToolCtx = { clinic, patient };

  // Principal → reserva estável. Se ambos falharem antes de qualquer ação,
  // o erro sobe e o conversation.engine atende pelo menu clássico — a
  // paciente nunca fica sem resposta.
  const models = [...new Set([config.gemini.model, config.gemini.fallbackModel])];

  for (let m = 0; m < models.length; m++) {
    const model = models[m]!;
    // Cópia por tentativa: as assinaturas de "thinking" são do modelo que as gerou.
    const convo: GeminiContent[] = contents.map((c) => ({ ...c, parts: [...c.parts] }));
    let wroteData = false;

    try {
      // Loop de agente — até 6 turnos
      for (let turn = 0; turn < 6; turn++) {
        const response = await callGemini({ model, contents: convo, systemInstruction, tools: TOOLS });

        const candidate = response.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];

        // Verifica se há function calls
        const funcParts = parts.filter((p) => p.functionCall);

        if (funcParts.length === 0) {
          // Resposta final de texto
          const text = parts.map((p) => p.text ?? '').join('').trim();
          if (!text) {
            throw new GeminiError(`Gemini ${model}: resposta vazia (${candidate?.finishReason ?? 'sem candidato'})`, 0);
          }
          await send(text);
          return;
        }

        // Adiciona resposta do modelo ao histórico (com function calls)
        convo.push({ role: 'model', parts });

        // Executa ferramentas e coleta respostas
        const responseParts: GeminiPart[] = [];
        for (const part of funcParts) {
          const { name, args } = part.functionCall!;
          console.log(`[AI Engine Gemini] Tool (${model}): ${name}`, args);
          if (WRITE_TOOLS.has(name)) wroteData = true;
          // Erro numa ferramenta volta para o modelo como resultado, para ele
          // se corrigir — em vez de derrubar a conversa inteira.
          let result: unknown;
          try {
            result = await executeTool(name, args, toolCtx);
          } catch (err) {
            console.error(`[AI Engine Gemini] Erro na ferramenta ${name}:`, err);
            result = {
              error: `Falha interna ao executar ${name}. Se for agendamento, chame list_available_slots ` +
                'e tente de novo com os IDs exatos; se persistir, peça desculpas e ofereça a recepção.',
            };
          }
          // Gemini exige que functionResponse.response seja sempre um objeto (nunca array)
          const responseObj = Array.isArray(result) ? { result } : (result as object);
          responseParts.push({
            functionResponse: { name, response: responseObj },
          });
        }

        // Adiciona respostas das ferramentas como mensagem do usuário
        convo.push({ role: 'user', parts: responseParts });
      }

      await send('Não consegui processar. Digite *menu* para recomeçar ou ligue para a recepção. 🙏');
      return;
    } catch (err) {
      console.error(`[AI Engine Gemini] Erro com ${model}:`, err);
      if (wroteData) {
        // Já agendou/cancelou/inscreveu: repetir com outro modelo poderia
        // duplicar a ação. Orienta a paciente a conferir.
        await send('Tive uma instabilidade ao finalizar. Me pergunte *meus agendamentos* em instantes para conferir, por favor. 🙏');
        return;
      }
      if (m === models.length - 1) throw err;
    }
  }
}
