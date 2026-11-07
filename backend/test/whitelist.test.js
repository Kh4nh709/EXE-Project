const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const prisma = require('../src/lib/prisma');
const qrService = require('../src/services/qr.service');
const app = require('../src/app');
const { stubMethod, restoreStubs } = require('../testenv');

const token = jwt.sign({ userId: 'student-1' }, process.env.JWT_SECRET);
// Người tham gia không đăng nhập (2026-11-07) — đường JWT chỉ còn cho nhân sự đi dự sự kiện;
// luật cổng/GPS/danh sách dùng chung lib/selfCheckin với đường thẻ OTP.
const AUTH_USER = { id: 'student-1', mssv: 'SE1', email: 'a@b.c', name: 'An', role: 'LECTURER', isActive: true, isFirstLogin: false };

function mockEvent(overrides = {}) {
  const base = {
    id: 'evt-1', name: 'Event', isWhitelisted: true, isActive: true, gpsEnabled: false,
    checkinOpen: new Date(Date.now() - 3600e3), checkinClose: new Date(Date.now() + 3600e3),
    checkoutOpen: new Date(Date.now() - 3600e3), checkoutClose: new Date(Date.now() + 3600e3),
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

test('public event allows a non-member and never checks membership', async () => {
  stubMethod(prisma.user, 'findUnique', async () => AUTH_USER);
  mockEvent({ isWhitelisted: false });
  stubMethod(prisma.eventMember, 'findUnique', async () => { throw new Error('eventMember must not be queried'); });
  mockAttendanceHappyPath();

  const res = await request(app).post('/api/checkin').set('Authorization', `Bearer ${token}`).send(checkinBody());
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
});

test('whitelisted event allows a registered member', async () => {
  stubMethod(prisma.user, 'findUnique', async () => AUTH_USER);
  mockEvent({ isWhitelisted: true });
  stubMethod(prisma.eventMember, 'findUnique', async () => ({ id: 'm1' }));
  mockAttendanceHappyPath();

  const res = await request(app).post('/api/checkin').set('Authorization', `Bearer ${token}`).send(checkinBody());
  assert.strictEqual(res.status, 200);
});

test('whitelisted event rejects a non-member with 403 NOT_REGISTERED and no attendance mutation', async () => {
  stubMethod(prisma.user, 'findUnique', async () => AUTH_USER);
  mockEvent({ isWhitelisted: true });
  stubMethod(prisma.eventMember, 'findUnique', async () => null);
  const upsertStub = stubMethod(prisma.attendance, 'upsert', async () => ({}));
  stubMethod(prisma.fraudLog, 'create', async () => { throw new Error('fraudLog must not be called'); });

  const res = await request(app).post('/api/checkin').set('Authorization', `Bearer ${token}`).send(checkinBody());
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'NOT_REGISTERED');
  assert.strictEqual(upsertStub.calls.length, 0);
});

test('whitelist rejection also applies to checkout', async () => {
  stubMethod(prisma.user, 'findUnique', async () => AUTH_USER);
  mockEvent({ isWhitelisted: true });
  stubMethod(prisma.eventMember, 'findUnique', async () => null);
  stubMethod(prisma.attendance, 'upsert', async () => ({}));

  const res = await request(app).post('/api/checkin').set('Authorization', `Bearer ${token}`).send(
    checkinBody({ token: qrService.generateToken('evt-1', 'checkout'), type: 'checkout' })
  );
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'NOT_REGISTERED');
});
