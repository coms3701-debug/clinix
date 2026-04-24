import { prisma } from '../../database.js';
import { twilioAdapter } from '../../providers/twilio.adapter.js';
import { getAvailableSlots, groupSlotsByDate } from '../appointment/availability.service.js';
import { createAppointment, cancelAppointment, getPatientAppointments } from '../appointment/appointment.service.js';
import { ConversationState } from './states.js';
import { config } from '../../config.js';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function weekdayName(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return format(d, "EEEE, dd/MM", { locale: ptBR });
}

function normalizeNumber(n: string): string {
  return n.replace('whatsapp:', '');
}

// ─── Tipos internos de contexto ───────────────────────────────────────────────

interface ConvCtx {
  // Menu principal
  step?: string; // 'menu' | 'service' | 'professional' | 'date' | 'time' | 'info' | 'confirming' | 'cancel_list'

  // Seleções do agendamento
  serviceId?: string;
  serviceName?: string;
  professionalId?: string | null;
  professionalName?: string;
  selectedDate?: string;
  selectedTime?: string;
  patientName?: string;
  patientCpf?: string;

  // Dados temporários de seleção
  profList?: Array<{ id: string; name: string }>;
  slotsByDate?: Record<string, Array<{ professionalId: string; professionalName: string; date: string; time: string; startsAt: string; endsAt: string }>>;
  timesForDate?: Array<{ professionalId: string; professionalName: string; date: string; time: string; startsAt: string; endsAt: string }>;
  chosenSlot?: { professionalId: string; professionalName: string; date: string; time: string; startsAt: string; endsAt: string };
  cancelList?: string[];
}

// ─── Processador principal ────────────────────────────────────────────────────

export async function processMessage(params: {
  clinicWhatsappNumber: string;
  from: string;
  body: string;
}): Promise<void> {
  const { clinicWhatsappNumber, from, body } = params;
  const text = body.trim();
  const lower = text.toLowerCase();

  const normalizedClinicNumber = normalizeNumber(clinicWhatsappNumber);
  const normalizedFrom = normalizeNumber(from);
  const toNumber = normalizedFrom.startsWith('+') ? normalizedFrom : `+${normalizedFrom}`;

  // 1. Localizar clínica (tenant)
  const clinic = await prisma.clinic.findFirst({
    where: { whatsappNumber: { in: [normalizedClinicNumber, `+${normalizedClinicNumber}`] } },
    include: { services: { where: { active: true } } },
  });

  if (!clinic) {
    console.warn(`[Engine] Clínica não encontrada para número: ${normalizedClinicNumber}`);
    return;
  }

  // 2. Buscar ou criar conversa
  let conversation = await prisma.conversation.findFirst({
    where: { clinicId: clinic.id, whatsappNumber: { in: [normalizedFrom, `+${normalizedFrom}`] } },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        clinicId: clinic.id,
        whatsappNumber: normalizedFrom,
        state: ConversationState.IDLE,
        context: {},
      },
    });
  }

  const ctx: ConvCtx = (conversation.context as ConvCtx) ?? {};

  // 3. Buscar ou criar paciente
  let patient = await prisma.patient.findFirst({
    where: { clinicId: clinic.id, whatsappNumber: { in: [normalizedFrom, `+${normalizedFrom}`] } },
  });

  if (!patient) {
    patient = await prisma.patient.create({
      data: { clinicId: clinic.id, whatsappNumber: normalizedFrom, lgpdConsentAt: new Date() },
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { patientId: patient.id } });
  }

  // 4. Salvar mensagem recebida
  await prisma.message.create({
    data: { conversationId: conversation.id, direction: 'INBOUND', body: text },
  });

  // ── Helpers locais ────────────────────────────────────────────────────────
  const convId = conversation.id;

  async function send(msg: string): Promise<void> {
    await twilioAdapter.sendText({ to: toNumber, body: msg });
    await prisma.message.create({ data: { conversationId: convId, direction: 'OUTBOUND', body: msg } });
  }

  // ── Roteamento: IA ou máquina de estados ─────────────────────────────────
  if (config.gemini.apiKey) {
    try {
      console.log('[Engine] Modo IA ativado (Gemini) — carregando ai.engine...');
      const { processWithAI } = await import('./ai.engine.js');
      await processWithAI({
        clinic,
        patient,
        conversationId: convId,
        text,
        send,
      });
    } catch (err) {
      console.error('[Engine] Erro no modo IA, caindo para modo clássico:', err);
      // continua para o modo clássico abaixo
    }
    return;
  }

  // ── Modo clássico (máquina de estados) ───────────────────────────────────
  console.log('[Engine] Modo clássico (sem OPENAI_API_KEY)');

  async function save(newCtx: ConvCtx, newState?: ConversationState): Promise<void> {
    await prisma.conversation.update({
      where: { id: convId },
      data: {
        context: newCtx as any,
        lastMessageAt: new Date(),
        ...(newState !== undefined ? { state: newState } : {}),
      },
    });
  }

  // ── Detectar comandos globais ─────────────────────────────────────────────
  const isReset = ['menu', 'oi', 'ola', 'olá', 'inicio', 'início', 'oioi', 'bom dia', 'boa tarde', 'boa noite'].includes(lower);

  if (isReset || conversation.state === ConversationState.IDLE || conversation.state === ConversationState.DONE) {
    await sendMenu(clinic, send, save, patient.id);
    return;
  }

  // ── Máquina de estados via ctx.step ──────────────────────────────────────
  const step = ctx.step ?? 'menu';

  switch (step) {
    // ── Menu principal ──────────────────────────────────────────────────────
    case 'menu': {
      if (text === '1') {
        await sendServiceList(clinic, send, save);
      } else if (text === '2') {
        await sendMyAppointments(clinic, patient.id, send, save);
      } else if (text === '3') {
        await sendCancelList(clinic, patient.id, send, save);
      } else if (text === '4') {
        await sendWaitlist(clinic, patient.id, send, save);
      } else if (text === '5') {
        await send(`Para falar com a recepção:\n📍 ${clinic.address ?? clinic.name}\n\nDigite *menu* para voltar.`);
        await save({ step: 'menu' });
      } else {
        await send(`Por favor, responda com o número:\n1. Agendar consulta\n2. Meus agendamentos\n3. Cancelar consulta\n4. Lista de espera\n5. Falar com a recepção`);
      }
      break;
    }

    // ── Escolha de serviço ──────────────────────────────────────────────────
    case 'service': {
      const idx = parseInt(text, 10) - 1;
      const services = clinic.services;
      if (idx < 0 || idx >= services.length) {
        const list = services.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
        await send(`Opção inválida. Escolha:\n${list}`);
        break;
      }
      const service = services[idx]!;
      await sendProfessionalList(clinic, service.id, service.name, send, save);
      break;
    }

    // ── Escolha de profissional ─────────────────────────────────────────────
    case 'professional': {
      const profList = ctx.profList ?? [];
      const idx = parseInt(text, 10) - 1;
      let chosenProfId: string | null = null;
      let chosenProfName = 'Profissional disponível';

      if (idx === profList.length) {
        // Qualquer disponível
      } else if (idx >= 0 && idx < profList.length) {
        chosenProfId = profList[idx]!.id;
        chosenProfName = profList[idx]!.name;
      } else {
        const list = profList.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
        await send(`Opção inválida. Escolha:\n${list}\n${profList.length + 1}. Qualquer disponível`);
        break;
      }

      await send(`🔍 Buscando horários disponíveis...`);
      await sendDateList(clinic, ctx.serviceId!, ctx.serviceName!, chosenProfId, chosenProfName, send, save);
      break;
    }

    // ── Escolha de data ─────────────────────────────────────────────────────
    case 'date': {
      const slotsByDate = ctx.slotsByDate ?? {};
      const dates = Object.keys(slotsByDate);

      if (lower === 'mais') {
        await send(`Para ver mais horários, entre em contato com a recepção ou tente *menu* para recomeçar.`);
        break;
      }
      const idx = parseInt(text, 10) - 1;
      if (idx < 0 || idx >= dates.length) {
        await send(`Opção inválida. Digite o número da data (${dates.map((_, i) => i + 1).join(', ')}) ou *mais*.`);
        break;
      }

      const selectedDate = dates[idx]!;
      const timesForDate = slotsByDate[selectedDate]!;
      const timeList = timesForDate.map((s, i) => `${i + 1}. ${s.time}`).join('\n');
      await send(`Você escolheu *${weekdayName(selectedDate)}*.\n\nQual horário?\n\n${timeList}`);
      await save({ ...ctx, step: 'time', selectedDate, timesForDate });
      break;
    }

    // ── Escolha de horário ──────────────────────────────────────────────────
    case 'time': {
      const timesForDate = ctx.timesForDate ?? [];
      // Aceita número (1, 2, 3...) ou horário exato (08:30)
      const byIndex = timesForDate[parseInt(text, 10) - 1];
      const slot = byIndex ?? timesForDate.find((s) => s.time === text);
      if (!slot) {
        const options = timesForDate.map((s, i) => `${i + 1}. ${s.time}`).join('\n');
        await send(`Horário inválido. Escolha:\n${options}`);
        break;
      }
      await send(`Para finalizar, me diga seu *nome completo* e *CPF* (só números):\n_Ex: Maria Silva 12345678900_`);
      await save({ ...ctx, step: 'info', selectedTime: slot.time, chosenSlot: slot });
      break;
    }

    // ── Coleta de dados ─────────────────────────────────────────────────────
    case 'info': {
      const parts = text.split(/\s+/);
      const cpf = parts[parts.length - 1]!.replace(/\D/g, '');
      const fullName = parts.slice(0, -1).join(' ');

      if (fullName.length < 3 || cpf.length < 11) {
        await send(`Por favor, informe *nome completo* e *CPF*:\n_Ex: Maria Silva 12345678900_`);
        break;
      }

      await prisma.patient.update({ where: { id: patient.id }, data: { fullName, cpf } });

      const prof = ctx.professionalName ?? 'Profissional disponível';
      const msg =
        `✅ Confirmar agendamento?\n\n` +
        `📋 *${ctx.serviceName}*\n` +
        `👩‍⚕️ ${prof}\n` +
        `📅 ${weekdayName(ctx.selectedDate!)} às ${ctx.selectedTime}\n` +
        `👤 ${fullName}\n\n` +
        `Responda *SIM* para confirmar ou *NÃO* para cancelar.`;
      await send(msg);
      await save({ ...ctx, step: 'confirming', patientName: fullName, patientCpf: cpf });
      break;
    }

    // ── Confirmação ─────────────────────────────────────────────────────────
    case 'confirming': {
      if (['sim', 's', '1'].includes(lower)) {
        const slot = ctx.chosenSlot;
        if (!slot || !ctx.serviceId) {
          await send(`Ocorreu um erro. Digite *menu* para recomeçar.`);
          await save({}, ConversationState.IDLE);
          break;
        }

        const result = await createAppointment({
          clinicId: clinic.id,
          patientId: patient.id,
          slot: { ...slot, startsAt: new Date(slot.startsAt), endsAt: new Date(slot.endsAt) },
          serviceId: ctx.serviceId,
        });

        if (!result.success) {
          await send(`😔 Este horário acabou de ser preenchido por outro paciente. Digite *menu* para escolher outro.`);
          await save({}, ConversationState.IDLE);
          break;
        }

        const profName = ctx.professionalName !== 'Profissional disponível'
          ? ctx.professionalName
          : result.appointment?.professional.name;

        await send(
          `✅ *Agendamento confirmado!*\n\n` +
          `📋 ${ctx.serviceName}\n` +
          `👩‍⚕️ ${profName}\n` +
          `📅 ${weekdayName(ctx.selectedDate!)} às ${ctx.selectedTime}\n` +
          `📍 ${clinic.address ?? clinic.name}\n\n` +
          `Você receberá um lembrete na véspera. Qualquer dúvida é só chamar! 😊`,
        );
        await save({}, ConversationState.DONE);
      } else if (['não', 'nao', 'n', '2'].includes(lower)) {
        await send(`Ok! Agendamento cancelado. Digite *menu* para recomeçar.`);
        await save({}, ConversationState.IDLE);
      } else {
        await send(`Por favor, responda *SIM* para confirmar ou *NÃO* para cancelar.`);
      }
      break;
    }

    // ── Lista de cancelamento ────────────────────────────────────────────────
    case 'cancel_list': {
      const cancelList = ctx.cancelList ?? [];
      if (lower === 'menu') {
        await sendMenu(clinic, send, save, patient.id);
        break;
      }
      const idx = parseInt(text, 10) - 1;
      if (idx < 0 || idx >= cancelList.length) {
        await send(`Por favor, digite o número da consulta (${cancelList.map((_, i) => i + 1).join(', ')}) ou *menu*.`);
        break;
      }
      await cancelAppointment(cancelList[idx]!, 'Cancelado pelo paciente via WhatsApp');
      await send(`✅ Consulta cancelada com sucesso.\n\nDigite *menu* para voltar ao início.`);
      await save({}, ConversationState.IDLE);
      break;
    }

    default: {
      await sendMenu(clinic, send, save, patient.id);
    }
  }
}

// ─── Funções auxiliares de envio ──────────────────────────────────────────────

async function sendMenu(
  clinic: { assistantName: string; name: string; services: any[] },
  send: (msg: string) => Promise<void>,
  save: (ctx: ConvCtx, state?: ConversationState) => Promise<void>,
  _patientId: string,
): Promise<void> {
  await send(
    `Olá! 👋 Sou *${clinic.assistantName}*, assistente da *${clinic.name}*.\n\n` +
    `Como posso te ajudar?\n1. Agendar consulta\n2. Meus agendamentos\n3. Cancelar consulta\n4. Lista de espera\n5. Falar com a recepção`,
  );
  await save({ step: 'menu' }, ConversationState.CHOOSING_SERVICE);
}

async function sendServiceList(
  clinic: { id: string; services: Array<{ id: string; name: string }> },
  send: (msg: string) => Promise<void>,
  save: (ctx: ConvCtx, state?: ConversationState) => Promise<void>,
): Promise<void> {
  const services = clinic.services;
  if (services.length === 0) {
    await send(`Nenhum serviço disponível no momento. Entre em contato com a recepção.`);
    return;
  }
  const list = services.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
  await send(`Qual serviço você procura?\n\n${list}`);
  await save({ step: 'service' });
}

async function sendProfessionalList(
  clinic: { id: string },
  serviceId: string,
  serviceName: string,
  send: (msg: string) => Promise<void>,
  save: (ctx: ConvCtx) => Promise<void>,
): Promise<void> {
  const professionals = await prisma.professional.findMany({
    where: { clinicId: clinic.id, active: true, services: { some: { serviceId } } },
  });

  if (professionals.length === 0) {
    await send(`Nenhum profissional disponível para esse serviço. Entre em contato com a recepção.`);
    return;
  }

  const list = professionals.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
  await send(`Com qual profissional?\n\n${list}\n${professionals.length + 1}. Qualquer disponível`);
  await save({
    step: 'professional',
    serviceId,
    serviceName,
    profList: professionals.map((p) => ({ id: p.id, name: p.name })),
  });
}

async function sendDateList(
  clinic: { id: string; timezone: string },
  serviceId: string,
  serviceName: string,
  professionalId: string | null,
  professionalName: string,
  send: (msg: string) => Promise<void>,
  save: (ctx: ConvCtx) => Promise<void>,
): Promise<void> {
  const slots = await getAvailableSlots({
    clinicId: clinic.id,
    serviceId,
    professionalId: professionalId ?? undefined,
    timezone: clinic.timezone,
  });

  if (slots.length === 0) {
    await send(`Não há horários disponíveis nos próximos 14 dias. Entre em contato com a recepção.\n\nDigite *menu* para voltar.`);
    return;
  }

  const grouped = groupSlotsByDate(slots, 3, 5);
  const dates = [...grouped.keys()];

  let msg = `Próximas datas disponíveis:\n\n`;
  dates.forEach((d, i) => {
    const times = grouped.get(d)!.map((s) => s.time).join(' / ');
    msg += `${i + 1}. *${weekdayName(d)}*\n   ${times}\n\n`;
  });
  msg += `Digite o número da data ou *mais* para ver mais opções.`;

  await send(msg);

  // Serializar slots (sem objetos Date para poder guardar no JSON)
  const slotsByDate: Record<string, any[]> = {};
  for (const [date, slotList] of grouped.entries()) {
    slotsByDate[date] = slotList.map((s) => ({
      ...s,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
    }));
  }

  await save({
    step: 'date',
    serviceId,
    serviceName,
    professionalId,
    professionalName,
    slotsByDate,
  });
}

async function sendMyAppointments(
  clinic: { id: string },
  patientId: string,
  send: (msg: string) => Promise<void>,
  save: (ctx: ConvCtx, state?: ConversationState) => Promise<void>,
): Promise<void> {
  const appts = await getPatientAppointments(patientId, clinic.id);
  if (appts.length === 0) {
    await send(`Você não tem consultas agendadas. Digite *menu* para agendar. 😊`);
  } else {
    const lines = appts
      .map((a) => `📅 ${format(a.startsAt, "dd/MM/yyyy 'às' HH:mm")} — ${a.service.name} com ${a.professional.name}`)
      .join('\n');
    await send(`Suas consultas:\n\n${lines}\n\nDigite *menu* para voltar.`);
  }
  await save({}, ConversationState.DONE);
}

async function sendCancelList(
  clinic: { id: string },
  patientId: string,
  send: (msg: string) => Promise<void>,
  save: (ctx: ConvCtx, state?: ConversationState) => Promise<void>,
): Promise<void> {
  const appts = await getPatientAppointments(patientId, clinic.id);
  if (appts.length === 0) {
    await send(`Você não tem consultas para cancelar. Digite *menu* para voltar.`);
    await save({}, ConversationState.IDLE);
    return;
  }
  const lines = appts
    .map((a, i) => `${i + 1}. ${format(a.startsAt, "dd/MM 'às' HH:mm")} — ${a.professional.name} (${a.service.name})`)
    .join('\n');
  await send(`Qual consulta deseja cancelar?\n\n${lines}\n\n(Digite o número ou *menu* para voltar)`);
  await save({ step: 'cancel_list', cancelList: appts.map((a) => a.id) }, ConversationState.WAITING_RESCHEDULING);
}

async function sendWaitlist(
  clinic: { id: string; name: string; services: Array<{ id: string; name: string }> },
  patientId: string,
  send: (msg: string) => Promise<void>,
  save: (ctx: ConvCtx, state?: ConversationState) => Promise<void>,
): Promise<void> {
  // Verifica se já está na lista de espera
  const existing = await prisma.waitlistEntry.findFirst({
    where: { clinicId: clinic.id, patientId, status: 'WAITING' },
  });

  if (existing) {
    await send(`✅ Você já está na nossa lista de espera! Assim que um horário abrir, entraremos em contato.\n\nDigite *menu* para voltar.`);
    await save({}, ConversationState.DONE);
    return;
  }

  await prisma.waitlistEntry.create({
    data: { clinicId: clinic.id, patientId, status: 'WAITING' },
  });

  await send(
    `✅ *Você foi adicionado à lista de espera!*\n\n` +
    `Assim que houver uma vaga disponível, entraremos em contato pelo WhatsApp.\n\n` +
    `_Você pode cancelar a qualquer momento digitando *menu*._`,
  );
  await save({}, ConversationState.DONE);
}

// ─── Processador de resposta ao lembrete ─────────────────────────────────────

export async function processReminderReply(params: {
  from: string;
  body: string;
  clinicId: string;
  appointmentId: string;
}): Promise<void> {
  const { from, body, clinicId, appointmentId } = params;
  const lower = body.toLowerCase().trim();
  const toNumber = from.startsWith('+') ? from : `+${from}`;

  const conversation = await prisma.conversation.findFirst({
    where: { clinicId, whatsappNumber: normalizeNumber(from) },
  });

  async function send(msg: string): Promise<void> {
    await twilioAdapter.sendText({ to: toNumber, body: msg });
    if (conversation) {
      await prisma.message.create({ data: { conversationId: conversation.id, direction: 'OUTBOUND', body: msg } });
    }
  }

  if (lower.includes('confirmar') || lower === '✅') {
    await prisma.appointment.update({ where: { id: appointmentId }, data: { status: 'CONFIRMED', confirmedAt: new Date() } });
    await send(`✅ Ótimo! Sua consulta está confirmada. Até amanhã! 😊`);
    return;
  }
  if (lower.includes('cancelar') || lower === '❌') {
    await cancelAppointment(appointmentId, 'Cancelado pelo paciente via lembrete');
    await send(`Consulta cancelada. Para reagendar, envie *menu*. 😊`);
    return;
  }
  if (lower.includes('remarcar') || lower === '🔄') {
    await send(`Para remarcar, envie *menu* e escolha a opção de agendamento. 😊`);
    return;
  }

  await send(`Responda:\n✅ CONFIRMAR\n🔄 REMARCAR\n❌ CANCELAR`);
}
