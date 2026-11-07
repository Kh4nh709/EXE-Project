const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const prisma = require('../src/lib/prisma');
const qrService = require('../src/services/qr.service');
const app = require('../src/app');
const { resolveGate } = require('../src/lib/attendanceGate');
const { stubMethod, restoreStubs } = require('../testenv');

const HOUR = 3600e3;
const token = jwt.sign({ userId: 'student-1' }, process.env.JWT_SECRET);
const AUTH_USER = { id: 'student-1', mssv: 'SE1', email: 'a@b.c', name: 'An', role: 'STUDENT', isActive: true, isFirstLogin: false };

function mockEvent(overrides = {}) {
  const base = {
    id: 'evt-1', name: 'Event', isWhitelisted: false, isActive: true, gpsEnabled: false,
    checkinOpen: null, checkinClose: null, checkoutOpen: null, checkoutClose: null,
    checkinState: 'AUTO', checkoutState: 'AUTO',
    lat: null, lng: null, radius: 100,
  };
  stubMethod(prisma.event, 'findUnique', async () => ({ ...base, ...overrides }));
}

function mockAttendanceHappyPath() {
  stubMethod(prisma.deviceBinding, 'findFirst', async () => ({ id: 'b1', userId: 'student-1', deviceId: 'dev-1', isTrusted: true }));
  stubMethod(prisma.attendance, 'findUnique', async () => null);
  // Luật một máy một người: chưa ai khác check-in bằng máy này.
  stubMethod(prisma.attendance, 'findFirst', async () => null);
  stubMethod(prisma.attendance, 'upsert', async () => ({ id: 'a1' }));
}

function checkinBody(overrides = {}) {
  return {
    eventId: 'evt-1',
    token: qrService.generateToken('evt-1', 'checkin'),
    type: 'checkin',
    gps: null,
    deviceId: 'dev-1',
    ...overrides,
  };
}

afterEach(() => restoreStubs());

// ── resolveGate: đơn vị ─────────────────────────────────────────

test('resolveGate: OPEN luôn mở bất kể khung giờ', () => {
  const g = resolveGate('OPEN', null, null);
  assert.strictEqual(g.open, true);
});

test('resolveGate: CLOSED luôn đóng bất kể khung giờ hợp lệ', () => {
  const now = new Date();
  const g = resolveGate('CLOSED', new Date(now - HOUR), new Date(now.getTime() + HOUR), now);
  assert.strictEqual(g.open, false);
  assert.strictEqual(g.reason, 'MANUALLY_CLOSED');
});

test('resolveGate: AUTO chưa đặt giờ → đóng, chờ mở tay', () => {
  const g = resolveGate('AUTO', null, null);
  assert.strictEqual(g.open, false);
  assert.strictEqual(g.reason, 'NOT_OPENED');
});

test('resolveGate: AUTO có giờ, đang trong khung → mở', () => {
  const now = new Date();
  const g = resolveGate('AUTO', new Date(now.getTime() - HOUR), new Date(now.getTime() + HOUR), now);
  assert.strictEqual(g.open, true);
});

test('resolveGate: AUTO có giờ, trước khung → đóng NOT_STARTED', () => {
  const now = new Date();
  const g = resolveGate('AUTO', new Date(now.getTime() + HOUR), new Date(now.getTime() + 2 * HOUR), now);
  assert.strictEqual(g.open, false);
  assert.strictEqual(g.reason, 'NOT_STARTED');
});

test('resolveGate: AUTO có giờ, sau khung → đóng ENDED', () => {
  const now = new Date();
  const g = resolveGate('AUTO', new Date(now.getTime() - 2 * HOUR), new Date(now.getTime() - HOUR), now);
  assert.strictEqual(g.open, false);
  assert.strictEqual(g.reason, 'ENDED');
});

// ── processCheckin: mở/đóng thủ công, không cần đặt lịch ────────

test('checkinState=OPEN cho phép check-in dù event không đặt giờ nào', async () => {
  stubMethod(prisma.user, 'findUnique', async () => AUTH_USER);
  mockEvent({ checkinState: 'OPEN' });
  mockAttendanceHappyPath();

  const res = await request(app).post('/api/checkin').set('Authorization', `Bearer ${token}`).send(checkinBody());
  assert.strictEqual(res.status, 200);
});

test('checkinState=CLOSED chặn check-in dù đang trong khung giờ hợp lệ', async () => {
  stubMethod(prisma.user, 'findUnique', async () => AUTH_USER);
  const now = new Date();
  mockEvent({
    checkinState: 'CLOSED',
    checkinOpen: new Date(now.getTime() - HOUR), checkinClose: new Date(now.getTime() + HOUR),
  });
  const upsertStub = stubMethod(prisma.attendance, 'upsert', async () => ({}));

  const res = await request(app).post('/api/checkin').set('Authorization', `Bearer ${token}`).send(checkinBody());
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'ATTENDANCE_CLOSED');
  assert.strictEqual(upsertStub.calls.length, 0);
});

test('AUTO + chưa đặt giờ nào → chặn với ATTENDANCE_NOT_OPEN, không phải OUTSIDE_TIME_WINDOW', async () => {
  stubMethod(prisma.user, 'findUnique', async () => AUTH_USER);
  mockEvent(); // checkinState AUTO mặc định, không có giờ
  const upsertStub = stubMethod(prisma.attendance, 'upsert', async () => ({}));

  const res = await request(app).post('/api/checkin').set('Authorization', `Bearer ${token}`).send(checkinBody());
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'ATTENDANCE_NOT_OPEN');
  assert.strictEqual(upsertStub.calls.length, 0);
});

test('checkout dùng đúng checkoutState độc lập với checkinState', async () => {
  stubMethod(prisma.user, 'findUnique', async () => AUTH_USER);
  mockEvent({ checkinState: 'CLOSED', checkoutState: 'OPEN' });
  stubMethod(prisma.deviceBinding, 'findFirst', async () => ({ id: 'b1', userId: 'student-1', deviceId: 'dev-1', isTrusted: true }));
  stubMethod(prisma.attendance, 'findUnique', async () => ({ id: 'a1', checkinTime: new Date(), checkoutTime: null }));
  stubMethod(prisma.attendance, 'update', async () => ({ id: 'a1' }));

  const res = await request(app).post('/api/checkin').set('Authorization', `Bearer ${token}`)
    .send(checkinBody({ type: 'checkout', token: qrService.generateToken('evt-1', 'checkout') }));

  assert.strictEqual(res.status, 200);
});

test('khung giờ hết hạn vẫn báo OUTSIDE_TIME_WINDOW như hành vi cũ khi ở chế độ AUTO', async () => {
  stubMethod(prisma.user, 'findUnique', async () => AUTH_USER);
  const now = new Date();
  mockEvent({ checkinOpen: new Date(now.getTime() - 2 * HOUR), checkinClose: new Date(now.getTime() - HOUR) });
  const upsertStub = stubMethod(prisma.attendance, 'upsert', async () => ({}));

  const res = await request(app).post('/api/checkin').set('Authorization', `Bearer ${token}`).send(checkinBody());
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'OUTSIDE_TIME_WINDOW');
  assert.strictEqual(upsertStub.calls.length, 0);
});
