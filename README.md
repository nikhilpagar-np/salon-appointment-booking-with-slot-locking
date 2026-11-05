# Salon Appointment Booking with Secure Slot Holds

A full-stack salon appointment booking application that preserves the original BookMyBarber UI while adding authenticated server sessions, role-based authorization, staff-specific availability, duration-aware overlap protection, expiring holds, verified payment webhooks, versioned migrations, CI, and Docker support.

## Audit status and scope

The enterprise upgrade is implemented in the current repository. The public `main` branch contains the modular backend described below. The application currently uses SQLite with WAL mode for a self-contained single-instance deployment. PostgreSQL is documented as the preferred next persistence adapter for horizontal scaling; the repository does not claim PostgreSQL support until that adapter is implemented and tested.

## Features

- Customer and owner registration with scrypt password hashing.
- HTTP-only, SameSite session cookies backed by the database.
- Server-side identity; the API no longer trusts `X-User-Id`.
- Role-based access control for customers, owners, staff, and admins.
- Staff-specific services and working schedules.
- Service duration determines appointment end time.
- Transactional holds that expire automatically.
- Atomic hold confirmation and database-backed ownership checks.
- Overlap prevention for a staff member’s active hold or confirmed appointment.
- Server-derived service prices and durations.
- Payment intents plus HMAC-signed provider webhook verification.
- Client-supplied `paymentStatus` is ignored.
- Customer booking isolation and owner/admin salon boundaries.
- Versioned SQL migration runner.
- Structured request IDs and centralized JSON errors.
- GitHub Actions CI and Docker image.
- Existing salon customer, owner, admin, walk-in, and payment UI retained where compatible.

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the Mermaid architecture diagram and the SQLite/PostgreSQL decision. The backend is split into `config`, `database`, `middleware`, `controllers`, `routes`, and `services`.

```text
Browser UI
  -> Express routes
  -> authentication/RBAC middleware
  -> controllers
  -> booking/auth/payment services
  -> SQLite migrations and transactions
```

## Technology stack

- Node.js 18+
- Express 4
- SQLite via `better-sqlite3` with WAL mode
- Native Node.js crypto (`scrypt`, HMAC, random session tokens)
- Node test runner
- Docker and GitHub Actions

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Open <http://localhost:3000>.

Important environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Enables/disables development-only behavior |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/bookings.db` | SQLite database path |
| `SESSION_TTL_MS` | 604800000 | Session lifetime |
| `LOCK_DURATION_MS` | 300000 | Hold lifetime |
| `ADMIN_EMAIL` | `admin@example.com` | Seeded admin email outside tests |
| `ADMIN_PASSWORD` | change-this-in-production | Seeded admin password; replace it |
| `PAYMENT_WEBHOOK_SECRET` | development fallback | Provider webhook HMAC secret |

Never use the default admin password or development webhook secret in production.

## API

All protected endpoints use the HTTP-only `session` cookie set by login. No identity header is accepted as an authority.

### Authentication

- `POST /api/auth/register` — register a `CUSTOMER` or `OWNER`.
- `POST /api/auth/login` — create a server-side session.
- `POST /api/auth/logout` — revoke the current session.
- `GET /api/auth/me` — return the authenticated user.

Passwords must be at least 10 characters and are stored as scrypt hashes.

### Availability and booking

- `GET /api/slots/status?salonId=&staffId=&serviceId=&startsAt=` — return authoritative availability, duration, and price.
- `POST /api/holds` — create a temporary hold for an authenticated customer.
- `DELETE /api/holds/:holdId` — release a hold owned by the current customer.
- `POST /api/appointments` — confirm a hold. For online payment, a verified payment reference is required. For pay-at-salon, the server stores `PENDING` payment status.
- `GET /api/appointments/me` — list only the current customer’s appointments.
- `GET /api/appointments/salon` — owner/admin salon view.

Legacy `/api/locks` and `/api/bookings` paths remain as authenticated compatibility aliases for the preserved UI. They ignore client identity and client `paymentStatus` fields.

### Payments

- `POST /api/payments/intents` — create a server-priced pending payment intent.
- `POST /api/payments/webhook` — accept only a correctly HMAC-signed provider event with matching amount and reference.

A payment provider is not fabricated. Configure a real provider adapter and secret before production use.

## Database design

The migration creates:

- `users`, `sessions`
- `salons`, `staff`, `services`, `staff_services`, `staff_schedules`
- `slot_holds`
- `appointments`
- `payments`
- `audit_logs`

The booking service rejects staff overlaps using `[existing_start, existing_end) ∩ [new_start, new_end)`. All hold and confirmation writes run in SQLite transactions.

## Testing

```bash
npm test
```

The integration suite starts a fresh isolated database and verifies:

1. unauthenticated access is rejected;
2. authenticated sessions identify the server-side user;
3. simultaneous holds are limited per staff member;
4. hold ownership is enforced;
5. service-duration overlaps are rejected;
6. expired holds become available;
7. customers cannot see another customer’s appointments;
8. unverified online payments cannot confirm appointments;
9. signed webhook verification is required;
10. customer and owner permissions differ correctly.

## CI and Docker

GitHub Actions runs syntax checks and the complete test suite on Node 18 and Node 20. Build and run the application with:

```bash
docker build -t salon-booking .
docker run --rm -p 3000:3000 -v "$PWD/data:/app/data" salon-booking
```

SQLite is appropriate for a single application instance. Use a managed PostgreSQL deployment before enabling multiple application instances; see [`docs/architecture.md`](docs/architecture.md).

## Screenshots

The original salon interface and screenshots remain in `index.html` and the source history. The UI was not replaced with a separate demo.
