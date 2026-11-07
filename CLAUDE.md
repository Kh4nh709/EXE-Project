# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

FPT Event Attendance Management — QR + GPS attendance for university events and class sessions.
Two independent npm projects: `backend/` (Express + Prisma + Supabase Postgres, deployed on Render)
and `frontend/` (React 18 + Vite + Tailwind, deployed on Vercel). There is no root package.json.

## Commands

Backend (`cd backend`):
- `npm run dev` — nodemon on port 5000
- `npm test` — all tests (`node --test --require ./testenv.js`)
- `node --test --require ./testenv.js test/whitelist.test.js` — a single test file
- `npm run db:generate` — regenerate Prisma client (required after any `schema.prisma` edit)
- `npm run db:push` / `npm run db:migrate` / `npm run db:studio` / `npm run db:seed`

Frontend (`cd frontend`):
- `npm run dev` — Vite on 5173, proxies `/api` → `http://localhost:5000`
- `npm run build`, `npm run preview`
- `npm test` — only `node --test src/utils/date.test.js` (frontend has no component tests)

Env: copy `backend/.env.example` and `frontend/.env.example`. Backend needs `DATABASE_URL`
(pooler :6543), `DIRECT_URL` (:5432), `JWT_SECRET`, `QR_SECRET`, and Brevo keys for email.

## Architecture

### Request path (backend)
`src/index.js` (listener only) → `src/app.js` (middleware + route mounting) → `routes/*.routes.js`
→ `controllers/*.controller.js` → `lib/prisma.js` singleton. The app/listener split exists so
supertest can mount `app` without binding a port — keep it.

Routers apply auth at the top (`router.use(authenticate, authorize(...))`) rather than per-route
where the whole router shares a role. `/api/public/*` is the only unauthenticated router.

### Shared decision helpers in `lib/` — use them, don't reimplement
- `lib/attendanceGate.js` — **the** source of truth for whether check-in/check-out is open.
  A gate is `AUTO` (uses the time window, and is CLOSED when the window is unset), `OPEN`, or
  `CLOSED` (manual overrides ignore the window). `checkin.controller` enforces it and
  `event.controller` ships `gateSummary(event)` to the frontend as `event.gate` — the frontend
  cannot derive this itself, so any new event-returning endpoint should attach it too.
- `lib/eventMembership.js` — every path into an event's participant list (self-registration,
  organizer add, add-whole-class) must go through `addUsersToEvent`, which writes both an
  `EventMember` row and a `REGISTERED` `Attendance` row in one transaction. Writing only one
  desyncs the check-in whitelist from the attendance sheet/export.
- `lib/eventAccess.js` — `loadEventForWrite(req, res)` for the ADMIN-or-creator rule; returns
  `null` after already sending the error response.
- `lib/parseOptionalDate.js` — the four attendance timestamps are optional; `''`/null means
  "unscheduled" (valid), an unparseable string is an error.
- `lib/bulkUsers.js` — `parseUserIds` for every admin bulk action (`/api/admin/users/bulk/*`).
  It enforces the per-request cap and **always drops the acting admin's own id** so nobody can
  self-delete/self-lock/self-demote out of the system. Bulk handlers answer 200 with
  `{ updated, skipped: [{ id, name, reason }] }` — partial success is normal, not a 4xx.
  Register bulk routes *before* `/users/:id/...` or `/users/bulk/reset-password` matches `:id`.
- `lib/scanTicket.js` — `issueTicket`/`validateTicket`. A QR token's clock starts when the
  *screen* minted it, but a student still has to log in (reading an emailed OTP takes minutes) and
  grant GPS before checking in. `ScanLanding` therefore trades the token for a 15-min HMAC ticket
  the instant the camera reads it (`POST /api/public/scan-ticket`, unauthenticated by design), so
  login latency no longer eats the QR window. Keep the QR window short: the ticket, not a longer
  token life, is what covers slow logins. Tickets are bound to eventId + type + deviceId and are
  stateless — nothing stored.
- `lib/contentDisposition.js` — event names are Vietnamese; raw non-ASCII in a `Content-Disposition`
  header throws in Node. All report downloads must build the header here.
- `lib/feedbackForm.js` — post-event feedback questions/answers are JSON (`TEXT` | `RATING` 1–5),
  so every write (template, event form, response) must go through `normalizeQuestions` /
  `validateAnswers`. An event's form holds a *snapshot* of the template's questions; questions lock
  once a response exists, and an anonymous form can't be made non-anonymous after that. Only
  `CHECKED_OUT` attendees may answer; a QR checkout response carries `feedback` (via
  `feedbackPromptFor`) so `ScanLanding` shows the form right away. Spec: `docs/superpowers/specs/2026-09-24-event-feedback-design.md`.
- `lib/eventReminder.js` — BTC's manual "Gửi nhắc ngay" email to registered members who have not
  checked in. There is deliberately **no automatic/scheduled reminder** (Render free tier sleeps, and
  the product owner chose manual). The endpoint answers `202` and sends in the background — a long
  list would exceed the frontend timeout and `api.js` would retry, double-sending. `EventReminder`
  rows are the send log and the basis of the 30-min cooldown.
  Spec: `docs/superpowers/specs/2026-09-24-event-reminder-design.md`.
- `lib/certificateLayout.js` — certificate layout rules shared by the PDF renderer
  (`services/certificatePdf.js`, pdf-lib) and the browser canvas
  (`frontend/src/pages/certificates/certRender.js`), which also use the **same font files**
  (`backend/assets/fonts` = `frontend/public/fonts/cert`). Change one side and you must change the
  other, or the web preview drifts from the downloaded PDF. Template images live in the DB (`BYTEA`)
  because Render's disk is ephemeral. Certificates are optional per event (no template = none) and
  only `CHECKED_OUT` attendees get one. Spec: `docs/superpowers/specs/2026-09-24-event-certificate-design.md`.
- Projector welcome wall (`pages/btc/QRDisplay.jsx` + `pages/btc/live/`): polls
  `GET /api/events/:id/live` every 3 s, which returns only **names** (the screen is public — never
  add MSSV/email/class there) and always the latest 60 rather than a cursor; the client diffs ids,
  and the first load only marks everyone as seen so reopening mid-event doesn't greet 100 people.
  Music is generated with Web Audio in `partyAudio.js` (no bundled files/licensing) or a local file
  via object URL (never uploaded); browsers block audio until a click, hence the "Bật nhạc" button.
- Invitation events (`Event.kind = 'INVITATION'`, fixed at creation): external guests with **no account**
  live in `EventGuest` (not `User`/`EventMember`/`Attendance`), each with a random `code` that the
  printed/emailed invitation's QR carries as `FRONTEND_URL/thiep/<code>`; BTC (or a volunteer via the
  revocable `Event.scannerToken` link `/quet/:token`) scans it. Check-in only, no gate/GPS.
  `lib/guestCheckin.js` holds the rules both scanners share (volunteers get `maskedGuestView`);
  `controllers/event.controller` locks the self-scan fields (`INVITATION_LOCKED`) and rejects the
  self-scan APIs with `INVITATION_EVENT`. Invitation PDF layout is `lib/invitationLayout.js` ↔
  `frontend/src/pages/certificates/invitationRender.js` (same rule as the certificate pair; both use
  the `qrcode` package). Reports branch on `kind`. Per-guest export: `GET /invitations/zip` (one PDF per
  guest, streamed ZIP via `fflate`) and PNG, which the **browser** draws with `drawInvitation`
  (`pages/btc/invitation/invitationExport.js` + `GET /invitations/cards`) because the server has no
  canvas — so PNG needs an uploaded template. File names come from `invitationFileNames` on both paths. Spec: `docs/superpowers/specs/2026-10-16-invitation-event-design.md`.
  One invitation can carry several tickets (`EventGuest.ticketCount`; one scan admits the whole group) and
  seats from `Event.seatMap`. Seat codes (`E08`) are parsed/validated only in `lib/seatMap.js`; assignments
  live in `EventGuestSeat` with `@@unique([eventId, seat])`, so a double-booking is a P2002 → `SEAT_TAKEN`
  — write seats in the same `$transaction` as the guest. Load guests with `GUEST_INCLUDE` so `guestView`
  has seats. Spec: `docs/superpowers/specs/2026-10-18-invitation-seating-design.md`.
- Public check-in events (`Event.kind = 'PUBLIC'`): a **fixed** QR on the projector (`QRDisplay` with
  `kind PUBLIC`) points to `/check-in/:eventId`, where visitors with no account fill a BTC-built form
  (`Event.publicForm`; name is always present and not in `fields`). Every form write and submission goes
  through `lib/publicForm.js`. Check-ins are `EventGuest` rows with `answers` JSON. Dedupe uses
  `EventGuestKey (eventId, key)` unique, created in the same transaction as the guest, so concurrent
  duplicates hit P2002. Fields lock once anyone has checked in. The time limit reuses the check-in gate
  (off = `checkinState OPEN`); GPS goes through `lib/geo.js#gpsRejection`. `lib/geo.js` and
  `attendanceGate.gateRejection` are shared with the self-scan flow — keep error codes identical.
  Spec: `docs/superpowers/specs/2026-10-16-public-checkin-design.md`.
- Face check-in kiosk (`pages/btc/FaceCheckin.jsx`, `/events/:id/face-checkin`): 1:N face recognition
  for STANDARD events. **The model runs only in the browser** (`@vladmandic/human`, wrapped by
  `pages/face/faceEngine.js`; models served at `/models/human/` by a plugin in `vite.config.js`, not
  committed). Inference runs in a Web Worker (`pages/face/faceWorker.js`, config shared via
  `faceConfig.js`) because on the main thread it froze the page and got the feature reverted once;
  `faceEngine` falls back to the main thread only when the browser can't run it in a worker.
  The server never runs ML: `lib/faceProfile.js` only stores and compares vectors, and its
  `similarity` + thresholds must stay identical to `pages/face/faceMatch.js`. Changing the model or
  config means bumping `FACE_MODEL`. The kiosk uses only profiles with `consentAt`: a student's own
  capture requires ticking consent, while every admin-set photo — batch import (`POST /api/admin/face-profiles/import`, `overwrite`
  to replace self-taken ones) or per-user from UserManagement (`/api/admin/users/:id/face-profile`) — goes
  through `adminProfileData` and is **active immediately** (product-owner decision 2026-11-05: the school
  owns the legal basis for photos it supplies; students can still delete theirs at `/khuon-mat`).
  Students manage their profile at `/khuon-mat` (`/api/me/face-profile`). Saving rejects lookalikes of
  other accounts (`FACE_DUPLICATE`) to stop proxy attendance.
  Spec: `docs/superpowers/specs/2026-10-22-face-checkin-design.md`.
- `lib/datetime.js` — **every** user-facing timestamp on the backend (reports, Excel, emails,
  check-in messages) must be formatted here. `toLocaleString('vi-VN')` without an explicit
  `timeZone` follows the *server's* TZ, and Render runs Node in UTC, so times printed 7 hours off
  in production while looking right on a dev machine in Vietnam. Frontend is exempt: date-fns
  formats in the browser's zone, which is already correct.

### Check-in flow
QR code encodes `/scan?e=<eventId>&t=<token>&type=checkin|checkout`. Tokens are HMAC-SHA256 of
`eventId:type:timeSlot` over `QR_SECRET`, rotating every 30s with a 3-slot grace window so a
minted code stays valid **at least 90s** (up to 120s) after the screen has rotated to a new one
(`services/qr.service.js`) — stateless, nothing stored. `QRDisplay.jsx` refetches every 30s.
`processCheckin` accepts either a raw `token` or a `ticket` (see `lib/scanTicket.js`) as proof of
scanning; the frontend always sends the ticket when it has one.
`checkin.controller.processCheckin` validates in fixed order: token → event → whitelist membership
→ gate → GPS (haversine vs `event.radius`) → device binding → one-device-one-person → attendance upsert.
Steps from whitelist on live in `lib/selfCheckin.js#performSelfCheckin`, shared with the **no-login
path**: when `Event.otpCheckinEnabled` (default on), `ScanLanding` asks for email/MSSV instead of
redirecting to `/login` → `POST /api/public/checkin-otp/request` (checks everything *before* spending
an email; 60 s cooldown) → `/verify` (OTP bound to deviceId, burned after 5 wrong tries via
`OtpToken.attempts`) returns a **check-in pass** (`lib/checkinPass.js`, stateless HMAC of
user+event+device, 24 h, no JWT) → `POST /api/public/self-checkin`. The pass also covers checkout and
the feedback form (`/api/public/feedback/:id/response`, header `X-Checkin-Pass`) so one person costs
one email per event. Pass errors are `400 PASS_INVALID`, never 401 (`api.js` logs out on 401).
A device that already checked in someone else at an event gets `DEVICE_USED_BY_OTHER` on both paths.
Spec: `docs/superpowers/specs/2026-11-07-otp-checkin-design.md`. Rejections that
indicate abuse are written to `FraudLog` via a best-effort `logFraud` that never throws.
BTC can undo one person's check-in (`DELETE /api/events/:id/attendance/:userId/checkin`, from the
attendance tab and the face kiosk): the row goes back to `REGISTERED` (never deleted — see
`eventMembership`), check-out is cleared with it, and it is refused (`CERTIFICATE_ISSUED`) until any
certificate for that person is revoked.

### Attendance reports
`GET /api/reports/events/:id/export` (xlsx) and `/export-html` both go through
`loadEventForWrite`. The HTML report (`services/htmlReport.service.js`) is self-contained — no CDN,
no `<script>` — because it doubles as a downloaded file. `?view=1` returns the same HTML with an
`inline` disposition for `ReportViewerModal.jsx`, which embeds it in a sandboxed `iframe srcDoc`
so the report's own CSS cannot leak into the app's Tailwind. One HTML source for every mode:
in-app view, downloaded file and shared link never drift apart.

BTC can share a report with people who have no account: `POST /api/reports/events/:id/share`
mints `Event.reportShareToken` (random 24 bytes, so the event id does not reveal the link) and
returns `FRONTEND_URL/bao-cao/:token`; `?rotate=1` re-mints, `DELETE` revokes by setting the
column back to NULL — that revocability is why this is a DB column and not a stateless HMAC like
`lib/scanTicket.js`. The viewer page (`pages/public/SharedReport.jsx`) reads
`GET /api/public/reports/:token`, which is unauthenticated, answers `no-store`, and 404s with
`SHARE_NOT_FOUND` for both wrong and revoked tokens.

### Auth
JWT (1 day default) + a `localStorage` device UUID sent as `X-Device-ID`. Logging in from a device
other than the trusted binding triggers an emailed OTP (`purpose: 'DEVICE_BIND'`) before a token is
issued. 5 failed passwords lock an account 15 minutes (`failedLoginAttempts`/`lockedUntil`).
Students may log in without a password at all via `/api/auth/login-otp/request` +
`/login-otp/verify` (emailed 6-digit code, bound to the requesting device, 10 min). That path is
**STUDENT-only** on purpose — for ADMIN/BTC/LECTURER an inbox takeover would otherwise be a full
account takeover. `/api/auth/forgot-password` + `/reset-password` use the same `OtpToken` table
with `purpose: 'PASSWORD_RESET'`. Both flows answer identically whether or not the account exists,
so they cannot be used to enumerate emails/MSSV.
`middleware/auth.js` deliberately splits failure modes: bad/expired JWT → 401, DB unreachable → 503
so a database blip does not log everyone out. The frontend mirrors this: `services/api.js` retries
503/timeout twice (free-tier cold starts) but logs out on 401.

### Data model notes (`prisma/schema.prisma`)
All tables are prefixed `attendance_` via `@@map` — the Supabase project is shared. `Class.name` is
the source of truth for a class name and renaming a class rewrites the free-text `User.class` string
on every member. A `Class` session is an `Event` with `classId` set, created via
`POST /api/classes/:id/sessions`. `prisma/supabase-setup.sql` is the hand-maintained SQL applied in
the Supabase SQL editor; when you change the schema, update it alongside `schema.prisma`.

`lib/prisma.js` force-appends `pgbouncer=true&connection_limit=1` to `DATABASE_URL` — Supabase
transaction-mode pooling breaks Prisma's prepared statements without it. Don't bypass the singleton.

### Frontend
`App.jsx` holds all routing and the `RequireAuth roles={[...]}` guard; `contexts/AuthContext.jsx`
owns session state and decodes the JWT client-side (`utils/token.js`) only to expire stale sessions —
never for authorization. All HTTP goes through the typed groups in `services/api.js`
(`authApi`, `eventApi`, `classApi`, …); pages don't call axios directly. Pages are grouped by
audience: `pages/btc/`, `pages/classes/`, `pages/admin/`, `pages/student/`, `pages/public/`,
`pages/scan/`.

## Conventions

- User-facing API messages are **Vietnamese**; error responses are
  `{ success: false, error: 'STABLE_CODE', message: '…' }` and the frontend maps `error` codes to
  titles (e.g. `NOT_REGISTERED` in `ScanLanding.jsx`) — keep codes stable when changing copy.
- Explanatory comments are written in Vietnamese and explain *why* (a pooler quirk, a header bug, a
  business rule). Match that when adding non-obvious code.
- Tests use `node:test` + supertest with **no test database**: stub the Prisma singleton with
  `stubMethod(prisma.event, 'findUnique', …)` from `testenv.js` and `restoreStubs()` in `afterEach`.
  `mock.method` does not work on Prisma delegates (Proxy-based) — that's why `stubMethod` exists.
  QR tokens in tests are real ones from `qrService.generateToken()`.
- Design docs and implementation plans live in `docs/superpowers/specs/` and
  `docs/superpowers/plans/`; check for an existing spec before reworking a feature.
- Commit subjects: lowercase `feat:`/`fix:`/`docs:`/`refactor:`/`test:` prefix.
