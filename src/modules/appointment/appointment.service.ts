import { prisma } from '../../database.js';
import type { AvailableSlot } from './availability.service.js';

export interface CreateAppointmentParams {
  clinicId: string;
  patientId: string;
  slot: AvailableSlot;
  serviceId: string;
}

export async function createAppointment(params: CreateAppointmentParams) {
  const { clinicId, patientId, slot, serviceId } = params;

  // Verificação de conflito (race condition protection)
  const conflict = await prisma.appointment.findFirst({
    where: {
      professionalId: slot.professionalId,
      status: { in: ['SCHEDULED', 'CONFIRMED'] },
      startsAt: { lt: slot.endsAt },
      endsAt: { gt: slot.startsAt },
    },
  });

  if (conflict) {
    return { success: false, reason: 'slot_taken' as const };
  }

  const appointment = await prisma.appointment.create({
    data: {
      clinicId,
      patientId,
      professionalId: slot.professionalId,
      serviceId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      status: 'SCHEDULED',
    },
    include: {
      professional: { select: { name: true } },
      service: { select: { name: true } },
      patient: { select: { fullName: true, whatsappNumber: true } },
    },
  });

  return { success: true, appointment };
}

export async function cancelAppointment(appointmentId: string, reason?: string) {
  const appointment = await prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelReason: reason ?? 'Cancelado pelo paciente via WhatsApp',
    },
    include: {
      clinic: { select: { name: true, timezone: true } },
      service: { select: { id: true, name: true } },
      professional: { select: { id: true, name: true } },
    },
  });

  // Avisa o 1º da lista de encaixe sobre a vaga aberta (fire-and-forget:
  // falha no aviso não pode impedir o cancelamento em si).
  notifyWaitlistAboutOpening(appointment).catch((err) =>
    console.error('[Waitlist] Erro ao notificar lista de encaixe:', err),
  );

  return appointment;
}

/**
 * Quando uma consulta futura é cancelada, oferece a vaga ao paciente mais
 * antigo da lista de encaixe cuja preferência (serviço, profissional, dia,
 * período) seja compatível com o horário liberado. A entrada vira NOTIFIED —
 * o agendamento em si acontece pelo fluxo normal do bot quando o paciente
 * responder (a vaga cancelada volta a aparecer como disponível).
 */
async function notifyWaitlistAboutOpening(appointment: {
  clinicId: string;
  patientId: string;
  startsAt: Date;
  clinic: { name: string; timezone: string };
  service: { id: string; name: string } | null;
  professional: { id: string; name: string } | null;
}) {
  const now = new Date();
  if (appointment.startsAt <= now) return; // vaga no passado não interessa

  // Quem só queria um dia que já passou sai da fila.
  await prisma.waitlistEntry.updateMany({
    where: { clinicId: appointment.clinicId, status: 'WAITING', preferredTo: { lt: now } },
    data: { status: 'EXPIRED' },
  });

  const candidates = await prisma.waitlistEntry.findMany({
    where: {
      clinicId: appointment.clinicId,
      status: 'WAITING',
      patientId: { not: appointment.patientId }, // não oferecer a vaga a quem acabou de cancelar
      AND: [
        { OR: [{ serviceId: null }, { serviceId: appointment.service?.id ?? '' }] },
        { OR: [{ professionalId: null }, { professionalId: appointment.professional?.id ?? '' }] },
      ],
    },
    orderBy: { createdAt: 'asc' },
    include: { patient: { select: { id: true, fullName: true, whatsappNumber: true } } },
  });

  const { formatInTimeZone } = await import('date-fns-tz');
  const { ptBR } = await import('date-fns/locale');
  const tz = appointment.clinic.timezone;
  const slotPeriod = formatInTimeZone(appointment.startsAt, tz, 'HH:mm') < '12:00' ? 'manha' : 'tarde';

  const entry = candidates.find(
    (e) =>
      (!e.preferredFrom || appointment.startsAt >= e.preferredFrom) &&
      (!e.preferredTo || appointment.startsAt <= e.preferredTo) &&
      (!e.preferredPeriod || e.preferredPeriod === slotPeriod),
  );
  if (!entry) return;

  const when = formatInTimeZone(appointment.startsAt, tz, "EEEE, dd/MM 'às' HH:mm", { locale: ptBR });
  const what =
    (appointment.service?.name ?? 'Consulta') +
    (appointment.professional ? ` com ${appointment.professional.name}` : '');
  const firstName = entry.patient.fullName?.split(' ')[0] || 'paciente';

  // Mesmo texto do modelo aprovado (clinix_vaga_encaixe), para o histórico
  // da conversa ficar idêntico ao que o paciente recebeu.
  const msg =
    `Olá, ${firstName}! Abriu um horário na ${appointment.clinic.name}: ${what} em ${when}.\n\n` +
    `Você está na nossa lista de encaixe. Responda esta mensagem se quiser essa vaga.`;

  const { sendBusinessInitiated } = await import('../../providers/outbound.js');
  const { config } = await import('../../config.js');
  const via = await sendBusinessInitiated({
    to: entry.patient.whatsappNumber,
    templateSid: config.twilio.templates.waitlistOpening,
    variables: { '1': firstName, '2': appointment.clinic.name, '3': what, '4': when },
    fallbackText: msg,
  });

  // Registra o aviso na conversa: quando o paciente responder "quero!",
  // a Bella precisa saber qual vaga foi oferecida.
  const conversation = await prisma.conversation.findFirst({
    where: { clinicId: appointment.clinicId, patientId: entry.patient.id },
    orderBy: { updatedAt: 'desc' },
  });
  if (conversation) {
    await prisma.message.create({ data: { conversationId: conversation.id, direction: 'OUTBOUND', body: msg } });
  }

  await prisma.waitlistEntry.update({
    where: { id: entry.id },
    data: { status: 'NOTIFIED', notifiedAt: new Date() },
  });
  console.info(`[Waitlist] Vaga oferecida a ${entry.patient.whatsappNumber} via ${via} (entrada ${entry.id})`);
}

export async function getPatientAppointments(patientId: string, clinicId: string) {
  return prisma.appointment.findMany({
    where: {
      patientId,
      clinicId,
      status: { in: ['SCHEDULED', 'CONFIRMED'] },
      startsAt: { gte: new Date() },
    },
    include: {
      professional: { select: { name: true } },
      service: { select: { name: true } },
    },
    orderBy: { startsAt: 'asc' },
    take: 5,
  });
}
