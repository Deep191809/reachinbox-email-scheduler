# ReachInbox Email Scheduler

A full-stack email scheduling service built for the Outbox Labs Software Development Intern assignment.

## Stack

- Backend: TypeScript, Express.js, Prisma, PostgreSQL
- Queue: BullMQ + Redis
- SMTP: Ethereal Email
- Search: Elasticsearch
- Queue UI: Bull Board
- Frontend: React + TypeScript + Tailwind CSS + Vite
- Authentication: Google OAuth
- Notifications: Slack OAuth + Slack Web API
- Infrastructure: Docker Compose

## Architecture

```text
React + Tailwind
      |
      v
Express API -----> PostgreSQL (source of truth)
      |
      +-----------> Redis / BullMQ
      |                    |
      |                    v
      |                Worker(s)
      |                    |
      |          +---------+---------+
      |          |                   |
      |      Redis atomic       Ethereal SMTP
      |      sender limits            |
      |          |                    v
      |          |               Email status
      |          |                    |
      |          +--------------> Elasticsearch
      |
      +-----------> Google OAuth / Slack OAuth
```

PostgreSQL is the durable application source of truth. Redis stores BullMQ queue state and distributed sender throttling. Elasticsearch is a searchable projection, not the primary database.

## Local setup

### 1. Start infrastructure

```bash
docker compose up -d
```

Services:

- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`
- Elasticsearch: `localhost:9200`

### 2. Install dependencies

From the repository root:

```bash
npm install
```

### 3. Configure the backend

```bash
cp backend/.env.example backend/.env
```

Fill in:

- `SESSION_SECRET`
- Google OAuth credentials
- Slack OAuth credentials
- Ethereal SMTP credentials

For local Google OAuth, register:

```text
http://localhost:4000/api/auth/google/callback
```

For Slack OAuth, register:

```text
http://localhost:4000/api/slack/callback
```

The Slack app needs the scopes used by the implementation (`chat:write` and `im:write`).

### 4. Generate Prisma client and migrate

```bash
npm --workspace backend run prisma:generate
npm --workspace backend run prisma:migrate -- --name init
```

### 5. Start the API and worker

Terminal 1:

```bash
npm --workspace backend run dev
```

Terminal 2:

```bash
npm --workspace backend run dev:worker
```

### 6. Start the frontend

Terminal 3:

```bash
npm --workspace frontend run dev
```

Open the Vite URL shown in the terminal.

## Scheduling design

The API first creates durable campaign/email rows in PostgreSQL. Each email gets a deterministic BullMQ job ID:

```text
email:<email-id>
```

The scheduled time is converted into a BullMQ delayed-job delay. BullMQ stores delayed jobs in Redis, so the Node process does not need to stay alive for the entire waiting period.

A worker consumes the jobs and performs the sender-level throttling and SMTP send.

There are no cron jobs or polling schedulers in the implementation.

## Restart persistence and recovery

BullMQ's queue state is persisted in Redis. In addition, the worker runs a startup reconciliation pass over PostgreSQL `SCHEDULED` email records. Because queue job IDs are deterministic, reconciliation can safely recreate a missing queue entry without creating a second job when the original already exists.

This protects against the failure boundary where the database write succeeds but queue insertion fails.

## Concurrency

Worker concurrency is configurable:

```env
WORKER_CONCURRENCY=5
```

Multiple asynchronous email jobs can therefore be processed concurrently. Sender-specific throttling is coordinated through Redis rather than process-local variables, so separate worker processes share the same limit state.

## Minimum delay between sends

Each campaign provides a delay in milliseconds. The default is:

```env
DEFAULT_EMAIL_DELAY_MS=2000
```

The worker uses an atomic Redis sender timestamp to ensure concurrent workers cannot send the same sender's emails closer together than the configured gap.

## Hourly rate limiting

The default sender limit is configurable:

```env
MAX_EMAILS_PER_HOUR_PER_SENDER=50
```

The worker atomically checks the current UTC-hour counter and only increments it when a send slot is actually available. If the limit is reached, the job is moved back into BullMQ's delayed set for the next UTC hour instead of being dropped.

A Redis key is also used to ensure that the Slack rate-limit notification is emitted only once per sender/hour window.

## Idempotency and external SMTP limitations

Every email has a unique database ID and deterministic BullMQ job ID. Before sending, the worker atomically claims the email in PostgreSQL. Already-sent emails are skipped.

A deterministic SMTP `Message-ID` is also used:

```text
<reachinbox-<email-id>@reachinbox.local>
```

There is an unavoidable distributed-systems boundary between an external SMTP provider and PostgreSQL: no local database transaction can atomically commit both the external SMTP side effect and the database status update. The implementation therefore uses durable state, deterministic job/message IDs, bounded retries, and stale-processing recovery rather than claiming impossible universal exactly-once semantics over SMTP.

## Elasticsearch

Email records are indexed into the `emails` index after terminal send states (`SENT` / `FAILED`). PostgreSQL remains authoritative.

Search endpoint:

```text
GET /api/emails/search?q=<query>
```

The authenticated user's records are filtered at query time.

## BullMQ dashboard

The live queue dashboard is exposed at:

```text
http://localhost:4000/admin/queues
```

It is protected with HTTP Basic Authentication using:

```env
BULL_BOARD_USERNAME=admin
BULL_BOARD_PASSWORD=change-me-please
```

Change the password before sharing the deployment.

## Authentication

Google OAuth is implemented as a real OAuth flow. After successful authentication, the backend creates/updates the local user and sets an HTTP-only signed session cookie.

The dashboard uses the authenticated session rather than accepting a client-supplied user ID for campaign creation or email listing.

## Slack integration

The dashboard can start the Slack OAuth flow from **Connect Slack**. The backend stores the OAuth connection per user.

When a sender reaches its hourly limit, the worker makes a real Slack API call to open a DM with the connected Slack user and sends a notification. If Slack is not connected, the notification is skipped without failing the email job.

## Frontend

The React dashboard provides:

- Google login
- User name/email/avatar
- Logout
- Scheduled Emails tab
- Sent Emails tab
- Compose New Email
- CSV/text lead upload
- Valid email count
- Start time
- Delay between emails
- Hourly limit
- Loading/empty/error states
- Slack connection status

## API overview

```text
GET  /api/health
GET  /api/auth/google
GET  /api/auth/google/callback
GET  /api/auth/me
POST /api/auth/logout

GET  /api/senders
POST /api/campaigns
GET  /api/emails/scheduled
GET  /api/emails/sent
GET  /api/emails/search?q=...

GET  /api/slack/connect
GET  /api/slack/callback
GET  /api/slack/status
POST /api/slack/disconnect
```

## Assumptions / trade-offs

- PostgreSQL is the source of truth; Elasticsearch is a projection used for search.
- Sender throttling uses UTC hour windows so all worker instances share deterministic boundaries.
- Rate-limit slots are reservations for send attempts. A failed SMTP attempt can therefore consume a slot; this is safer for provider throttling than allowing concurrent workers to exceed the configured cap.
- BullMQ provides at-least-once job processing, so the email state machine and deterministic IDs are important safeguards.
- The external SMTP + database boundary prevents a strict mathematical exactly-once guarantee without provider-side idempotency support.
- The worker startup reconciliation is intentionally a recovery mechanism, not a cron scheduler.

## Verification checklist before submission

- [ ] Run `docker compose up -d` and confirm PostgreSQL, Redis and Elasticsearch are healthy.
- [ ] Run Prisma generation/migrations.
- [ ] Configure real Google, Slack and Ethereal credentials.
- [ ] Start API and worker separately.
- [ ] Login with Google.
- [ ] Confirm the dashboard shows the authenticated user's name, email and avatar.
- [ ] Connect and disconnect Slack.
- [ ] Schedule a CSV campaign with a future start time.
- [ ] Confirm delayed jobs appear in Bull Board at `/admin/queues`.
- [ ] Confirm the scheduled table updates.
- [ ] Stop/restart the worker before a future email is due and verify the job remains scheduled.
- [ ] Verify a sent email moves to the Sent table and is indexed in Elasticsearch.
- [ ] Verify search by recipient or subject.
- [ ] Configure a small hourly limit and verify pending jobs are delayed rather than failed permanently.
- [ ] Verify Slack receives the rate-limit notification when connected.
- [ ] Repeat the rate-limit test with Slack disconnected and confirm the worker continues without crashing.
- [ ] Run the final build locally before pushing the private repository.

The project intentionally does not claim absolute exactly-once delivery across an external SMTP provider and a relational database; the README documents that crash boundary and the idempotency/recovery measures used around it.
