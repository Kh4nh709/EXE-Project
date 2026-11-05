const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Prisma } = require('@prisma/client');
const prisma = require('../src/lib/prisma');
const app = require('../src/app');
const { stubMethod, restoreStubs } = require('../testenv');

afterEach(() => restoreStubs());

const btcToken = jwt.sign({ userId: 'btc-1' }, process.env.JWT_SECRET);
const BTC_USER = { id: 'btc-1', mssv: null, email: 'btc@b.c', name: 'BTC One', role: 'BTC', isActive: true, isFirstLogin: false };
const URL = '/api/events/evt-1/attendance/stu-1/checkin';

function setup({ event = {}, certificate = null, count = 1 } = {}) {
  stubMethod(prisma.user, 'findUnique', async () => BTC_USER);
  stubMethod(prisma.event, 'findUnique', async () => ({ id: 'evt-1', kind: 'STANDARD', createdById: 'btc-1', ...event }));
  stubMethod(prisma.certificate, 'findFirst', async () => certificate);
  return stubMethod(prisma.attendance, 'updateMany', async () => ({ count }));
}

test('undo check-in resets the row to REGISTERED without deleting it', async () => {
  const update = setup();
  const res = await request(app).delete(URL).set('Authorization', `Bearer ${btcToken}`);
  assert.strictEqual(res.status, 200);
  const { where, data } = update.calls[0][0];
  assert.deepStrictEqual(where, { eventId: 'evt-1', userId: 'stu-1', checkinTime: { not: null } });
  assert.strictEqual(data.status, 'REGISTERED');
  assert.strictEqual(data.checkinTime, null);
  assert.strictEqual(data.checkoutTime, null);
  assert.strictEqual(data.checkinGps, Prisma.DbNull);
});

test('undo check-in answers NOT_CHECKED_IN when there is nothing to undo', async () => {
  setup({ count: 0 });
  const res = await request(app).delete(URL).set('Authorization', `Bearer ${btcToken}`);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'NOT_CHECKED_IN');
});

test('undo check-in is refused while a certificate is issued', async () => {
  const update = setup({ certificate: { id: 'cert-1' } });
  const res = await request(app).delete(URL).set('Authorization', `Bearer ${btcToken}`);
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error, 'CERTIFICATE_ISSUED');
  assert.strictEqual(update.calls.length, 0);
});

test('undo check-in: only ADMIN or the event creator, and only STANDARD events', async () => {
  let update = setup({ event: { createdById: 'someone-else' } });
  let res = await request(app).delete(URL).set('Authorization', `Bearer ${btcToken}`);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(update.calls.length, 0);
  restoreStubs();

  update = setup({ event: { kind: 'INVITATION' } });
  res = await request(app).delete(URL).set('Authorization', `Bearer ${btcToken}`);
  assert.strictEqual(res.body.error, 'INVITATION_EVENT');
  assert.strictEqual(update.calls.length, 0);
});
