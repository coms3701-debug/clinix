# Deploy do Clinix (free tier)

App: **Node 22 + Fastify + Prisma + PostgreSQL**. Redis **não** é necessário no
web (só o worker opcional usa). O `server.ts` já escuta em `0.0.0.0:$PORT`.

## Opção A — Render (recomendado, blueprint pronto)

1. Suba este repositório para o GitHub.
2. Em https://dashboard.render.com → **New → Blueprint** → selecione o repo.
   O `render.yaml` cria automaticamente:
   - **Postgres free** (`clinix-db`)
   - **Web service** `clinix` (build + migrate + start já configurados)
3. Após o primeiro deploy, abra o serviço → **Environment** e preencha as 3
   variáveis Twilio (estão como `sync: false`):
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_FROM_NUMBER`  (ex.: `whatsapp:+14155238886`)
   - `GEMINI_API_KEY` (opcional — ativa a IA da conversa)
   `DATABASE_URL` e `JWT_SECRET` são injetados/gerados pelo Render sozinho.
4. (1ª vez) Popular dados demo: aba **Shell** do serviço → `npm run seed`.
5. No Twilio Console → WhatsApp Sandbox/Número, aponte o webhook para:
   `https://SEU-APP.onrender.com/webhooks/twilio`

Health check: `GET /health` → `{"status":"ok"}`.
Painel: `/admin` · Demo: `/demo`.

> Free tier do Render hiberna após ~15 min sem tráfego (primeiro request
> seguinte demora ~30s). O Postgres free tem validade — confira o aviso no painel.

## Opção B — Fly.io (Docker)

Há um `Dockerfile` pronto.

```bash
fly launch --no-deploy            # gera fly.toml; defina internal_port = 3000
fly postgres create               # cria o Postgres e dá ATTACH (seta DATABASE_URL)
fly postgres attach <nome-do-pg>
fly secrets set TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... \
               TWILIO_FROM_NUMBER='whatsapp:+14155238886' \
               JWT_SECRET="$(openssl rand -hex 32)" NODE_ENV=production
fly deploy
```

O `CMD` do Dockerfile roda `prisma migrate deploy` antes de subir o servidor.

## Variáveis de ambiente (referência)

| Var | Obrigatória | Origem |
|-----|-------------|--------|
| `DATABASE_URL` | sim | Postgres do provedor |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | sim | Twilio Console |
| `JWT_SECRET` | recomendada | gerar (`openssl rand -hex 32`) |
| `NODE_ENV` | recomendada | `production` |
| `PORT` | não | injetada pelo provedor |
| `GEMINI_API_KEY` | não | ativa IA (senão usa fluxo por regras) |
| `REDIS_URL` | não | só p/ o worker BullMQ (não usado no web) |

## Notas importantes

- O build usa `npm ci --include=dev` de propósito: o Prisma CLI e o TypeScript
  são devDependencies e são necessários em build mesmo com `NODE_ENV=production`.
- `prisma migrate deploy` é idempotente — pode rodar a cada boot sem problema.
- O webhook do Twilio é `POST /webhooks/twilio` (form-encoded já tratado).
