const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');
const emailService = require('../src/services/email.service');
const app = require('../src/app');
const { stubMethod, restoreStubs } = require('../testenv');

const ADMIN = { id: 'admin-1', mssv: null, email: 'admin@fpt.edu.vn', name: 'Admin', role: 'ADMIN', isActive: true, isFirstLogin: false };
const STUDENT = { id: 'u-1', mssv: 'SE1', email: 'sv@fpt.edu.vn', name: 'An', role: 'BTC', isActive: true, isFirstLogin: false };

function tokenFor(id) {
  return jwt.sign({ userId: id }, process.env.JWT_SECRET);
}

// authenticate() tra req.user bằng findUnique; controller cũng dùng findUnique
// để lấy target → phân nhánh theo id trong cùng một stub.
function mockAuth(caller = ADMIN, target = STUDENT) {
  stubMethod(prisma.user, 'findUnique', async ({ where }) =>
    where.id === caller.id ? caller : where.id === target.id ? target : null
  );
}

function resetReq(id = STUDENT.id, caller = ADMIN) {
  return request(app)
    .post(`/api/admin/users/${id}/reset-password`)
    .set('Authorization', `Bearer ${tokenFor(caller.id)}`);
}

afterEach(() => restoreStubs());

test('non-admin cannot reset another user password', async () => {
  const btc = { ...STUDENT, id: 'btc-1', role: 'BTC' };
  mockAuth(btc);
  stubMethod(prisma.user, 'update', async () => { throw new Error('must not update'); });

  const res = await resetReq(STUDENT.id, btc).send({});
  assert.strictEqual(res.status, 403);
});

test('admin reset without a password generates one and emails it', async () => {
  mockAuth();
  const updateStub = stubMethod(prisma.user, 'update', async () => ({}));
  const mailStub = stubMethod(emailService, 'sendPasswordResetEmail', async () => {});

  const res = await resetReq().send({});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.emailSent, true);
  assert.ok(res.body.password.length >= 6, 'expected a generated password in the response');

  const data = updateStub.calls[0][0].data;
  assert.strictEqual(data.isFirstLogin, true);
  assert.strictEqual(data.failedLoginAttempts, 0);
  assert.strictEqual(data.lockedUntil, null);
  assert.ok(await bcrypt.compare(res.body.password, data.passwordHash), 'hash must match the returned password');

  assert.deepStrictEqual(mailStub.calls[0].slice(0, 2), [STUDENT.email, STUDENT.name]);
});

test('admin can set an explicit password', async () => {
  mockAuth();
  const updateStub = stubMethod(prisma.user, 'update', async () => ({}));
  stubMethod(emailService, 'sendPasswordResetEmail', async () => {});

  const res = await resetReq().send({ newPassword: 'MatKhau123' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.password, 'MatKhau123');
  assert.ok(await bcrypt.compare('MatKhau123', updateStub.calls[0][0].data.passwordHash));
});

test('a participant (STUDENT) never gets a password — they have no account', async () => {
  const participant = { ...STUDENT, id: 'p-1', role: 'STUDENT' };
  mockAuth(ADMIN, participant);
  stubMethod(prisma.user, 'update', async () => { throw new Error('must not update'); });

  const res = await resetReq(participant.id).send({});
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'NOT_STAFF');
});

test('password shorter than 6 characters is rejected', async () => {
  mockAuth();
  stubMethod(prisma.user, 'update', async () => { throw new Error('must not update'); });

  const res = await resetReq().send({ newPassword: 'abc' });
  assert.strictEqual(res.status, 400);
});

test('unknown target user returns 404', async () => {
  mockAuth();
  stubMethod(prisma.user, 'update', async () => { throw new Error('must not update'); });

  const res = await resetReq('missing-id').send({});
  assert.strictEqual(res.status, 404);
});

test('email failure still resets the password and reports emailSent:false', async () => {
  mockAuth();
  const updateStub = stubMethod(prisma.user, 'update', async () => ({}));
  stubMethod(emailService, 'sendPasswordResetEmail', async () => { throw new Error('brevo down'); });

  const res = await resetReq().send({});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.emailSent, false);
  assert.strictEqual(updateStub.calls.length, 1);
});
