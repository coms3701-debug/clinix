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
      professional: { select: { name: true } },
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
 * antigo da lista de encaixe (compatível com o serviço, quando informado).
 * A entrada vira NOTIFIED — o agendamento em si acontece pelo fluxo normal
 * do bot quando o paciente responder (a vaga cancelada volta a aparecer
 * como disponível).
 */
async function notifyWaitlistAboutOpening(appointment: {
  clinicId: string;
  startsAt: Date;
  clinic: { name: string; timezone: string };
  service: { id: string; name: string } | null;
  professional: { name: string } | null;
}) {
  if (appointment.startsAt <= new Date()) return; // vaga no passado não interessa

  const entry = await prisma.waitlistEntry.findFirst({
    where: {
      clinicId: appointment.clinicId,
      status: 'WAITING',
      OR: [{ serviceId: null }, { serviceId: appointment.service?.id ?? null }],
    },
    orderBy: { createdAt: 'asc' },
    include: { patient: { select: { fullName: true, whatsappNumber: true } } },
  });
  if (!entry) return;

  const { toZonedTime } = await import('date-fns-tz');
  const { format } = await import('date-fns');
  const { ptBR } = await import('date-fns/locale');
  const local = toZonedTime(appointment.startsAt, appointment.clinic.timezone);
  const when = format(local, "EEEE, dd/MM 'às' HH:mm", { locale: ptBR });

  const firstName = entry.patient.fullName?.split(' ')[0] || 'paciente';
  const msg =
    `Olá, ${firstName}! 🎉 Boa notícia: abriu um horário na ${appointment.clinic.name}!\n\n` +
    `📋 ${appointment.service?.name ?? 'Consulta'}` +
    (appointment.professional ? ` com ${appointment.professional.name}` : '') +
    `\n🗓 ${when}\n\n` +
    `Você está na nossa lista de encaixe — *responda esta mensagem* para garantir a vaga! 😊`;

  const { twilioAdapter } = await import('../../providers/twilio.adapter.js');
  await twilioAdapter.sendText({ to: entry.patient.whatsappNumber, body: msg });

  await prisma.waitlistEntry.update({
    where: { id: entry.id },
    data: { status: 'NOTIFIED', notifiedAt: new Date() },
  });
  console.info(`[Waitlist] Vaga oferecida a ${entry.patient.whatsappNumber} (entrada ${entry.id})`);
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
