import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seed...');

  // ── Clínica demo ──────────────────────────────────────────
  const clinic = await prisma.clinic.upsert({
    where: { slug: 'dermato-demo' },
    update: {},
    create: {
      name: 'AL Aguiar Marques',
      slug: 'dermato-demo',
      specialty: 'DERMATOLOGY',
      whatsappNumber: '+14155238886', // Twilio Sandbox
      assistantName: 'Bella',
      address: 'Av. Paulista, 1000 — São Paulo/SP',
      timezone: 'America/Sao_Paulo',
      reminderHourLocal: 18,
    },
  });

  console.log(`✅ Clínica: ${clinic.name} (id: ${clinic.id})`);

  // ── Serviços ─────────────────────────────────────────────
  const services = await Promise.all([
    prisma.service.upsert({
      where: { id: 'svc-consulta' },
      update: {},
      create: {
        id: 'svc-consulta',
        clinicId: clinic.id,
        name: 'Consulta Dermatológica',
        description: 'Consulta geral com dermatologista',
        durationMin: 30,
        priceCents: 25000, // R$ 250,00
        active: true,
      },
    }),
    prisma.service.upsert({
      where: { id: 'svc-mapeamento' },
      update: {},
      create: {
        id: 'svc-mapeamento',
        clinicId: clinic.id,
        name: 'Laser',
        description: 'Tratamento a laser para diversas condições de pele',
        durationMin: 60,
        priceCents: 45000,
        requestsTriagePhotos: true,
        active: true,
      },
    }),
    prisma.service.upsert({
      where: { id: 'svc-procedimento' },
      update: {},
      create: {
        id: 'svc-procedimento',
        clinicId: clinic.id,
        name: 'Procedimento Estético',
        description: 'Toxina botulínica, preenchimento, peeling, etc.',
        durationMin: 45,
        priceCents: 80000,
        active: true,
      },
    }),
  ]);

  console.log(`✅ Serviços: ${services.map((s) => s.name).join(', ')}`);

  // ── Profissionais ─────────────────────────────────────────
  const profAna = await prisma.professional.upsert({
    where: { id: 'prof-ana' },
    update: {},
    create: {
      id: 'prof-ana',
      clinicId: clinic.id,
      name: 'Dra. Ana Luiza Aguiar',
      registration: 'CRM-SP 123456',
      bio: 'Especialista em dermatologia clínica e estética.',
      active: true,
      services: {
        create: services.map((s) => ({ serviceId: s.id })),
      },
    },
  });

  const profBruno = await prisma.professional.upsert({
    where: { id: 'prof-bruno' },
    update: {},
    create: {
      id: 'prof-bruno',
      clinicId: clinic.id,
      name: 'Dr. Bruno Costa',
      registration: 'CRM-SP 654321',
      bio: 'Dermatologista com foco em oncologia cutânea e mapeamento de pintas.',
      active: true,
      services: {
        create: services.map((s) => ({ serviceId: s.id })),
      },
    },
  });

  console.log(`✅ Profissionais: ${profAna.name}, ${profBruno.name}`);

  // ── Horários de trabalho ──────────────────────────────────
  // Dra. Ana: Seg a Sex, 08:00 - 17:00 (slots de 30 min)
  const anaDays = [1, 2, 3, 4, 5]; // Seg-Sex
  for (const day of anaDays) {
    await prisma.workSchedule.upsert({
      where: { id: `ws-ana-${day}` },
      update: {},
      create: {
        id: `ws-ana-${day}`,
        professionalId: profAna.id,
        dayOfWeek: day,
        startTime: '08:00',
        endTime: '17:00',
        slotMinutes: 30,
      },
    });
  }

  // Dr. Bruno: Seg, Qua, Sex — 09:00 - 18:00 (slots de 30 min)
  const brunoDays = [1, 3, 5];
  for (const day of brunoDays) {
    await prisma.workSchedule.upsert({
      where: { id: `ws-bruno-${day}` },
      update: {},
      create: {
        id: `ws-bruno-${day}`,
        professionalId: profBruno.id,
        dayOfWeek: day,
        startTime: '09:00',
        endTime: '18:00',
        slotMinutes: 30,
      },
    });
  }

  console.log('✅ Horários cadastrados');
  console.log('\n🎉 Seed concluído! Clínica demo pronta.');
  console.log(`\n⚠️  Lembre de atualizar o whatsappNumber da clínica para o seu número Twilio:`);
  console.log(`   ID da clínica: ${clinic.id}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
