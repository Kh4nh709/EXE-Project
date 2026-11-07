const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const prisma = require('../src/lib/prisma');
const app = require('../src/app');
const { validateRows, parseSheet } = require('../src/lib/participants');
const { stubMethod, restoreStubs } = require('../testenv');

// Người tham gia không có tài khoản (spec 2026-11-07-participant-lists-design.md):
// BTC nhập danh sách vào từng sự kiện, họ không đăng nhập được bằng bất kỳ đường nào.

afterEach(() => restoreStubs());

const BTC = { id: 'btc-1', mssv: null, email: 'btc@f.c', name: 'BTC', role: 'BTC', isActive: true, isFirstLogin: false };
const PARTICIPANT = { id: 'p-1', mssv: 'SE1', email: 'sv@fpt.edu.vn', name: 'An', role: 'STUDENT', isActive: true, isFirstLogin: false };
const bearer = (id) => `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET)}`;

// ── Chặn đăng nhập ──────────────────────────────────────────────────────────

test('login never matches a participant — same error as a wrong password, no lockout counting', async () => {
  const find = stubMethod(prisma.user, 'findFirst', async () => null);
  const update = stubMethod(prisma.user, 'update', async () => { throw new Error('must not count failures'); });

  const res = await request(app).post('/api/auth/login').send({ identifier: 'sv@fpt.edu.vn', password: 'x', deviceId: 'd' });

  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(find.calls[0][0].where.role, { not: 'STUDENT' });
  assert.strictEqual(update.calls.length, 0);
});

test('forgot-password never sends a reset code to a participant', async () => {
  const find = stubMethod(prisma.user, 'findFirst', async () => null);
  const create = stubMethod(prisma.otpToken, 'create', async () => { throw new Error('must not create'); });

  const res = await request(app).post('/api/auth/forgot-password').send({ identifier: 'sv@fpt.edu.vn' });

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(find.calls[0][0].where.role, { not: 'STUDENT' });
  assert.strictEqual(create.calls.length, 0);
});

test('a JWT issued to a participant before the change is refused with 401', async () => {
  stubMethod(prisma.user, 'findUnique', async () => PARTICIPANT);
  const res = await request(app).get('/api/auth/me').set('Authorization', bearer('p-1'));
  assert.strictEqual(res.status, 401);
});

test('password-less login by emailed code is gone', async () => {
  for (const path of ['/api/auth/login-otp/request', '/api/auth/login-otp/verify']) {
    const res = await request(app).post(path).send({ identifier: 'sv@fpt.edu.vn', deviceId: 'd' });
    assert.strictEqual(res.status, 404, path);
  }
});

test('admin cannot create a participant account', async () => {
  const admin = { ...BTC, id: 'ad-1', role: 'ADMIN' };
  stubMethod(prisma.user, 'findUnique', async () => admin);
  const create = stubMethod(prisma.user, 'create', async () => { throw new Error('must not create'); });

  const res = await request(app).post('/api/admin/users').set('Authorization', bearer('ad-1'))
    .send({ email: 'x@fpt.edu.vn', name: 'X', role: 'STUDENT' });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'NOT_STAFF');
  assert.strictEqual(create.calls.length, 0);
});

test('admin user list shows only staff unless participants are asked for', async () => {
  const admin = { ...BTC, id: 'ad-1', role: 'ADMIN' };
  stubMethod(prisma.user, 'findUnique', async () => admin);
  const findMany = stubMethod(prisma.user, 'findMany', async () => []);
  stubMethod(prisma.user, 'count', async () => 0);

  await request(app).get('/api/admin/users').set('Authorization', bearer('ad-1'));
  await request(app).get('/api/admin/users?role=STUDENT').set('Authorization', bearer('ad-1'));

  assert.deepStrictEqual(findMany.calls[0][0].where.role, { not: 'STUDENT' });
  assert.strictEqual(findMany.calls[1][0].where.role, 'STUDENT');
});

// ── Kiểm dòng ───────────────────────────────────────────────────────────────

test('validateRows normalises, needs email + name, and drops in-batch duplicates', () => {
  const { rows, skipped } = validateRows([
    { email: ' A@FPT.edu.vn ', name: '  Nguyễn   Văn  A ', mssv: 'se1' },
    { email: 'a@fpt.edu.vn', name: 'Trùng email' },
    { email: 'b@fpt.edu.vn', name: 'B', mssv: 'SE1' },
    { email: 'khong-hop-le', name: 'C' },
    { email: 'd@fpt.edu.vn', name: '' },
    { email: '', name: '', mssv: '' },
  ], { firstLine: 2 });

  assert.deepStrictEqual(rows, [{ email: 'a@fpt.edu.vn', name: 'Nguyễn Văn A', mssv: 'SE1', phone: '', line: 2 }]);
  assert.deepStrictEqual(skipped.map((s) => [s.line, s.reason]), [
    [3, 'Trùng email với dòng phía trên'],
    [4, 'Họ tên quá ngắn'],
    [5, 'Email không hợp lệ'],
    [6, 'Thiếu họ tên'],
  ]);
});

test('parseSheet recognises Vietnamese headers and needs Email + Họ tên', () => {
  const book = (rows) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'DS');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  };

  const ok = parseSheet(book([['STT', 'Họ và tên', 'MSSV', 'Địa chỉ email'], [1, 'An', 'SE1', 'an@fpt.edu.vn']]));
  assert.deepStrictEqual(ok.rows, [{ name: 'An', mssv: 'SE1', email: 'an@fpt.edu.vn' }]);

  const missing = parseSheet(book([['Họ tên', 'MSSV'], ['An', 'SE1']]));
  assert.match(missing.error, /Email/);
});

// ── Nhập vào sự kiện ────────────────────────────────────────────────────────

function ownedEvent() {
  stubMethod(prisma.user, 'findUnique', async ({ where }) => (where.id === 'btc-1' ? BTC : null));
  stubMethod(prisma.event, 'findUnique', async () => ({ id: 'evt-1', kind: 'STANDARD', createdById: 'btc-1', isActive: true }));
}

function people({ existing = [] } = {}) {
  const created = [];
  const createUsers = stubMethod(prisma.user, 'createMany', async ({ data }) => {
    data.forEach((d) => created.push({ id: `new-${created.length + 1}`, ...d }));
    return { count: data.length };
  });
  stubMethod(prisma.user, 'findMany', async ({ where }) => (where.OR ? existing : created));
  stubMethod(prisma.user, 'update', async ({ data }) => data);
  const members = stubMethod(prisma.eventMember, 'createMany', async ({ data }) => ({ count: data.length }));
  const attendance = stubMethod(prisma.attendance, 'createMany', async ({ data }) => ({ count: data.length }));
  stubMethod(prisma, '$transaction', async (ops) => Promise.all(ops));
  return { createUsers, members, attendance };
}

test('BTC adds people by email: new ones are created without a password, both tables are written', async () => {
  ownedEvent();
  const { createUsers, members, attendance } = people({
    existing: [{ id: 'old-1', email: 'cu@fpt.edu.vn', mssv: 'SE9', phone: null, isActive: true }],
  });

  const res = await request(app).post('/api/events/evt-1/members').set('Authorization', bearer('btc-1'))
    .send({ participants: [{ email: 'cu@fpt.edu.vn', name: 'Cũ' }, { email: 'moi@fpt.edu.vn', name: 'Mới' }] });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.added, 2);
  assert.strictEqual(res.body.created, 1);
  const [created] = createUsers.calls[0][0].data;
  assert.strictEqual(created.role, 'STUDENT');
  assert.strictEqual(created.passwordHash, '!');
  assert.deepStrictEqual(members.calls[0][0].data.map((m) => m.userId), ['old-1', 'new-1']);
  assert.deepStrictEqual(attendance.calls[0][0].data.map((a) => a.status), ['REGISTERED', 'REGISTERED']);
});

test('a new email whose MSSV already belongs to someone else is skipped with a reason', async () => {
  ownedEvent();
  const { createUsers } = people({
    existing: [{ id: 'old-1', email: 'khac@fpt.edu.vn', mssv: 'SE1', phone: null, isActive: true }],
  });

  const res = await request(app).post('/api/events/evt-1/members').set('Authorization', bearer('btc-1'))
    .send({ participants: [{ email: 'moi@fpt.edu.vn', name: 'Mới', mssv: 'SE1' }] });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.added, 0);
  assert.strictEqual(createUsers.calls.length, 0);
  assert.match(res.body.skipped[0].reason, /MSSV SE1/);
});

test('BTC imports an Excel file; skipped rows report their spreadsheet line', async () => {
  ownedEvent();
  people();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Email', 'Họ tên'], ['a@fpt.edu.vn', 'An'], ['sai', 'Bình'],
  ]), 'DS');
  const file = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const res = await request(app).post('/api/events/evt-1/members/import').set('Authorization', bearer('btc-1'))
    .attach('file', file, 'ds.xlsx');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.added, 1);
  assert.deepStrictEqual(res.body.skipped.map((s) => s.line), [3]);
});

test('another BTC cannot add people to an event they did not create', async () => {
  stubMethod(prisma.user, 'findUnique', async () => ({ ...BTC, id: 'btc-2' }));
  stubMethod(prisma.event, 'findUnique', async () => ({ id: 'evt-1', kind: 'STANDARD', createdById: 'btc-1', isActive: true }));
  const { createUsers } = people();

  const res = await request(app).post('/api/events/evt-1/members').set('Authorization', bearer('btc-2'))
    .send({ participants: [{ email: 'a@fpt.edu.vn', name: 'A' }] });

  assert.strictEqual(res.status, 403);
  assert.strictEqual(createUsers.calls.length, 0);
});
