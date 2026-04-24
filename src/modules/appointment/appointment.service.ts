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
  return prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelReason: reason ?? 'Cancelado pelo paciente via WhatsApp',
    },
  });
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
