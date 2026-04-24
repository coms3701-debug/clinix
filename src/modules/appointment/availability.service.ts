import { prisma } from '../../database.js';
import {
  addDays,
  format,
  setHours,
  setMinutes,
  isBefore,
  startOfDay,
  addMinutes,
} from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

export interface AvailableSlot {
  professionalId: string;
  professionalName: string;
  date: string;      // "YYYY-MM-DD"
  time: string;      // "HH:MM"
  startsAt: Date;    // UTC
  endsAt: Date;      // UTC
}

/**
 * Retorna slots disponíveis para uma clínica/serviço/profissional nos próximos N dias.
 */
export async function getAvailableSlots(params: {
  clinicId: string;
  serviceId: string;
  professionalId?: string;   // undefined = qualquer disponível
  timezone: string;
  daysAhead?: number;        // padrão 14
}): Promise<AvailableSlot[]> {
  const { clinicId, serviceId, timezone, daysAhead = 14 } = params;

  const service = await prisma.service.findFirst({
    where: { id: serviceId, clinicId, active: true },
  });
  if (!service) return [];

  const slotDurMin = service.durationMin;

  const professionals = await prisma.professional.findMany({
    where: {
      clinicId,
      active: true,
      ...(params.professionalId ? { id: params.professionalId } : {}),
      services: { some: { serviceId } },
    },
    include: { workSchedules: true },
  });

  const nowUtc = new Date();
  const slots: AvailableSlot[] = [];

  for (const prof of professionals) {
    for (let dayOffset = 0; dayOffset <= daysAhead; dayOffset++) {
      const dateUtc = addDays(nowUtc, dayOffset);
      const dateLocal = toZonedTime(dateUtc, timezone);
      const dayOfWeek = dateLocal.getDay();

      const schedule = prof.workSchedules.find((ws) => ws.dayOfWeek === dayOfWeek);
      if (!schedule) continue;

      const [startH = 8, startM = 0] = schedule.startTime.split(':').map(Number);
      const [endH = 18, endM = 0] = schedule.endTime.split(':').map(Number);

      const dayStart = setMinutes(setHours(startOfDay(dateLocal), startH), startM);
      const dayEnd = setMinutes(setHours(startOfDay(dateLocal), endH), endM);

      let cursor = dayStart;

      // Avançar enquanto o slot cabe no horário de trabalho
      while (isBefore(cursor, dayEnd)) {
        const slotEnd = addMinutes(cursor, slotDurMin);

        // Slot não pode terminar depois do fim do expediente
        if (!isBefore(slotEnd, dayEnd) && slotEnd.getTime() !== dayEnd.getTime()) {
          break;
        }

        const slotStartUtc = fromZonedTime(cursor, timezone);
        const slotEndUtc = fromZonedTime(slotEnd, timezone);

        // Ignorar slots no passado (margem de 30 min)
        if (!isBefore(addMinutes(nowUtc, 30), slotStartUtc)) {
          cursor = slotEnd;
          continue;
        }

        // Verificar conflito com agendamentos existentes
        const conflict = await prisma.appointment.findFirst({
          where: {
            professionalId: prof.id,
            status: { in: ['SCHEDULED', 'CONFIRMED'] },
            startsAt: { lt: slotEndUtc },
            endsAt: { gt: slotStartUtc },
          },
        });

        if (!conflict) {
          slots.push({
            professionalId: prof.id,
            professionalName: prof.name,
            date: format(dateLocal, 'yyyy-MM-dd'),
            time: format(cursor, 'HH:mm'),
            startsAt: slotStartUtc,
            endsAt: slotEndUtc,
          });
        }

        cursor = slotEnd;
      }
    }
  }

  // Ordenar por data/hora e remover duplicatas de slot (mesmo horário, profissional diferente)
  slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return slots;
}

/**
 * Agrupa slots por data para exibição no chat.
 * Retorna até maxDates datas, cada uma com até maxTimesPerDate horários.
 */
export function groupSlotsByDate(
  slots: AvailableSlot[],
  maxDates = 3,
  maxTimesPerDate = 5,
): Map<string, AvailableSlot[]> {
  const map = new Map<string, AvailableSlot[]>();

  for (const slot of slots) {
    if (!map.has(slot.date)) {
      if (map.size >= maxDates) break;
      map.set(slot.date, []);
    }
    const list = map.get(slot.date)!;
    if (list.length < maxTimesPerDate) {
      list.push(slot);
    }
  }

  return map;
}
