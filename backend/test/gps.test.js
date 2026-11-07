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
const ADMIN_USER = { id: 'admin-1', mssv: null, email: 'admin@b.c', name: 'Admin', role: 'ADMIN', isActive: true, isFirstLogin: false };

function mockEvent(overrides = {}) {
  const base = {
    id: 'evt-1', name: 'Event', isWhitelisted: false, isActive: true, gpsEnabled: true,
    checkinOpen: new Date(Date.now() - 3600e3), checkinClose: new Date(Date.now() + 3600e3),
    checkoutOpen: new Date(Date.now() - 3600e3), checkoutClose: new Date(Date.now() + 3600e3),
    lat: 10.85, lng: 106.77, radius: 100,
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

function checkinBody(gps) {
  return { eventId: 'evt-1', token: qrService.generateToken('evt-1', 'checkin'), type: 'checkin', gps, deviceId: 'dev-1' };
}

afterEach(() => restoreStubs());

test('non-numeric GPS strings are rejected with GPS_INVALID and a fraud log', async () => {
  stubMethod(prisma.user, 'findUnique', async () => AUTH_USER);
  mockEvent();
  const fraudStub = stubMethod(prisma.fraudLog, 'create', async () => ({}));
  const upsertStub = stubMethod(prisma.attendance, 'upsert', async () => ({}));

  const res = await request(app).post('/api/checkin').set('Authorization', `Bearer ${token}`)
    .send(checkinBody({ lat: 'abc', lng: 'abc' }));
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'GPS_INVALID');
  assert.strictEqual(fraudStub.calls.length, 1);
  assert.strictEqual(fraudStub.calls[0][0].data.reason, 'GPS_INVALID');
  assert.strictEqual(upsertStub.calls.length, 0);
});

test('valid numeric GPS within radius passes', async () => {
  stubMethod(prisma.user, 'findUnique', async () => AUTH_USER);
  mockEvent();
  mockAttendanceHappyPath();

  const res = await request(app).post('/api/checkin').set('Authorization', `Bearer ${token}`)
    .send(checkinBody({ lat: 10.85, lng: 106.77 }));
  assert.strictEqual(res.status, 200);
});

test('missing GPS still returns GPS_REQUIRED', async () => {
  stubMethod(prisma.user, 'findUnique', async () => AUTH_USER);
  mockEvent();

  const res = await request(app).post('/api/checkin').set('Authorization', `Bearer ${token}`)
    .send(checkinBody(null));
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'GPS_REQUIRED');
});

test('out-of-range numeric GPS returns OUT_OF_RANGE', async () => {
  stubMethod(prisma.user, 'findUnique', async () => AUTH_USER);
  mockEvent();
  stubMethod(prisma.fraudLog, 'create', async () => ({}));

  const res = await request(app).post('/api/checkin').set('Authorization', `Bearer ${token}`)
    .send(checkinBody({ lat: 20, lng: 120 }));
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'OUT_OF_RANGE');
});

const validEventPayload = {
  name: 'Event A', location: 'Hall', lat: '10.85', lng: '106.77', radius: '100',
  gpsEnabled: true,
  checkinOpen: new Date(Date.now() - 3600e3).toISOString(),
  checkinClose: new Date(Date.now() + 3600e3).toISOString(),
  checkoutOpen: new Date(Date.now() + 7200e3).toISOString(),
  checkoutClose: new Date(Date.now() + 10800e3).toISOString(),
  isWhitelisted: false,
};

test('createEvent rejects gpsEnabled:true without valid coords', async () => {
  stubMethod(prisma.user, 'findUnique', async () => ADMIN_USER);
  const createStub = stubMethod(prisma.event, 'create', async () => ({}));

  const res = await request(app).post('/api/events').set('Authorization', `Bearer ${token}`)
    .send({ ...validEventPayload, lat: '', lng: '' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(createStub.calls.length, 0);
});

test('createEvent rejects invalid radius values', async () => {
  stubMethod(prisma.user, 'findUnique', async () => ADMIN_USER);
  const createStub = stubMethod(prisma.event, 'create', async () => ({}));

  for (const radius of ['abc', 0, -50]) {
    const res = await request(app).post('/api/events').set('Authorization', `Bearer ${token}`)
      .send({ ...validEventPayload, radius });
    assert.strictEqual(res.status, 400, `radius=${radius} should be rejected`);
  }
  assert.strictEqual(createStub.calls.length, 0);
});

test('createEvent accepts valid coords and numeric-string radius', async () => {
  stubMethod(prisma.user, 'findUnique', async () => ADMIN_USER);
  const createStub = stubMethod(prisma.event, 'create', async () => ({ id: 'e1' }));

  const res = await request(app).post('/api/events').set('Authorization', `Bearer ${token}`)
    .send(validEventPayload);
  assert.strictEqual(res.status, 201);
  const dataArg = createStub.calls[0][0].data;
  assert.strictEqual(dataArg.lat, 10.85);
  assert.strictEqual(dataArg.lng, 106.77);
  assert.strictEqual(dataArg.radius, 100);
});

test('updateEvent rejects invalid coords when gpsEnabled stays on', async () => {
  stubMethod(prisma.user, 'findUnique', async () => ADMIN_USER);
  stubMethod(prisma.event, 'findUnique', async () => ({
    id: 'evt-1', createdById: 'admin-1', gpsEnabled: true, lat: 10.85, lng: 106.77, radius: 100,
  }));
  const updateStub = stubMethod(prisma.event, 'update', async () => ({}));

  const res = await request(app).put('/api/events/evt-1').set('Authorization', `Bearer ${token}`)
    .send({ lat: 'abc' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(updateStub.calls.length, 0);
});
