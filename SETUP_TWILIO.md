# 🚀 Guia de Configuração Twilio — Clinix

## Passo 1 — Criar o arquivo .env

Copie o arquivo de exemplo e preencha com suas credenciais:

```bash
cp .env.example .env
```

Abra o `.env` e preencha:

```env
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_FROM_NUMBER=whatsapp:+5511999999999
```

Onde encontrar essas informações no Twilio Console:
- **Account SID** e **Auth Token**: https://console.twilio.com → *Account Info* (canto inferior esquerdo)
- **From Number**: O número WhatsApp aprovado, no formato `whatsapp:+5511XXXXXXX`
  - Se estiver usando o **Sandbox**: use `whatsapp:+14155238886`

---

## Passo 2 — Instalar dependências

```bash
npm install
```

---

## Passo 3 — Subir banco e Redis

```bash
docker compose up -d
```

Aguarde ~10 segundos para os containers iniciarem.

---

## Passo 4 — Criar tabelas e dados demo

```bash
npx prisma migrate dev --name init
npm run seed
```

O seed cria:
- Clínica "Clínica Dermato Demo"
- 2 profissionais (Dra. Ana Silva, Dr. Bruno Costa)
- 3 serviços
- Horários de trabalho (Seg–Sex)

**Importante:** Após o seed, atualize o `whatsappNumber` da clínica para seu número Twilio real:
```bash
npx prisma studio
```
Abra `Clinic` → edite o campo `whatsappNumber` para o seu número (ex: `+5511999999999`).

---

## Passo 5 — Iniciar o servidor

```bash
npm run dev
```

Você verá:
```
🚀 Clinix rodando em http://localhost:3000
📋 Painel admin: http://localhost:3000/admin
💬 Demo WhatsApp: http://localhost:3000/demo
📡 Webhook Twilio: POST http://localhost:3000/webhooks/twilio
```

---

## Passo 6 — Expor o webhook publicamente (desenvolvimento)

Em outro terminal:

```bash
npx ngrok http 3000
```

Copie a URL `https://xxxx.ngrok-free.app` gerada.

---

## Passo 7 — Configurar o Webhook no Twilio Console

### Se estiver usando o Sandbox:
1. Acesse: https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn
2. Em **"When a message comes in"**, cole:
   ```
   https://xxxx.ngrok-free.app/webhooks/twilio
   ```
3. Método: **POST**
4. Clique em **Save**

### Se tiver número WhatsApp Business aprovado:
1. Acesse: https://console.twilio.com → Messaging → Senders → WhatsApp Senders
2. Clique no seu número
3. Em **Messaging Configuration → A message comes in**, cole a URL do webhook
4. Clique em **Save**

---

## Passo 8 — Testar

Mande **"Oi"** no WhatsApp para o número configurado.

A Clara (assistente) deve responder com o menu de opções. 🎉

---

## Passo 9 — Worker de lembretes (opcional em dev)

Em outro terminal:

```bash
npm run worker
```

O worker processa jobs de lembrete de véspera. O servidor já agenda os jobs automaticamente às 18h todo dia.

---

## Dicas para produção

- Use Railway, Render, ou Fly.io para hospedar o servidor
- Configure `NODE_ENV=production` no ambiente de produção
- Substitua ngrok pela URL definitiva do servidor no campo webhook do Twilio
- Ative a validação de assinatura Twilio (já implementada — só funciona em `NODE_ENV=production`)
- Configure Redis e PostgreSQL gerenciados (Upstash, Supabase, Railway)

---

## Estrutura de arquivos criados

```
src/
├── config.ts                           # Variáveis de ambiente
├── database.ts                         # Prisma client
├── redis.ts                            # IORedis
├── server.ts                           # Servidor Fastify
├── providers/
│   ├── messaging.interface.ts          # Interface genérica
│   └── twilio.adapter.ts               # Adapter Twilio ← integração real aqui
├── modules/
│   ├── webhook/twilio.controller.ts    # POST /webhooks/twilio
│   ├── conversation/
│   │   ├── states.ts                   # Enum de estados
│   │   └── conversation.engine.ts      # Chatbot (máquina de estados)
│   ├── appointment/
│   │   ├── availability.service.ts     # Cálculo de slots livres
│   │   └── appointment.service.ts      # Criar/cancelar agendamentos
│   └── admin/admin.routes.ts           # API administrativa
└── workers/reminder.worker.ts          # Lembretes de véspera (BullMQ)

public/
├── index.html                          # Landing page
├── admin/index.html                    # Painel admin (responsivo)
└── demo/index.html                     # Simulador WhatsApp
```
