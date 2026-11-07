const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const prisma = require('../src/lib/prisma');
const emailService = require('../src/services/email.service');
const app = require('../src/app');
const { stubMethod, restoreStubs } = require('../testenv');

const HOUR = 3600e3;

function mockEvent(overrides = {}) {
  const base = {
    id: 'evt-1',
    name: 'Workshop AI',
    description: null,
    location: 'Hội trường A1',
    checkinOpen: new Date(Date.now() + HOUR),
    checkinClose: new Date(Date.now() + 3 * HOUR),
    checkoutOpen: new Date(Date.now() + 3 * HOUR),
    checkoutClose: new Date(Date.now() + 4 * HOUR),
    isWhitelisted: false,
    allowRegistration: true,
    lat: 10.8, lng: 106.7, radius: 100,
    createdBy: { name: 'Ban tổ chức' },
    _count: { eventMembers: 12 },
  };
  // Mô phỏng `select` của Prisma: chỉ trả về đúng các cột được yêu cầu, nhờ đó
  // test chứng minh được endpoint công khai thật sự không trả lat/lng ra ngoài.
  return stubMethod(prisma.event, 'findFirst', async (args = {}) => {
    const row = { ...base, ...overrides };
    if (!args.select) return row;
    return Object.fromEntries(
      Object.keys(args.select).filter((k) => k in row).map((k) => [k, row[k]])
    );
  });
}

// createMany.count = 0 → đã là thành viên từ trước.
function mockJoin({ memberCount = 1 } = {}) {
  const createMany = stubMethod(prisma.eventMember, 'createMany', async () => ({ count: memberCount }));
  const attendance = stubMethod(prisma.attendance, 'createMany', async () => ({ count: memberCount }));
  stubMethod(prisma, '$transaction', async (ops) => Promise.all(ops));
  return { createMany, attendance };
}

function mockEmailOk() {
  return stubMethod(emailService, 'sendEventRegistrationEmail', async () => {});
}

function form(overrides = {}) {
  return { name: 'Nguyễn Văn A', mssv: 'SE170001', email: 'a@fpt.edu.vn', ...overrides };
}

const post = (body) => request(app).post('/api/public/events/evt-1/register').send(form(body));

afterEach(() => restoreStubs());

// Người tham gia dùng chung theo email, không có tài khoản (lib/participants.js).
// findMany lần 1 (where.OR) = tra người đã có; lần 2 = lấy lại người vừa createMany.
function mockPeople({ existing = [] } = {}) {
  const created = [];
  const createMany = stubMethod(prisma.user, 'createMany', async ({ data }) => {
    data.forEach((d) => created.push({ id: `new-${created.length + 1}`, ...d }));
    return { count: data.length };
  });
  stubMethod(prisma.user, 'findMany', async ({ where }) => (where.OR ? existing : created));
  const update = stubMethod(prisma.user, 'update', async ({ data }) => data);
  return { createMany, update };
}

// ── Người mới ──────────────────────────────────────────────────

test('người mới được thêm vào danh sách mà KHÔNG tạo mật khẩu đăng nhập', async () => {
  mockEvent();
  const { createMany: createUsers } = mockPeople();
  const { createMany } = mockJoin();
  const mail = mockEmailOk();

  const res = await post({ email: ' A@FPT.edu.vn ', mssv: 'se170001' });

  assert.strictEqual(res.status, 201);
  const [person] = createUsers.calls[0][0].data;
  assert.strictEqual(person.email, 'a@fpt.edu.vn');
  assert.strictEqual(person.mssv, 'SE170001');
  assert.strictEqual(person.role, 'STUDENT');
  assert.strictEqual(person.passwordHash, '!');
  assert.strictEqual(createMany.calls[0][0].data[0].userId, 'new-1');
  // Email xác nhận không còn tham số tài khoản/mật khẩu.
  assert.strictEqual(mail.calls[0].length, 3);
  assert.strictEqual(res.body.isNewAccount, undefined);
  assert.strictEqual(JSON.stringify(res.body).includes('assword'), false);
});

test('gửi email lỗi vẫn giữ đăng ký, chỉ báo emailSent=false', async () => {
  mockEvent();
  mockPeople();
  mockJoin();
  stubMethod(emailService, 'sendEventRegistrationEmail', async () => { throw new Error('brevo down'); });

  const res = await post();

  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.emailSent, false);
});

// ── Người đã có ────────────────────────────────────────────────

test('email đã có thì dùng lại người đó, chỉ bổ sung MSSV còn trống, không đổi tên', async () => {
  mockEvent();
  const { createMany: createUsers, update } = mockPeople({
    existing: [{ id: 'u-1', email: 'a@fpt.edu.vn', mssv: null, phone: null, isActive: true }],
  });
  const { createMany } = mockJoin();
  mockEmailOk();

  const res = await post({ name: 'Tên Khác Hẳn' });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(createUsers.calls.length, 0);
  assert.strictEqual(createMany.calls[0][0].data[0].userId, 'u-1');
  assert.deepStrictEqual(update.calls[0][0].data, { mssv: 'SE170001' });
});

test('đăng ký lại sự kiện đã tham gia trả về alreadyRegistered, không gửi email', async () => {
  mockEvent();
  mockPeople({ existing: [{ id: 'u-1', email: 'a@fpt.edu.vn', mssv: 'SE170001', phone: null, isActive: true }] });
  mockJoin({ memberCount: 0 });
  const mail = mockEmailOk();

  const res = await post();

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.alreadyRegistered, true);
  assert.strictEqual(mail.calls.length, 0);
});

test('MSSV đã gắn với email khác bị chặn 409', async () => {
  mockEvent();
  mockPeople({ existing: [{ id: 'u-2', email: 'khac@fpt.edu.vn', mssv: 'SE170001', phone: null, isActive: true }] });
  const { createMany } = mockJoin();

  const res = await post();

  assert.strictEqual(res.status, 409);
  assert.match(res.body.message, /MSSV SE170001/);
  assert.strictEqual(createMany.calls.length, 0);
});

test('người đã bị khoá không đăng ký được', async () => {
  mockEvent();
  mockPeople({ existing: [{ id: 'u-1', email: 'a@fpt.edu.vn', mssv: 'SE170001', phone: null, isActive: false }] });
  const { createMany } = mockJoin();

  const res = await post();

  assert.strictEqual(res.status, 409);
  assert.strictEqual(createMany.calls.length, 0);
});

test('thiếu hoặc sai thông tin bắt buộc trả 400 và không đụng tới DB', async () => {
  for (const body of [{ name: '' }, { name: 'A' }, { mssv: '' }, { email: 'khong-phai-email' }]) {
    mockEvent();
    stubMethod(prisma.user, 'findMany', async () => { throw new Error('không được truy vấn user'); });
    const { createMany } = mockJoin();

    const res = await post(body);

    assert.strictEqual(res.status, 400, `body=${JSON.stringify(body)}`);
    assert.strictEqual(createMany.calls.length, 0);
    restoreStubs();
  }
});

test('sự kiện tắt cho phép đăng ký trả 400', async () => {
  mockEvent({ allowRegistration: false });
  const { createMany } = mockJoin();

  const res = await post();

  assert.strictEqual(res.status, 400);
  assert.strictEqual(createMany.calls.length, 0);
});

test('sự kiện đã đóng cổng check-in không nhận đăng ký', async () => {
  mockEvent({
    checkinOpen: new Date(Date.now() - 3 * HOUR),
    checkinClose: new Date(Date.now() - HOUR),
  });
  const { createMany } = mockJoin();

  const res = await post();

  assert.strictEqual(res.status, 400);
  assert.strictEqual(createMany.calls.length, 0);
});

test('sự kiện không tồn tại trả 404', async () => {
  stubMethod(prisma.event, 'findFirst', async () => null);
  const { createMany } = mockJoin();

  const res = await post();

  assert.strictEqual(res.status, 404);
  assert.strictEqual(createMany.calls.length, 0);
});

// ── Endpoint công khai đọc sự kiện ─────────────────────────────

test('chi tiết sự kiện công khai không lộ toạ độ geofence', async () => {
  const findFirst = mockEvent();
  const res = await request(app).get('/api/public/events/evt-1');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.name, 'Workshop AI');
  assert.strictEqual(res.body.data.registrationClosed, false);
  // Toạ độ không nằm trong select nên không thể lọt ra ngoài.
  const selected = findFirst.calls[0][0].select;
  for (const field of ['lat', 'lng', 'radius']) {
    assert.ok(!(field in selected), `${field} không được select`);
  }
  assert.strictEqual(res.body.data.lat, undefined);
});

test('danh sách công khai chỉ lấy sự kiện đang mở đăng ký và chưa đóng cổng', async () => {
  const findMany = stubMethod(prisma.event, 'findMany', async () => []);
  const res = await request(app).get('/api/public/events');

  assert.strictEqual(res.status, 200);
  const where = findMany.calls[0][0].where;
  assert.strictEqual(where.isActive, true);
  assert.strictEqual(where.allowRegistration, true);
  // checkinClose là tuỳ chọn — sự kiện chưa đặt hạn (null) vẫn phải được liệt kê.
  assert.deepStrictEqual(where.OR[0], { checkinClose: null });
  assert.ok(where.OR[1].checkinClose.gte instanceof Date);
});

test('sự kiện không đặt hạn đăng ký (checkinClose null) vẫn coi là đang mở', async () => {
  mockEvent({ checkinClose: null, allowRegistration: true });
  mockPeople();
  const { createMany } = mockJoin();
  mockEmailOk();

  const res = await post();

  assert.strictEqual(res.status, 201);
  assert.strictEqual(createMany.calls.length, 1);
});

// ── Tự đăng ký bằng tài khoản đã bỏ (người tham gia không đăng nhập) ──────

test('đường tự đăng ký bằng tài khoản không còn', async () => {
  const res = await request(app).post('/api/events/evt-1/register').send({});
  assert.notStrictEqual(res.status, 200);
});
