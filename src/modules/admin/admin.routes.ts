import type { FastifyInstance } from 'fastify';
import { prisma } from '../../database.js';
import { z } from 'zod';
import { format, subDays, startOfDay, endOfDay, addMinutes } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { getAvailableSlots } from '../appointment/availability.service.js';

export async function adminRoutes(app: FastifyInstance) {
  // ── Health ─────────────────────────────────────────────────
  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // ── Clínicas ──────────────────────────────────────────────
  app.get('/v1/clinics', async () => {
    return prisma.clinic.findMany({ orderBy: { name: 'asc' } });
  });

  app.get<{ Params: { id: string } }>('/v1/clinics/:id', async (req, reply) => {
    const clinic = await prisma.clinic.findUnique({
      where: { id: req.params.id },
      include: {
        professionals: { where: { active: true }, include: { workSchedules: true } },
        services: { where: { active: true } },
      },
    });
    if (!clinic) return reply.status(404).send({ error: 'Clínica não encontrada' });
    return clinic;
  });

  // ── Profissionais ─────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/clinics/:id/professionals',
    async (req, reply) => {
      const schema = z.object({
        name: z.string().min(2),
        registration: z.string().min(1),
        bio: z.string().optional(),
        serviceIds: z.array(z.string()).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send(parsed.error);

      const { serviceIds, ...data } = parsed.data;
      const prof = await prisma.professional.create({
        data: {
          ...data,
          clinicId: req.params.id,
          ...(serviceIds?.length
            ? { services: { create: serviceIds.map((sid) => ({ serviceId: sid })) } }
            : {}),
        } as any,
      });
      return reply.status(201).send(prof);
    },
  );

  // ── Serviços ─────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/clinics/:id/services',
    async (req, reply) => {
      const schema = z.object({
        name: z.string().min(2),
        description: z.string().optional(),
        durationMin: z.number().int().min(10),
        priceCents: z.number().int().default(0),
        requestsTriagePhotos: z.boolean().default(false),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send(parsed.error);

      const service = await prisma.service.create({
        data: { ...parsed.data, clinicId: req.params.id } as any,
      });
      return reply.status(201).send(service);
    },
  );

  // ── Agendamentos ─────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { date?: string; professionalId?: string; status?: string } }>(
    '/v1/clinics/:id/appointments',
    async (req) => {
      const { date, professionalId, status } = req.query;
      const targetDate = date ? new Date(date) : new Date();

      return prisma.appointment.findMany({
        where: {
          clinicId: req.params.id,
          ...(date ? { startsAt: { gte: startOfDay(targetDate), lte: endOfDay(targetDate) } } : {}),
          ...(professionalId ? { professionalId } : {}),
          ...(status ? { status: status as any } : {}),
        },
        include: {
          professional: { select: { id: true, name: true } },
          service: { select: { id: true, name: true } },
          patient: { select: { id: true, fullName: true, whatsappNumber: true } },
        },
        orderBy: { startsAt: 'asc' },
      });
    },
  );

  app.post<{ Params: { id: string } }>('/v1/appointments/:id/cancel', async (req, reply) => {
    const appt = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    if (!appt) return reply.status(404).send({ error: 'Agendamento não encontrado' });

    const updated = await prisma.appointment.update({
      where: { id: req.params.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'Cancelado pelo admin' },
    });
    return updated;
  });

  // ── Dashboard / KPIs ─────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/clinics/:id/dashboard', async (req) => {
    const clinicId = req.params.id;
    const today = new Date();
    const thirtyDaysAgo = subDays(today, 30);

    const [
      totalScheduled,
      totalConfirmed,
      totalNoShow,
      totalCancelled,
      todayAppointments,
      upcomingAppointments,
      totalPatients,
    ] = await Promise.all([
      prisma.appointment.count({ where: { clinicId, status: 'SCHEDULED', startsAt: { gte: thirtyDaysAgo } } }),
      prisma.appointment.count({ where: { clinicId, status: 'CONFIRMED', startsAt: { gte: thirtyDaysAgo } } }),
      prisma.appointment.count({ where: { clinicId, status: 'NO_SHOW', startsAt: { gte: thirtyDaysAgo } } }),
      prisma.appointment.count({ where: { clinicId, status: 'CANCELLED', startsAt: { gte: thirtyDaysAgo } } }),
      prisma.appointment.findMany({
        where: { clinicId, startsAt: { gte: startOfDay(today), lte: endOfDay(today) } },
        include: {
          professional: { select: { name: true } },
          service: { select: { name: true } },
          patient: { select: { fullName: true } },
        },
        orderBy: { startsAt: 'asc' },
      }),
      prisma.appointment.count({
        where: { clinicId, status: { in: ['SCHEDULED', 'CONFIRMED'] }, startsAt: { gte: today } },
      }),
      prisma.patient.count({ where: { clinicId } }),
    ]);

    const total30d = totalScheduled + totalConfirmed + totalNoShow + totalCancelled;
    const noShowRate = total30d > 0 ? ((totalNoShow / total30d) * 100).toFixed(1) : '0.0';

    return {
      period: '30 dias',
      kpis: {
        totalAgendamentos: total30d,
        confirmados: totalConfirmed,
        noShow: totalNoShow,
        cancelados: totalCancelled,
        noShowRate: `${noShowRate}%`,
        totalPacientes: totalPatients,
        proximosAgendamentos: upcomingAppointments,
      },
      hoje: todayAppointments,
    };
  });

  // ── Pacientes ─────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/v1/clinics/:id/patients',
    async (req) => {
      const { q } = req.query;
      return prisma.patient.findMany({
        where: {
          clinicId: req.params.id,
          ...(q
            ? {
                OR: [
                  { fullName: { contains: q, mode: 'insensitive' } },
                  { whatsappNumber: { contains: q } },
                  { cpf: { contains: q } },
                ],
              }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
    },
  );

  // ── Listar profissionais ──────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/clinics/:id/professionals', async (req) => {
    return prisma.professional.findMany({
      where: { clinicId: req.params.id, active: true },
      include: {
        services: { include: { service: { select: { id: true, name: true } } } },
      },
      orderBy: { name: 'asc' },
    });
  });

  // ── Listar serviços ───────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/clinics/:id/services', async (req) => {
    return prisma.service.findMany({
      where: { clinicId: req.params.id, active: true },
      orderBy: { name: 'asc' },
    });
  });

  // ── Slots disponíveis ─────────────────────────────────────
  app.get<{
    Params: { id: string };
    Querystring: { serviceId?: string; professionalId?: string; daysAhead?: string };
  }>('/v1/clinics/:id/slots', async (req, reply) => {
    const { serviceId, professionalId, daysAhead } = req.query;
    if (!serviceId) return reply.status(400).send({ error: 'serviceId é obrigatório' });

    const clinic = await prisma.clinic.findUnique({ where: { id: req.params.id } });
    if (!clinic) return reply.status(404).send({ error: 'Clínica não encontrada' });

    const slots = await getAvailableSlots({
      clinicId: req.params.id,
      serviceId,
      professionalId: professionalId || undefined,
      timezone: clinic.timezone,
      daysAhead: daysAhead ? parseInt(daysAhead) : 30,
    });

    return slots.map((s) => ({
      professionalId: s.professionalId,
      professionalName: s.professionalName,
      date: s.date,
      time: s.time,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
    }));
  });

  // ── Criar agendamento (admin) ─────────────────────────────
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/clinics/:id/appointments',
    async (req, reply) => {
      const schema = z.object({
        patientId: z.string().min(1),
        professionalId: z.string().min(1),
        serviceId: z.string().min(1),
        startsAt: z.string().min(1), // ISO datetime
        notes: z.string().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send(parsed.error);

      const { patientId, professionalId, serviceId, startsAt, notes } = parsed.data;

      const service = await prisma.service.findUnique({ where: { id: serviceId } });
      if (!service) return reply.status(404).send({ error: 'Serviço não encontrado' });

      const startsAtDate = new Date(startsAt);
      const endsAt = addMinutes(startsAtDate, service.durationMin);

      const appt = await prisma.appointment.create({
        data: {
          clinicId: req.params.id,
          patientId,
          professionalId,
          serviceId,
          startsAt: startsAtDate,
          endsAt,
          status: 'CONFIRMED',
          triageNotes: notes ?? null,
        },
        include: {
          patient: { select: { id: true, fullName: true, whatsappNumber: true } },
          professional: { select: { id: true, name: true } },
          service: { select: { id: true, name: true } },
        },
      });

      return reply.status(201).send(appt);
    },
  );

  // ── Horários dos profissionais ────────────────────────────
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/professionals/:id/schedules',
    async (req, reply) => {
      const schema = z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
        slotMinutes: z.number().int().default(30),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send(parsed.error);

      const schedule = await prisma.workSchedule.create({
        data: { ...parsed.data, professionalId: req.params.id } as any,
      });
      return reply.status(201).send(schedule);
    },
  );

  // ── Lista de Encaixe ──────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/clinics/:id/waitlist', async (req) => {
    const entries = await prisma.waitlistEntry.findMany({
      where: { clinicId: req.params.id, status: 'WAITING' },
      include: {
        patient: { select: { id: true, fullName: true, whatsappNumber: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const [services, professionals] = await Promise.all([
      prisma.service.findMany({ where: { clinicId: req.params.id }, select: { id: true, name: true } }),
      prisma.professional.findMany({ where: { clinicId: req.params.id }, select: { id: true, name: true } }),
    ]);

    const serviceMap: Record<string, string> = Object.fromEntries(services.map((s) => [s.id, s.name]));
    const profMap: Record<string, string> = Object.fromEntries(professionals.map((p) => [p.id, p.name]));

    return entries.map((e) => ({
      ...e,
      service: e.serviceId ? { id: e.serviceId, name: serviceMap[e.serviceId] ?? 'N/A' } : null,
      professional: e.professionalId ? { id: e.professionalId, name: profMap[e.professionalId] ?? 'N/A' } : null,
    }));
  });

  app.post<{ Params: { id: string } }>('/v1/waitlist/:id/fulfill', async (req, reply) => {
    const entry = await prisma.waitlistEntry.findUnique({ where: { id: req.params.id } });
    if (!entry) return reply.status(404).send({ error: 'Entrada não encontrada' });
    const updated = await prisma.waitlistEntry.update({
      where: { id: req.params.id },
      data: { status: 'FULFILLED', notifiedAt: new Date() },
    });
    return updated;
  });

  app.post<{ Params: { id: string } }>('/v1/waitlist/:id/remove', async (req, reply) => {
    const entry = await prisma.waitlistEntry.findUnique({ where: { id: req.params.id } });
    if (!entry) return reply.status(404).send({ error: 'Entrada não encontrada' });
    const updated = await prisma.waitlistEntry.update({
      where: { id: req.params.id },
      data: { status: 'EXPIRED' },
    });
    return updated;
  });

  // ── Contagem de agendamentos por mês (calendário) ─────────
  app.get<{
    Params: { id: string };
    Querystring: { year?: string; month?: string };
  }>('/v1/clinics/:id/calendar', async (req) => {
    const clinic = await prisma.clinic.findUnique({ where: { id: req.params.id } });
    if (!clinic) return {};

    const year = parseInt(req.query.year || '') || new Date().getFullYear();
    const month = parseInt(req.query.month || '') || new Date().getMonth() + 1;

    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 1));

    const appointments = await prisma.appointment.findMany({
      where: {
        clinicId: req.params.id,
        status: { in: ['SCHEDULED', 'CONFIRMED'] },
        startsAt: { gte: monthStart, lt: monthEnd },
      },
      select: { startsAt: true },
    });

    const counts: Record<string, number> = {};
    for (const appt of appointments) {
      const local = toZonedTime(appt.startsAt, clinic.timezone);
      const key = format(local, 'yyyy-MM-dd');
      counts[key] = (counts[key] || 0) + 1;
    }

    return counts;
  });
}
