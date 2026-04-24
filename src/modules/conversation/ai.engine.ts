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
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { addMinutes } from 'date-fns';

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

async function callGemini(params: {
  contents: GeminiContent[];
  systemInstruction: string;
  tools: object[];
}): Promise<GeminiResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;

  const body = {
    system_instruction: {
      parts: [{ text: params.systemInstruction }],
    },
    contents: params.contents,
    tools: params.tools,
    generationConfig: {
      maxOutputTokens: 600,
      temperature: 0.65,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json() as GeminiResponse;

  if (!res.ok || json.error) {
    throw new Error(`Gemini API error ${res.status}: ${json.error?.message ?? JSON.stringify(json)}`);
  }

  return json;
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
    services: Array<{ id: string; name: string; durationMin: number; active: boolean }>;
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
        .map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin }));
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
        return { error: 'Nenhum horário disponível nos próximos 14 dias. Oriente o paciente a ligar para a recepção.' };
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

      const service = await prisma.service.findUnique({ where: { id: serviceId } });
      if (!service) return { error: 'Serviço não encontrado.' };

      const endsAt = addMinutes(startsAt, service.durationMin);

      const result = await createAppointment({
        clinicId: ctx.clinic.id,
        patientId: ctx.patient.id,
        slot: { professionalId, professionalName: '', date: '', time: '', startsAt, endsAt },
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
  const todayStr = format(new Date(), "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR });
  const servicesList = clinic.services
    .filter((s) => s.active)
    .map((s) => `• ${s.name} (${s.durationMin} min)`)
    .join('\n');

  const systemInstruction =
    `Você é ${clinic.assistantName}, assistente virtual da ${clinic.name}.\n` +
    `Ajuda pacientes a agendar, consultar e cancelar consultas via WhatsApp.\n` +
    `Seja simpática, profissional e objetiva. Emojis com moderação.\n` +
    `Responda SEMPRE em português brasileiro.\n` +
    `Hoje é ${todayStr}. Fuso horário: ${clinic.timezone}.\n\n` +
    `Serviços:\n${servicesList}\n\n` +
    `REGRAS:\n` +
    `- NUNCA invente horários — use list_available_slots sempre\n` +
    `- Para agendar: serviço → horários disponíveis → confirme nome e CPF → create_booking\n` +
    `- Respostas curtas (máx. 300 caracteres quando possível)\n` +
    `- Horários: "📅 Ter, 29/04 – 09:00 / 10:00 / 11:00"\n` +
    `- Após agendar: envie resumo com serviço, profissional, data e horário\n` +
    `- Paciente identificado pelo WhatsApp (ID: ${patient.id})`;

  const toolCtx: ToolCtx = { clinic, patient };

  try {
    // Loop de agente — até 6 turnos
    for (let turn = 0; turn < 6; turn++) {
      const response = await callGemini({ contents, systemInstruction, tools: TOOLS });

      const candidate = response.candidates?.[0];
      if (!candidate) break;

      const parts = candidate.content?.parts ?? [];

      // Verifica se há function calls
      const funcParts = parts.filter((p) => p.functionCall);

      if (funcParts.length === 0) {
        // Resposta final de texto
        const text = parts.map((p) => p.text ?? '').join('').trim();
        if (text) await send(text);
        return;
      }

      // Adiciona resposta do modelo ao histórico (com function calls)
      contents.push({ role: 'model', parts });

      // Executa ferramentas e coleta respostas
      const responseParts: GeminiPart[] = [];
      for (const part of funcParts) {
        const { name, args } = part.functionCall!;
        console.log(`[AI Engine Gemini] Tool: ${name}`, args);
        const result = await executeTool(name, args, toolCtx);
        // Gemini exige que functionResponse.response seja sempre um objeto (nunca array)
        const responseObj = Array.isArray(result) ? { result } : (result as object);
        responseParts.push({
          functionResponse: { name, response: responseObj },
        });
      }

      // Adiciona respostas das ferramentas como mensagem do usuário
      contents.push({ role: 'user', parts: responseParts });
    }

    await send('Não consegui processar. Digite *menu* para recomeçar ou ligue para a recepção. 🙏');

  } catch (err) {
    console.error('[AI Engine Gemini] Erro:', err);
    await send('Estou com uma instabilidade momentânea. Tente novamente em instantes. 🙏');
  }
}
