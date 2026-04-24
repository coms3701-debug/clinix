/**
 * Worker de lembretes de véspera
 *
 * Roda como processo separado: npm run worker
 * Usa BullMQ para processar jobs de envio de lembrete.
 *
 * O scheduler (agendador de jobs) é chamado na inicialização do servidor
 * e toda noite verifica consultas do dia seguinte.
 */
import 'dotenv/config';
import { Worker, Queue, type Job } from 'bullmq'; // QueueScheduler foi removido no BullMQ v2+
import { prisma } from '../database.js';
import { twilioAdapter } from '../providers/twilio.adapter.js';
import { redis } from '../redis.js';
import { format, addDays, startOfDay, endOfDay } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { config } from '../config.js';

export const REMINDER_QUEUE = 'reminders';

export interface ReminderJobData {
  appointmentId: string;
  clinicId: string;
  patientNumber: string; // +5511999999999
  patientName: string;
  professionalName: string;
  startsAt: string; // ISO string
}

// ─── Worker (só inicializado quando rodado diretamente via npm run worker) ──

export function startWorker() {
  const worker = new Worker<ReminderJobData>(
    REMINDER_QUEUE,
    async (job: Job<ReminderJobData>) => {
      const { appointmentId, patientNumber, patientName, professionalName, startsAt, clinicId } = job.data;

      // Verificar se ainda está agendado
      const appointment = await prisma.appointment.findUnique({ where: { id: appointmentId } });
      if (!appointment || !['SCHEDULED', 'CONFIRMED'].includes(appointment.status)) {
        console.info(`[Reminder] Pulando job — consulta ${appointmentId} já foi cancelada/concluída`);
        return;
      }

      const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
      if (!clinic) return;

      const dateLocal = toZonedTime(new Date(startsAt), clinic.timezone);
      const dateFormatted = format(dateLocal, "dd/MM/yyyy 'às' HH:mm");

      const msg =
        `Olá ${patientName || 'paciente'}! 👋\n\n` +
        `Lembrete: você tem uma consulta *amanhã* (${dateFormatted}) com *${professionalName}* na ${clinic.name}.\n\n` +
        `Responda:\n✅ CONFIRMAR\n🔄 REMARCAR\n❌ CANCELAR`;

      await twilioAdapter.sendText({ to: patientNumber, body: msg });

      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { remindersSent: { increment: 1 } },
      });

      console.info(`[Reminder] Lembrete enviado para ${patientNumber} — consulta ${appointmentId}`);
    },
    { connection: redis, concurrency: 5 },
  );

  worker.on('completed', (job) => console.info(`[Reminder] Job ${job.id} concluído`));
  worker.on('failed', (job, err) => console.error(`[Reminder] Job ${job?.id} falhou:`, err.message));
  console.info('[Worker] Reminder worker iniciado e aguardando jobs...');
  return worker;
}

// ─── Scheduler ─────────────────────────────────────────────────

export async function scheduleReminders(): Promise<void> {
  const queue = new Queue<ReminderJobData>(REMINDER_QUEUE, { connection: redis });

  const now = new Date();
  const tomorrow = addDays(now, 1);
  const tomorrowStart = startOfDay(tomorrow);
  const tomorrowEnd = endOfDay(tomorrow);

  const appointments = await prisma.appointment.findMany({
    where: {
      status: { in: ['SCHEDULED', 'CONFIRMED'] },
      startsAt: { gte: tomorrowStart, lte: tomorrowEnd },
      remindersSent: 0,
    },
    include: {
      patient: { select: { whatsappNumber: true, fullName: true } },
      professional: { select: { name: true } },
      clinic: { select: { id: true, reminderHourLocal: true } },
    },
  });

  console.info(`[Scheduler] ${appointments.length} lembretes para agendar`);

  for (const appt of appointments) {
    await queue.add(
      'reminder',
      {
        appointmentId: appt.id,
        clinicId: appt.clinicId,
        patientNumber: appt.patient.whatsappNumber,
        patientName: appt.patient.fullName ?? '',
        professionalName: appt.professional.name,
        startsAt: appt.startsAt.toISOString(),
      },
      {
        jobId: `reminder-${appt.id}`, // idempotência: não duplica
        delay: 0, // Enviar imediatamente quando chamado à hora certa
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      },
    );
  }

  await queue.close();
}

// Iniciar worker se rodado diretamente (npm run worker)
if (process.argv[1]?.includes('reminder.worker')) {
  startWorker();
}
