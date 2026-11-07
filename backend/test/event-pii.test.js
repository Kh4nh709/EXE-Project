const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const prisma = require('../src/lib/prisma');
const app = require('../src/app');
const { stubMethod, restoreStubs } = require('../testenv');

const token = jwt.sign({ userId: 'lect-1' }, process.env.JWT_SECRET);
const LECTURER_USER = { id: 'lect-1', mssv: null, email: 'lect@b.c', name: 'Lecturer', role: 'LECTURER', isActive: true, isFirstLogin: false };

afterEach(() => restoreStubs());

test('getAttendance: non-owner LECTURER gets 403', async () => {
  stubMethod(prisma.user, 'findUnique', async () => LECTURER_USER);
  stubMethod(prisma.event, 'findUnique', async () => ({ id: 'evt-1', createdById: 'btc-1' }));

  const res = await request(app).get('/api/events/evt-1/attendance').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 403);
});

test('getAttendance: owner gets data', async () => {
  stubMethod(prisma.user, 'findUnique', async () => LECTURER_USER);
  stubMethod(prisma.event, 'findUnique', async () => ({ id: 'evt-1', createdById: 'lect-1' }));
  stubMethod(prisma.attendance, 'findMany', async () => []);
  stubMethod(prisma.attendance, 'count', async () => 0);
  stubMethod(prisma.attendance, 'groupBy', async () => []);

  const res = await request(app).get('/api/events/evt-1/attendance').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
});

test('listMembers: non-owner gets 403', async () => {
  stubMethod(prisma.user, 'findUnique', async () => LECTURER_USER);
  stubMethod(prisma.event, 'findUnique', async () => ({ id: 'evt-1', createdById: 'btc-1' }));

  const res = await request(app).get('/api/events/evt-1/members').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 403);
});

test('tìm người trong toàn hệ thống để thêm vào sự kiện đã bị bỏ (lộ danh sách của BTC khác)', async () => {
  stubMethod(prisma.user, 'findUnique', async () => LECTURER_USER);

  const res = await request(app).get('/api/events/evt-1/members/search?q=a').set('Authorization', `Bearer ${token}`);
  assert.notStrictEqual(res.status, 200);
});

test('exportAttendance: non-owner gets 403', async () => {
  stubMethod(prisma.user, 'findUnique', async () => LECTURER_USER);
  stubMethod(prisma.event, 'findUnique', async () => ({ id: 'evt-1', createdById: 'btc-1' }));

  const res = await request(app).get('/api/reports/events/evt-1/export').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 403);
});

test('exportAttendance: owner gets xlsx download', async () => {
  stubMethod(prisma.user, 'findUnique', async () => LECTURER_USER);
  stubMethod(prisma.event, 'findUnique', async () => ({ id: 'evt-1', name: 'Event A', location: 'Hall', checkinOpen: new Date(), createdById: 'lect-1' }));
  stubMethod(prisma.attendance, 'findMany', async () => []);

  const res = await request(app).get('/api/reports/events/evt-1/export').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /spreadsheetml/);
});

test('getEvent: non-owner response has lat/lng/radius stripped', async () => {
  stubMethod(prisma.user, 'findUnique', async () => LECTURER_USER);
  stubMethod(prisma.event, 'findUnique', async () => ({
    id: 'evt-1', name: 'Event', createdById: 'btc-1', lat: 10.85, lng: 106.77, radius: 100,
    createdBy: { name: 'BTC', email: 'btc@b.c' }, _count: { attendances: 1, eventMembers: 2 },
  }));

  const res = await request(app).get('/api/events/evt-1').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.lat, null);
  assert.strictEqual(res.body.data.lng, null);
  assert.strictEqual(res.body.data.radius, null);
});

test('getEvent: owner keeps coords', async () => {
  stubMethod(prisma.user, 'findUnique', async () => LECTURER_USER);
  stubMethod(prisma.event, 'findUnique', async () => ({
    id: 'evt-1', name: 'Event', createdById: 'lect-1', lat: 10.85, lng: 106.77, radius: 100,
    createdBy: { name: 'Lecturer', email: 'lect@b.c' }, _count: { attendances: 1, eventMembers: 2 },
  }));

  const res = await request(app).get('/api/events/evt-1').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.lat, 10.85);
  assert.strictEqual(res.body.data.radius, 100);
});
