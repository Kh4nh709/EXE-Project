const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const prisma = require('../src/lib/prisma');
const app = require('../src/app');
const { stubMethod, restoreStubs } = require('../testenv');

const btcToken = jwt.sign({ userId: 'btc-1' }, process.env.JWT_SECRET);
const studentToken = jwt.sign({ userId: 'student-1' }, process.env.JWT_SECRET);

const USERS = {
  'btc-1': { id: 'btc-1', mssv: null, email: 'btc1@f.c', name: 'BTC Một', role: 'BTC', isActive: true, isFirstLogin: false },
  'student-1': { id: 'student-1', mssv: 'SE1', email: 's@f.c', name: 'SV', role: 'STUDENT', isActive: true, isFirstLogin: false },
};

function mockAuth() {
  stubMethod(prisma.user, 'findUnique', async ({ where }) => USERS[where.id] || null);
}

const CLASS = { id: 'cls-1', name: 'SE1701', description: null, isActive: true, createdById: 'btc-1' };

function mockClass(overrides = {}) {
  return stubMethod(prisma.class, 'findUnique', async () => ({ ...CLASS, ...overrides }));
}

afterEach(() => restoreStubs());

// ── Quyền truy cập ─────────────────────────────────────────────

test('người tham gia (không có tài khoản) không vào được API quản lý lớp', async () => {
  mockAuth();
  const res = await request(app).get('/api/classes').set('Authorization', `Bearer ${studentToken}`);
  assert.strictEqual(res.status, 401);
});

test('chưa đăng nhập bị chặn 401', async () => {
  const res = await request(app).get('/api/classes');
  assert.strictEqual(res.status, 401);
});

// ── CRUD lớp ───────────────────────────────────────────────────

test('danh sách lớp kèm sĩ số hiện tại', async () => {
  mockAuth();
  stubMethod(prisma.class, 'findMany', async () => [
    { id: 'cls-1', name: 'SE1701', description: null, isActive: true, createdBy: { name: 'BTC Một' }, _count: { members: 30 } },
    { id: 'cls-2', name: 'SE1702', description: null, isActive: true, createdBy: { name: 'BTC Một' }, _count: { members: 0 } },
  ]);

  const res = await request(app).get('/api/classes').set('Authorization', `Bearer ${btcToken}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.find((c) => c.name === 'SE1701').memberCount, 30);
  assert.strictEqual(res.body.data.find((c) => c.name === 'SE1702').memberCount, 0);
});

test('tạo lớp thành công', async () => {
  mockAuth();
  stubMethod(prisma.class, 'findUnique', async () => null);
  const create = stubMethod(prisma.class, 'create', async ({ data }) => ({ id: 'cls-new', ...data, isActive: true }));

  const res = await request(app).post('/api/classes')
    .set('Authorization', `Bearer ${btcToken}`)
    .send({ name: '  SE1703  ', description: ' Khoá 17 ' });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(create.calls[0][0].data.name, 'SE1703');
  assert.strictEqual(create.calls[0][0].data.description, 'Khoá 17');
  assert.strictEqual(create.calls[0][0].data.createdById, 'btc-1');
  assert.strictEqual(res.body.data.memberCount, 0);
});

test('tạo lớp thiếu tên trả 400', async () => {
  mockAuth();
  const create = stubMethod(prisma.class, 'create', async () => { throw new Error('không được gọi'); });

  const res = await request(app).post('/api/classes').set('Authorization', `Bearer ${btcToken}`).send({ name: '  ' });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(create.calls.length, 0);
});

test('tạo lớp trùng tên trả 400', async () => {
  mockAuth();
  stubMethod(prisma.class, 'findUnique', async () => CLASS);
  const create = stubMethod(prisma.class, 'create', async () => { throw new Error('không được gọi'); });

  const res = await request(app).post('/api/classes').set('Authorization', `Bearer ${btcToken}`).send({ name: 'SE1701' });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(create.calls.length, 0);
});

test('đổi tên lớp chỉ đổi bản ghi lớp — danh sách lớp gắn theo id nên không phải sửa gì thêm', async () => {
  mockAuth();
  mockClass();
  stubMethod(prisma.class, 'findFirst', async () => null);
  const update = stubMethod(prisma.class, 'update', async ({ data }) => ({ ...CLASS, ...data }));
  const userUpdateMany = stubMethod(prisma.user, 'updateMany', async () => { throw new Error('không được gọi'); });
  stubMethod(prisma.classMember, 'count', async () => 30);

  const res = await request(app).put('/api/classes/cls-1')
    .set('Authorization', `Bearer ${btcToken}`)
    .send({ name: 'SE1701-Renamed' });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(update.calls[0][0].data.name, 'SE1701-Renamed');
  assert.strictEqual(res.body.data.memberCount, 30);
  assert.strictEqual(userUpdateMany.calls.length, 0);
});

test('đổi tên lớp trùng với lớp khác bị chặn, không đổi gì', async () => {
  mockAuth();
  mockClass();
  stubMethod(prisma.class, 'findFirst', async () => ({ id: 'cls-2', name: 'SE1702' }));
  const update = stubMethod(prisma.class, 'update', async () => { throw new Error('không được gọi'); });

  const res = await request(app).put('/api/classes/cls-1')
    .set('Authorization', `Bearer ${btcToken}`)
    .send({ name: 'SE1702' });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(update.calls.length, 0);
});

test('xoá lớp xoá luôn danh sách lớp (cascade), không cần dọn trước', async () => {
  mockAuth();
  mockClass();
  const del = stubMethod(prisma.class, 'delete', async () => ({}));

  const res = await request(app).delete('/api/classes/cls-1').set('Authorization', `Bearer ${btcToken}`);

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(del.calls[0][0], { where: { id: 'cls-1' } });
});

test('thao tác trên lớp không tồn tại trả 404', async () => {
  mockAuth();
  stubMethod(prisma.class, 'findUnique', async () => null);

  for (const req of [
    () => request(app).get('/api/classes/nope').set('Authorization', `Bearer ${btcToken}`),
    () => request(app).put('/api/classes/nope').set('Authorization', `Bearer ${btcToken}`).send({ description: 'x' }),
    () => request(app).delete('/api/classes/nope').set('Authorization', `Bearer ${btcToken}`),
  ]) {
    const res = await req();
    assert.strictEqual(res.status, 404);
  }
});

// ── Danh sách lớp (người tham gia không có tài khoản) ──────────

test('nhập người vào lớp bằng email + họ tên: tạo người còn thiếu, thêm vào ClassMember', async () => {
  mockAuth();
  mockClass();
  const created = [];
  stubMethod(prisma.user, 'findMany', async ({ where }) => (where.OR
    ? [{ id: 'u-old', email: 'cu@fpt.edu.vn', mssv: 'SE1', phone: null, isActive: true }]
    : created));
  const createUsers = stubMethod(prisma.user, 'createMany', async ({ data }) => {
    data.forEach((d) => created.push({ id: 'u-new', ...d }));
    return { count: data.length };
  });
  const members = stubMethod(prisma.classMember, 'createMany', async ({ data }) => ({ count: data.length }));

  const res = await request(app).post('/api/classes/cls-1/members')
    .set('Authorization', `Bearer ${btcToken}`)
    .send({ participants: [
      { email: 'cu@fpt.edu.vn', name: 'Người Cũ' },
      { email: 'Moi@FPT.edu.vn', name: 'Người Mới', mssv: 'se2' },
      { email: 'sai-email', name: 'Lỗi' },
    ] });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(createUsers.calls[0][0].data.length, 1);
  assert.strictEqual(createUsers.calls[0][0].data[0].email, 'moi@fpt.edu.vn');
  assert.deepStrictEqual(members.calls[0][0].data, [
    { classId: 'cls-1', userId: 'u-old' },
    { classId: 'cls-1', userId: 'u-new' },
  ]);
  assert.strictEqual(res.body.added, 2);
  assert.strictEqual(res.body.skipped.length, 1);
  assert.strictEqual(res.body.skipped[0].reason, 'Email không hợp lệ');
});

test('nhập danh sách rỗng trả 400', async () => {
  mockAuth();
  mockClass();
  const members = stubMethod(prisma.classMember, 'createMany', async () => { throw new Error('không được gọi'); });

  const res = await request(app).post('/api/classes/cls-1/members')
    .set('Authorization', `Bearer ${btcToken}`).send({ participants: [] });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(members.calls.length, 0);
});

test('gỡ khỏi danh sách lớp chỉ xoá ClassMember của đúng lớp này', async () => {
  mockAuth();
  mockClass();
  const deleteMany = stubMethod(prisma.classMember, 'deleteMany', async () => ({ count: 2 }));

  const res = await request(app).post('/api/classes/cls-1/members/remove')
    .set('Authorization', `Bearer ${btcToken}`)
    .send({ userIds: ['u1', 'u2'] });

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(deleteMany.calls[0][0], { where: { classId: 'cls-1', userId: { in: ['u1', 'u2'] } } });
});

test('tìm người trong toàn hệ thống để thêm vào lớp đã bị bỏ (lộ danh sách của BTC khác)', async () => {
  mockAuth();
  const res = await request(app).get('/api/classes/cls-1/members/search?q=an').set('Authorization', `Bearer ${btcToken}`);
  assert.notStrictEqual(res.status, 200);
});

// ── Buổi điểm danh ─────────────────────────────────────────────

const HOUR = 3600e3;
function sessionBody(overrides = {}) {
  return {
    location: 'Phòng A101',
    checkinOpen: new Date(Date.now() - HOUR).toISOString(),
    checkinClose: new Date(Date.now() + HOUR).toISOString(),
    checkoutOpen: new Date(Date.now() + HOUR).toISOString(),
    checkoutClose: new Date(Date.now() + 2 * HOUR).toISOString(),
    gpsEnabled: false,
    ...overrides,
  };
}

test('tạo buổi điểm danh: whitelist bắt buộc bật, không mở đăng ký công khai, tự thêm cả lớp', async () => {
  mockAuth();
  mockClass();
  const create = stubMethod(prisma.event, 'create', async ({ data }) => ({ id: 'evt-1', ...data }));
  stubMethod(prisma.classMember, 'findMany', async () => [{ userId: 'u1' }, { userId: 'u2' }]);
  const members = stubMethod(prisma.eventMember, 'createMany', async () => ({ count: 2 }));
  const attendance = stubMethod(prisma.attendance, 'createMany', async () => ({ count: 2 }));
  stubMethod(prisma, '$transaction', async (ops) => Promise.all(ops));

  const res = await request(app).post('/api/classes/cls-1/sessions')
    .set('Authorization', `Bearer ${btcToken}`)
    .send(sessionBody());

  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.enrolled, 2);

  const created = create.calls[0][0].data;
  assert.strictEqual(created.isWhitelisted, true);
  assert.strictEqual(created.allowRegistration, false);
  assert.strictEqual(created.classId, 'cls-1');
  assert.strictEqual(created.createdById, 'btc-1');
  assert.match(created.name, /SE1701/);

  assert.deepStrictEqual(members.calls[0][0].data, [
    { eventId: 'evt-1', userId: 'u1' },
    { eventId: 'evt-1', userId: 'u2' },
  ]);
  assert.deepStrictEqual(attendance.calls[0][0].data, [
    { eventId: 'evt-1', userId: 'u1', status: 'REGISTERED' },
    { eventId: 'evt-1', userId: 'u2', status: 'REGISTERED' },
  ]);
});

test('tạo buổi điểm danh dùng tên tuỳ chỉnh nếu có', async () => {
  mockAuth();
  mockClass();
  const create = stubMethod(prisma.event, 'create', async ({ data }) => ({ id: 'evt-1', ...data }));
  stubMethod(prisma.classMember, 'findMany', async () => []);
  stubMethod(prisma.eventMember, 'createMany', async () => ({ count: 0 }));
  stubMethod(prisma.attendance, 'createMany', async () => ({ count: 0 }));
  stubMethod(prisma, '$transaction', async (ops) => Promise.all(ops));

  const res = await request(app).post('/api/classes/cls-1/sessions')
    .set('Authorization', `Bearer ${btcToken}`)
    .send(sessionBody({ name: 'Buổi 5 - Lập trình Web' }));

  assert.strictEqual(res.status, 201);
  assert.strictEqual(create.calls[0][0].data.name, 'Buổi 5 - Lập trình Web');
});

test('không đặt khung giờ nào → tự động mở điểm danh ngay khi tạo', async () => {
  mockAuth();
  mockClass();
  const create = stubMethod(prisma.event, 'create', async ({ data }) => ({ id: 'evt-1', ...data }));
  stubMethod(prisma.classMember, 'findMany', async () => []);
  stubMethod(prisma.eventMember, 'createMany', async () => ({ count: 0 }));
  stubMethod(prisma.attendance, 'createMany', async () => ({ count: 0 }));
  stubMethod(prisma, '$transaction', async (ops) => Promise.all(ops));

  const res = await request(app).post('/api/classes/cls-1/sessions')
    .set('Authorization', `Bearer ${btcToken}`)
    .send({ location: 'Phòng A101', gpsEnabled: false }); // không gửi giờ nào

  assert.strictEqual(res.status, 201);
  const created = create.calls[0][0].data;
  assert.strictEqual(created.checkinOpen, null);
  assert.strictEqual(created.checkinClose, null);
  assert.strictEqual(created.checkinState, 'OPEN');
  // Không có lịch để suy ra ngày → dùng ngày tạo cho tên mặc định.
  assert.match(created.name, /SE1701 - Buổi điểm danh/);
  assert.strictEqual(res.body.data.gate.checkin.open, true);
});

test('có đặt khung giờ thì vẫn theo lịch (AUTO), không tự mở', async () => {
  mockAuth();
  mockClass();
  const create = stubMethod(prisma.event, 'create', async ({ data }) => ({ id: 'evt-1', ...data }));
  stubMethod(prisma.classMember, 'findMany', async () => []);
  stubMethod(prisma.eventMember, 'createMany', async () => ({ count: 0 }));
  stubMethod(prisma.attendance, 'createMany', async () => ({ count: 0 }));
  stubMethod(prisma, '$transaction', async (ops) => Promise.all(ops));

  const res = await request(app).post('/api/classes/cls-1/sessions')
    .set('Authorization', `Bearer ${btcToken}`)
    .send(sessionBody());

  assert.strictEqual(res.status, 201);
  assert.strictEqual(create.calls[0][0].data.checkinState, 'AUTO');
});

test('BTC truyền checkinState rõ ràng thì ưu tiên hơn suy luận mặc định', async () => {
  mockAuth();
  mockClass();
  const create = stubMethod(prisma.event, 'create', async ({ data }) => ({ id: 'evt-1', ...data }));
  stubMethod(prisma.classMember, 'findMany', async () => []);
  stubMethod(prisma.eventMember, 'createMany', async () => ({ count: 0 }));
  stubMethod(prisma.attendance, 'createMany', async () => ({ count: 0 }));
  stubMethod(prisma, '$transaction', async (ops) => Promise.all(ops));

  const res = await request(app).post('/api/classes/cls-1/sessions')
    .set('Authorization', `Bearer ${btcToken}`)
    .send(sessionBody({ checkinState: 'CLOSED' }));

  assert.strictEqual(res.status, 201);
  assert.strictEqual(create.calls[0][0].data.checkinState, 'CLOSED');
});

test('tạo buổi điểm danh bật GPS mà thiếu toạ độ bị chặn 400', async () => {
  mockAuth();
  mockClass();
  const create = stubMethod(prisma.event, 'create', async () => { throw new Error('không được gọi'); });

  const res = await request(app).post('/api/classes/cls-1/sessions')
    .set('Authorization', `Bearer ${btcToken}`)
    .send(sessionBody({ gpsEnabled: true }));

  assert.strictEqual(res.status, 400);
  assert.strictEqual(create.calls.length, 0);
});

test('tạo buổi điểm danh thiếu địa điểm hoặc sai giờ trả 400', async () => {
  mockAuth();
  mockClass();
  const create = stubMethod(prisma.event, 'create', async () => { throw new Error('không được gọi'); });

  for (const overrides of [{ location: '' }, { checkinOpen: 'not-a-date' }]) {
    const res = await request(app).post('/api/classes/cls-1/sessions')
      .set('Authorization', `Bearer ${btcToken}`).send(sessionBody(overrides));
    assert.strictEqual(res.status, 400, JSON.stringify(overrides));
  }
  assert.strictEqual(create.calls.length, 0);
});

test('danh sách buổi điểm danh chỉ lấy sự kiện thuộc lớp này', async () => {
  mockAuth();
  mockClass();
  const findMany = stubMethod(prisma.event, 'findMany', async () => []);

  await request(app).get('/api/classes/cls-1/sessions').set('Authorization', `Bearer ${btcToken}`);

  assert.deepStrictEqual(findMany.calls[0][0].where, { classId: 'cls-1' });
});
