# Clinix — Sistema de Agendamento via WhatsApp para Clínicas

**Clinix** é uma plataforma SaaS multi-tenant que permite a clínicas de dermatologia e odontologia gerenciarem agendamentos 100% via WhatsApp, com lembretes automáticos, prevenção inteligente de faltas (no-show), lista de espera automática e painel analítico para a clínica.

Este repositório contém o **MVP funcional** pronto para ser executado localmente e depois publicado em produção (Railway, Render, Fly.io, AWS, etc.).

---

## Índice

1. [Visão geral](#visão-geral)
2. [Diferenciais competitivos](#diferenciais-competitivos)
3. [Arquitetura](#arquitetura)
4. [Stack tecnológico](#stack-tecnológico)
5. [Como rodar localmente (passo a passo)](#como-rodar-localmente-passo-a-passo)
6. [Fluxo do paciente no WhatsApp](#fluxo-do-paciente-no-whatsapp)
7. [Integração com a Thúlio](#integração-com-a-thúlio)
8. [Endpoints da API administrativa](#endpoints-da-api-administrativa)
9. [Próximos passos](#próximos-passos)

---

## Visão geral

O paciente conversa no WhatsApp com o número da clínica. Um motor de conversação (chatbot) conduz o agendamento: identificação, escolha de serviço, escolha de profissional, escolha de data/horário disponível, confirmação. Ao concluir, o paciente recebe confirmação imediata. Na véspera da consulta, recebe lembrete automático com opções "Confirmar" ou "Remarcar". Se cancelar, a próxima pessoa da lista de espera é avisada automaticamente.

A clínica acessa um painel web (ou via API) para: cadastrar profissionais, definir horários de atendimento, ver a agenda em tempo real, acompanhar KPIs (no-show rate, faturamento projetado, NPS).

## Diferenciais competitivos

A maioria dos concorrentes (Agendor, Reserva.ai, Booksy) oferece apenas o básico. Clinix se diferencia por 10 recursos de alto valor agregado:

1. **Triagem inteligente pré-consulta** — bot coleta sintomas e, em dermatologia, solicita fotos da lesão para o médico avaliar antes. Reduz tempo de consulta e aumenta valor percebido.
2. **Prevenção de no-show por ML** — modelo de risco baseado em histórico (quantas faltas, tempo desde último agendamento, canal de origem). Pacientes de alto risco recebem 2 lembretes com pedido de confirmação explícita.
3. **Lista de espera automática** — quando alguém cancela, o sistema oferece o slot automaticamente via WhatsApp para pacientes na fila, por ordem de prioridade.
4. **Pagamento antecipado via PIX no WhatsApp** — opcional. Reduz no-show em 60% segundo pesquisas do setor.
5. **Retorno proativo (recall)** — derm: lembra de revisão anual de pintas; odonto: lembra da limpeza semestral. Reativa pacientes adormecidos, fonte enorme de receita que concorrentes ignoram.
6. **Pós-consulta automatizado** — envia instruções de cuidados, agenda retorno, e 3 dias depois pede avaliação no Google (melhora ranking local da clínica).
7. **Prontuário leve integrado** — histórico simples de consultas, receitas, fotos (derm), ligado ao cadastro do paciente. Concorrentes só fazem agendamento, sem contexto clínico.
8. **Dashboard analítico** — ocupação por profissional, horários de pico, fontes de agendamento, receita projetada, NPS — em tempo real.
9. **Multi-profissional e multi-unidade** — clínicas com várias unidades ou vários dermatologistas/dentistas podem operar tudo em um único número.
10. **Conformidade LGPD nativa** — consentimento registrado, direito ao esquecimento automatizado, logs de acesso. Crítico para dados de saúde.

## Arquitetura

```
┌──────────────┐   webhook    ┌─────────────────────────┐
│   WhatsApp   │◄────────────►│  Clinix API (Fastify)   │
│ (via Thúlio) │              │  - Webhook controller   │
└──────────────┘              │  - Conversation engine  │
                              │  - Appointment service  │
                              │  - Availability engine  │
                              └────────┬────────────────┘
                                       │
                              ┌────────┴────────┐
                              │   PostgreSQL    │
                              │ (Prisma ORM)    │
                              └─────────────────┘
                                       │
                              ┌────────┴────────┐
                              │  Redis + BullMQ │
                              │ (filas, lembrete│
                              │  de véspera)    │
                              └─────────────────┘
```

Cada clínica é um **tenant** isolado logicamente. O sistema identifica o tenant pelo número de WhatsApp que recebeu a mensagem (campo `to` no webhook da Thúlio).

## Stack tecnológico

| Camada | Tecnologia | Por quê |
|---|---|---|
| Runtime | Node.js 22 | Moderna, LTS, ecossistema maduro |
| Linguagem | TypeScript 5 | Tipagem forte reduz bugs em produção |
| Framework HTTP | Fastify | Mais rápido que Express, melhor DX |
| ORM | Prisma | Migrations fáceis, tipagem automática do DB |
| Banco | PostgreSQL 16 | Transações, JSON, partitioning |
| Filas | BullMQ (Redis) | Agendar lembretes, retry automático |
| Validação | Zod | Valida payloads da Thúlio e API admin |
| Testes | Vitest | Rápido, zero-config |
| Container | Docker Compose | Setup local em 1 comando |

## Como rodar localmente (passo a passo)

### Pré-requisitos

- **Node.js 22+** — [baixar aqui](https://nodejs.org)
- **Docker Desktop** — [baixar aqui](https://www.docker.com/products/docker-desktop/) (traz PostgreSQL e Redis prontos)
- Editor de código (recomendo **VS Code**)

### Passo 1 — Subir banco e Redis

Abra o terminal na pasta do projeto e rode:

```bash
docker compose up -d
```

Isso sobe PostgreSQL (porta 5432) e Redis (porta 6379) em background.

### Passo 2 — Instalar dependências

```bash
npm install
```

### Passo 3 — Configurar variáveis de ambiente

Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

Abra o `.env` no editor e preencha as credenciais da Thúlio (veja seção [Integração com a Thúlio](#integração-com-a-thúlio)).

### Passo 4 — Rodar as migrations e seed

```bash
npx prisma migrate dev --name init
npm run seed
```

Isso cria as tabelas e insere uma clínica de exemplo (Clínica Dermato Demo) com 2 profissionais e horários cadastrados.

### Passo 5 — Iniciar o servidor

```bash
npm run dev
```

A API sobe em `http://localhost:3000`. Teste com:

```bash
curl http://localhost:3000/health
```

Você deve receber `{"status":"ok"}`.

### Passo 6 — Expor o webhook para a Thúlio (modo dev)

A Thúlio precisa de uma URL pública para enviar as mensagens do WhatsApp para o seu servidor local. Use **ngrok** ou **Cloudflare Tunnel**:

```bash
# Em outro terminal
npx ngrok http 3000
```

Copie a URL `https://xxxx.ngrok.app` e cadastre no painel da Thúlio como webhook de entrada:
`https://xxxx.ngrok.app/webhooks/thulio`

### Passo 7 — Enviar uma mensagem de teste

Mande "Oi" pelo WhatsApp para o número cadastrado na Thúlio. O bot deve responder com o menu inicial. Pronto — você tem um MVP rodando.

## Fluxo do paciente no WhatsApp

```
Paciente: Oi
Bot: Olá! 👋 Eu sou a Clara, assistente da Clínica Dermato Demo.
     Como posso te ajudar?
     1. Agendar consulta
     2. Remarcar ou cancelar
     3. Falar com a recepção

Paciente: 1
Bot: Qual serviço você procura?
     1. Consulta dermatológica
     2. Mapeamento de pintas
     3. Procedimento estético

Paciente: 1
Bot: Com qual dermatologista?
     1. Dra. Ana Silva
     2. Dr. Bruno Costa
     3. Qualquer um disponível

Paciente: 3
Bot: Próximas datas disponíveis:
     1. Seg 22/04 — 09:00, 10:30, 14:00
     2. Ter 23/04 — 11:00, 15:30
     3. Qua 24/04 — 08:30, 13:00, 16:00
     Digite o número da opção ou "mais datas".

Paciente: 1
Bot: Você escolheu Segunda 22/04. Qual horário?
     09:00 / 10:30 / 14:00

Paciente: 10:30
Bot: Para finalizar, me confirma seu nome completo e CPF:

Paciente: Maria Silva — 123.456.789-00
Bot: ✅ Agendamento confirmado!
     📅 Segunda, 22 de abril às 10:30
     👩‍⚕️ Com Dra. Ana Silva
     📍 Rua X, 123
     Você receberá um lembrete na véspera.
     Qualquer dúvida é só chamar!
```

No dia anterior, às 18h, envio automático:

```
Bot: Olá Maria! Lembrete da sua consulta amanhã (22/04) às 10:30
     com Dra. Ana Silva.
     Responda:
     ✅ CONFIRMAR
     🔄 REMARCAR
     ❌ CANCELAR
```

## Integração com a Thúlio

A Thúlio fornece a camada de WhatsApp Business API. Nosso código tem uma **interface genérica** (`MessagingProvider`) e um **adapter específico** (`ThulioAdapter`) — isso significa que se um dia você trocar de provedor, só precisa trocar o adapter.

O que precisamos da documentação oficial da Thúlio (me envie):

1. **URL base da API** (ex: `https://api.thulio.io/v1`)
2. **Endpoint de envio de mensagem de texto** (method, path, body)
3. **Endpoint de envio de mensagem com botões interativos** (se suportado)
4. **Formato do payload que a Thúlio envia no webhook** quando o paciente responde
5. **Cabeçalho de autenticação** (Bearer token? x-api-key?)
6. **Como validar a assinatura do webhook** (HMAC? token secreto?)

> 👉 Enquanto você me envia a doc, deixei o adapter com a **estrutura correta** e comentários marcados com `// TODO (thulio):` nas partes que precisam ser ajustadas com os dados reais.

## Endpoints da API administrativa

A clínica usa esses endpoints (via painel web ou Postman) para gerenciar a operação:

| Método | Path | Descrição |
|---|---|---|
| GET | `/health` | Status do servidor |
| POST | `/webhooks/thulio` | Recebe mensagens do WhatsApp |
| GET | `/v1/clinics/:id` | Dados da clínica |
| POST | `/v1/clinics/:id/professionals` | Cadastrar profissional |
| POST | `/v1/clinics/:id/services` | Cadastrar serviço |
| POST | `/v1/professionals/:id/schedules` | Definir horários de trabalho |
| GET | `/v1/clinics/:id/appointments` | Listar agendamentos |
| GET | `/v1/clinics/:id/dashboard` | KPIs: ocupação, no-show rate, receita |
| POST | `/v1/appointments/:id/cancel` | Cancelar |

## Próximos passos

- [ ] Rodar localmente e enviar primeira mensagem de teste
- [ ] Integrar endpoints reais da Thúlio (preciso da doc)
- [ ] Deploy em staging (Railway/Render)
- [ ] Construir painel web em Next.js para as clínicas
- [ ] App mobile do profissional (agenda, anotações de consulta)
- [ ] Modelo de ML para previsão de no-show (precisa de 3-6 meses de dados)
- [ ] Integração com gateway PIX (Mercado Pago / Asaas / Stripe BR)
- [ ] Integração com Google Agenda / Outlook para os médicos

---

**Licença:** Proprietário — © 2026 Clinix
