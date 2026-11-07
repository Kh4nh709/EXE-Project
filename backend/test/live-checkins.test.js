const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const prisma = require('../src/lib/prisma');
const app = require('../src/app');
const { stubMethod, restoreStubs } = require('../testenv');

const USERS = {
  'btc-1': { id: 'btc-1', mssv: null, email: 'btc@f.c', name: 'BTC', role: 'BTC', isActive: true, isFirstLogin: false },
  'btc-2': { id: 'btc-2', mssv: null, email: 'btc2@f.c', name: 'BTC 2', role: 'BTC', isActive: true, isFirstLogin: false },
  // Người tham gia không đăng nhập (2026-11-07): người dùng không phải BTC giờ là nhân sự khác.
  'stu-1': { id: 'stu-1', mssv: 'SE1', email: 'se1@f.c', name: 'SV', role: 'LECTURER', isActive: true, isFirstLogin: false },
};
const auth = (id) => `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET)}`;

function setup() {
  stubMethod(prisma.user, 'findUnique', async ({ where }) => USERS[where.id] || null);
  stubMethod(prisma.event, 'findUnique', async () => ({ id: 'evt-1', createdById: 'btc-1' }));
}

afterEach(() => restoreStubs());

test('live: chủ sự kiện nhận danh sách mới nhất, chỉ có tên', async () => {
  setup();
  const findMany = stubMethod(prisma.attendance, 'findMany', async () => [
    { id: 'a2', checkinTime: new Date('2026-10-01T03:01:00Z'), user: { name: 'Bình' } },
    { id: 'a1', checkinTime: new Date('2026-10-01T03:00:00Z'), user: { name: 'An' } },
  ]);
  let countCall = 0;
  stubMethod(prisma.attendance, 'count', async () => (countCall++ === 0 ? 2 : 10));

  const res = await request(app).get('/api/events/evt-1/live').set('Authorization', auth('btc-1'));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['cache-control'], 'no-store');
  assert.strictEqual(res.body.data.checkedIn, 2);
  assert.strictEqual(res.body.data.registered, 10);
  assert.deepStrictEqual(res.body.data.recent.map((r) => r.name), ['Bình', 'An']);
  // Màn chiếu công khai: không được select MSSV/email/lớp.
  assert.deepStrictEqual(findMany.calls[0][0].select.user, { select: { name: true } });
  assert.deepStrictEqual(Object.keys(res.body.data.recent[0]).sort(), ['checkinTime', 'id', 'name']);
});

test('live: BTC khác và sinh viên không xem được', async () => {
  setup();
  const other = await request(app).get('/api/events/evt-1/live').set('Authorization', auth('btc-2'));
  assert.strictEqual(other.status, 403);
  const student = await request(app).get('/api/events/evt-1/live').set('Authorization', auth('stu-1'));
  assert.strictEqual(student.status, 403);
});
