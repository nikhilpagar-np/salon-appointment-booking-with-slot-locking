# Salon Appointment Booking with Transactional Slot Locking

This project merges the BookMyBarber salon appointment interface with a persistent, concurrency-safe slot booking backend. The original dark/gold customer, owner, admin, walk-in, payment, and reporting UI is preserved in `index.html`; booking locks and confirmations are now enforced by the SQLite API in `server.js`.

## What changed

- Temporary five-minute slot locks are stored in SQLite instead of browser-only `localStorage`.
- Every lock request runs inside a SQLite write transaction and removes expired locks before counting capacity.
- Slot locks are owned by the authenticated customer ID supplied in `X-User-Id`; another customer cannot release or confirm them.
- Confirmations require a live lock and are committed atomically with lock removal.
- A database trigger prevents more than `SLOT_CAPACITY` confirmed bookings for one salon/date/time.
- Abandoned locks expire automatically on the next API request; the browser timer also releases them immediately when possible.
- Failed payments release the active lock without creating a booking.
- The frontend falls back to its existing local demo state only when the API is unavailable, while production booking actions use the API.

## Setup

Requirements: Node.js 18 or newer.

```bash
npm install
cp .env.example .env
npm start
```

Open <http://localhost:3000>. The default database is `data/bookings.db`, which is ignored by Git. Use a separate `DB_PATH` for tests or each environment.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/bookings.db` | SQLite database path |
| `LOCK_DURATION_MS` | `300000` | Temporary lock lifetime |
| `SLOT_CAPACITY` | `2` | Maximum confirmed/reserved customers per slot |

## Booking API

All booking requests should include `X-User-Id` from the application authentication layer.

- `GET /api/health` — readiness check.
- `GET /api/slots/status?salonId=&date=&time=` — confirmed count, active lock count, capacity, and availability.
- `POST /api/locks` with `{ salonId, date, time, userName }` — acquire a temporary lock; returns `409` when capacity is unavailable.
- `DELETE /api/locks/:lockId` — release a lock owned by the requesting customer.
- `POST /api/bookings` with `{ salonId, date, time, bookingId, lockId, paymentStatus, payload }` — confirm atomically; use `paymentStatus: "failed"` to release without booking.
- `GET /api/bookings` — list bookings for the requesting customer.

## Verification

Run the concurrency and lifecycle tests:

```bash
npm test
```

The suite starts an isolated server/database and verifies that simultaneous attempts cannot exceed capacity, lock ownership is enforced, duplicate confirmations fail, expired locks become available again, failed payments release locks, and independent slots can be booked concurrently.

## Production notes

Use HTTPS, a real authentication/session layer, and a managed persistent database for multi-instance deployments. SQLite with WAL mode is appropriate for a single application instance; for horizontal scaling, port the same transaction boundaries and capacity trigger to PostgreSQL (using row/advisory locks and a transaction). Never commit `.env` or the generated database file.
