const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const prisma = require('../src/lib/prisma');
const qrService = require('../src/services/qr.service');
const app = require('../src/app');
const { stubMethod, restoreStubs } = require('../testenv');

const authToken = jwt.sign({ userId: 'student-1' }, process.env.JWT_SECRET);
const AUTH_USER = {
  id: 'student-1', mssv: 'SE1', email: 'a@b.c', name: 'An',
  role: 'STUDENT', isActive: true, isFirstLogin: false,
};

const realNow = Date.now;
afterEach(() => { Date.now = realNow; restoreStubs(); });

function mockCheckinHappyPath() {
  stubMethod(prisma.user, 'findUnique', async () => AUTH_USER);
  stubMethod(prisma.event, 'findUnique', async () => ({
    id: 'evt-1', name: 'Event', isWhitelisted: false, isActive: true, gpsEnabled: false,
    checkinOpen: new Date(Date.now() - 3600e3), checkinClose: new Date(Date.now() + 3600e3),
    checkoutOpen: new Date(Date.now() - 3600e3), checkoutClose: new Date(Date.now() + 3600e3),
    checkinState: 'AUTO', checkoutState: 'AUTO',
  }));
  stubMethod(prisma.deviceBinding, 'findFirst', async () => ({
    id: 'b1', userId: 'student-1', deviceId: 'dev-1', isTrusted: true,
  }));
  stubMethod(prisma.attendance, 'findUnique', async () => null);
  // Luật một máy một người: chưa ai khác check-in bằng máy này.
  stubMethod(prisma.attendance, 'findFirst', async () => null);
  stubMethod(prisma.attendance, 'upsert', async () => ({ id: 'a1' }));
}

function requestTicket(body) {
  return request(app).post('/api/public/scan-ticket').send({
    eventId: 'evt-1', type: 'checkin', deviceId: 'dev-1', ...body,
  });
}

async function freshTicket() {
  const res = await requestTicket({ token: qrService.generateToken('evt-1', 'checkin') });
  assert.strictEqual(res.status, 200);
  return res.body.ticket;
}

// ── Phát vé ─────────────────────────────────────────────────────────────────

test('a fresh QR token can be exchanged for a ticket without logging in', async () => {
  const res = await requestTicket({ token: qrService.generateToken('evt-1', 'checkin') });

  assert.strictEqual(res.status, 200);
  assert.ok(res.body.ticket);
  // Vé phải sống lâu hơn hẳn mã QR để chịu được thời gian đăng nhập bằng OTP.
  assert.ok(res.body.expiresAt > Date.now() + 10 * 60_000);
});

test('an expired QR token buys no ticket', async () => {
  const token = qrService.generateToken('evt-1', 'checkin');
  const mintedAt = realNow();
  Date.now = () => mintedAt + 10 * 60_000;

  const res = await requestTicket({ token });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'QR_EXPIRED');
  assert.ok(!res.body.ticket);
});

test('a token for another event or the other gate buys no ticket', async () => {
  const checkoutToken = qrService.generateToken('evt-1', 'checkout');
  const otherEventToken = qrService.generateToken('evt-2', 'checkin');

  assert.strictEqual((await requestTicket({ token: checkoutToken })).status, 400);
  assert.strictEqual((await requestTicket({ token: otherEventToken })).status, 400);
});

// ── Dùng vé để điểm danh ────────────────────────────────────────────────────

test('a ticket still checks in long after the QR token behind it expired', async () => {
  // Đây là ca chính: quét mã → mất 5 phút đăng nhập bằng OTP → vẫn điểm danh
  // được, không phải quay ra quét lại mã QR.
  const token = qrService.generateToken('evt-1', 'checkin');
  const ticket = await freshTicket();
  const scannedAt = realNow();

  Date.now = () => scannedAt + 5 * 60_000;
  assert.strictEqual(qrService.validateToken(token, 'evt-1', 'checkin'), false,
    'mã QR gốc phải đã hết hạn ở thời điểm này');

  mockCheckinHappyPath();
  const res = await request(app).post('/api/checkin')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ eventId: 'evt-1', ticket, type: 'checkin', deviceId: 'dev-1' });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
});

test('a ticket handed to another device is refused', async () => {
  const ticket = await freshTicket();

  mockCheckinHappyPath();
  const fraudStub = stubMethod(prisma.fraudLog, 'create', async () => ({}));

  const res = await request(app).post('/api/checkin')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ eventId: 'evt-1', ticket, type: 'checkin', deviceId: 'dev-2' });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'QR_EXPIRED');
  assert.strictEqual(fraudStub.calls[0][0].data.reason, 'INVALID_SCAN_TICKET');
});

test('a check-in ticket cannot be redeemed at the check-out gate', async () => {
  const ticket = await freshTicket();

  mockCheckinHappyPath();
  stubMethod(prisma.fraudLog, 'create', async () => ({}));

  const res = await request(app).post('/api/checkin')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ eventId: 'evt-1', ticket, type: 'checkout', deviceId: 'dev-1' });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'QR_EXPIRED');
});

test('a ticket with a stretched expiry is refused', async () => {
  const ticket = await freshTicket();
  const [, signature] = ticket.split('.');
  const forged = `${Date.now() + 24 * 3600e3}.${signature}`;

  mockCheckinHappyPath();
  stubMethod(prisma.fraudLog, 'create', async () => ({}));

  const res = await request(app).post('/api/checkin')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ eventId: 'evt-1', ticket: forged, type: 'checkin', deviceId: 'dev-1' });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'QR_EXPIRED');
});

test('a ticket older than its 15-minute life is refused', async () => {
  const ticket = await freshTicket();
  const scannedAt = realNow();

  Date.now = () => scannedAt + 16 * 60_000;

  mockCheckinHappyPath();
  stubMethod(prisma.fraudLog, 'create', async () => ({}));

  const res = await request(app).post('/api/checkin')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ eventId: 'evt-1', ticket, type: 'checkin', deviceId: 'dev-1' });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'QR_EXPIRED');
});

test('the plain QR token still works on its own for clients without a ticket', async () => {
  mockCheckinHappyPath();

  const res = await request(app).post('/api/checkin')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      eventId: 'evt-1',
      token: qrService.generateToken('evt-1', 'checkin'),
      type: 'checkin',
      deviceId: 'dev-1',
    });

  assert.strictEqual(res.status, 200);
});

test('check-in without either a token or a ticket is refused', async () => {
  stubMethod(prisma.user, 'findUnique', async () => AUTH_USER);

  const res = await request(app).post('/api/checkin')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ eventId: 'evt-1', type: 'checkin', deviceId: 'dev-1' });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'MISSING_PARAMS');
});
