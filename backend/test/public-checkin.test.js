const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const prisma = require('../src/lib/prisma');
const qrService = require('../src/services/qr.service');
const app = require('../src/app');
const {
  normalizeFields, validateSubmission, defaultPublicForm, canonicalPhone, readPublicForm,
} = require('../src/lib/publicForm');
const { buildPublicHtmlReport } = require('../src/services/htmlReport.service');
const { stubMethod, restoreStubs } = require('../testenv');

// Check-in công khai — docs/superpowers/specs/2026-10-16-public-checkin-design.md

const USERS = {
  'btc-1': { id: 'btc-1', mssv: null, email: 'btc@f.c', name: 'Trần BTC', role: 'BTC', isActive: true, isFirstLogin: false },
  // Người tham gia không đăng nhập (2026-11-07): người dùng không phải BTC giờ là nhân sự khác.
  'stu-1': { id: 'stu-1', mssv: 'SE1', email: 'se1@f.c', name: 'An', role: 'LECTURER', isActive: true, isFirstLogin: false },
};
const auth = (id) => `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET)}`;
const loginAs = () => stubMethod(prisma.user, 'findUnique', async ({ where }) => USERS[where.id] || null);

const FORM = {
  fields: [
    { id: 'f_phone', type: 'PHONE', label: 'Số điện thoại', required: true, unique: true },
    { id: 'f_mssv', type: 'TEXT', label: 'MSSV', required: false, unique: true },
    { id: 'f_email', type: 'EMAIL', label: 'Email', required: false, unique: false },
    { id: 'f_src', type: 'SINGLE', label: 'Biết qua', required: true, unique: false, options: ['Facebook', 'Bạn bè'] },
    { id: 'f_int', type: 'MULTI', label: 'Quan tâm', required: false, unique: false, options: ['AI', 'Thiết kế', 'Kinh doanh'] },
  ],
  thankYou: 'Mời bạn nhận quà ở quầy 2',
};
const EVENT = {
  id: 'evt-pub', name: 'Ngày hội tuyển sinh', location: 'Sảnh A', description: null, kind: 'PUBLIC', isActive: true,
  createdById: 'btc-1', publicForm: FORM, gpsEnabled: false, lat: 10.84, lng: 106.8, radius: 100,
  checkinState: 'OPEN', checkinOpen: null, checkinClose: null, checkoutState: 'AUTO', checkoutOpen: null, checkoutClose: null,
};
const stubEvent = (overrides = {}) => stubMethod(prisma.event, 'findUnique', async ({ where }) =>
  (where.id === EVENT.id ? { ...EVENT, ...overrides } : null));

const GOOD = {
  name: '  Lê   Hoa ',
  answers: { f_phone: '+84 912 345 678', f_mssv: ' SE12345 ', f_email: 'Hoa@Mail.com', f_src: 'Facebook', f_int: ['Kinh doanh', 'AI'], hack: 'x' },
};

afterEach(() => restoreStubs());

// ── Form ────────────────────────────────────────────────────────

test('normalizeFields: chống trùng chỉ cho chữ/SĐT/email; lựa chọn cần ≥ 2; giữ id hợp lệ', () => {
  const { value } = normalizeFields([
    { id: 'keep', type: 'text', label: '  Trường  ', unique: true },
    { type: 'SINGLE', label: 'Giới tính', unique: true, options: ['Nam', ' Nữ ', 'Nam', ''] },
  ]);
  assert.strictEqual(value[0].id, 'keep');
  assert.strictEqual(value[0].label, 'Trường');
  assert.strictEqual(value[0].unique, true);
  assert.strictEqual(value[1].unique, false);
  assert.deepStrictEqual(value[1].options, ['Nam', 'Nữ']);
  assert.match(value[1].id, /^f_[0-9a-f]{8}$/);

  assert.ok(normalizeFields([{ type: 'MULTI', label: 'X', options: ['A'] }]).error);
  assert.ok(normalizeFields([{ type: 'DATE', label: 'X' }]).error);
  assert.ok(normalizeFields([{ type: 'TEXT', label: ' ' }]).error);
  assert.deepStrictEqual(normalizeFields([]).value, []);
});

test('validateSubmission: chuẩn hoá giá trị, tạo khoá chống trùng, bỏ khoá lạ', () => {
  const { value } = validateSubmission(FORM, GOOD);
  assert.strictEqual(value.name, 'Lê Hoa');
  assert.strictEqual(value.phone, '0912345678');
  assert.strictEqual(value.email, null); // trường email không chống trùng → không ghi cột email
  assert.deepStrictEqual(value.answers, {
    f_phone: '0912345678', f_mssv: 'SE12345', f_email: 'hoa@mail.com', f_src: 'Facebook', f_int: ['AI', 'Kinh doanh'],
  });
  assert.deepStrictEqual(value.keys, ['f_phone:0912345678', 'f_mssv:se12345']);
  assert.strictEqual(canonicalPhone('+84 912.345.678'), '0912345678');
});

test('validateSubmission: báo đúng trường bị thiếu / sai', () => {
  assert.match(validateSubmission(FORM, { ...GOOD, name: 'A' }).error, /họ tên/);
  assert.match(validateSubmission(FORM, { ...GOOD, answers: { ...GOOD.answers, f_phone: '' } }).error, /Số điện thoại/);
  assert.match(validateSubmission(FORM, { ...GOOD, answers: { ...GOOD.answers, f_phone: 'abc' } }).error, /số điện thoại hợp lệ/);
  assert.match(validateSubmission(FORM, { ...GOOD, answers: { ...GOOD.answers, f_src: 'TikTok' } }).error, /Biết qua/);
  assert.match(validateSubmission(FORM, { ...GOOD, answers: { ...GOOD.answers, f_int: ['AI', 'Lạ'] } }).error, /Quan tâm/);
  assert.match(validateSubmission(FORM, { ...GOOD, answers: { ...GOOD.answers, f_email: 'x@' } }).error, /email/);
  // Trường không bắt buộc bỏ trống: không lưu, không tạo khoá.
  const { value } = validateSubmission(FORM, { name: 'Hoa', answers: { f_phone: '0912345678', f_src: 'Bạn bè' } });
  assert.deepStrictEqual(Object.keys(value.answers), ['f_phone', 'f_src']);
  assert.deepStrictEqual(value.keys, ['f_phone:0912345678']);
});

test('readPublicForm: sự kiện chưa có form → form mặc định (SĐT bắt buộc, chống trùng)', () => {
  assert.deepStrictEqual(readPublicForm({ publicForm: null }), defaultPublicForm());
});

// ── Tạo / sửa sự kiện ───────────────────────────────────────────

test('tạo sự kiện PUBLIC: không khung giờ → cổng OPEN; có khung giờ → AUTO; khoá check-out/đăng ký', async () => {
  loginAs();
  const create = stubMethod(prisma.event, 'create', async ({ data }) => ({ id: 'new', ...data }));
  const base = { kind: 'PUBLIC', name: 'Ngày hội', location: 'Sảnh', gpsEnabled: false, allowRegistration: true, checkoutOpen: '2026-10-20T09:00:00Z' };

  await request(app).post('/api/events').set('Authorization', auth('btc-1')).send(base);
  let data = create.calls[0][0].data;
  assert.strictEqual(data.kind, 'PUBLIC');
  assert.strictEqual(data.checkinState, 'OPEN');
  assert.strictEqual(data.checkoutOpen, null);
  assert.strictEqual(data.allowRegistration, false);
  assert.strictEqual(data.isWhitelisted, true);
  assert.deepStrictEqual(data.publicForm, defaultPublicForm());

  await request(app).post('/api/events').set('Authorization', auth('btc-1'))
    .send({ ...base, checkinOpen: '2026-10-20T01:00:00Z', checkinClose: '2026-10-20T10:00:00Z' });
  data = create.calls[1][0].data;
  assert.strictEqual(data.checkinState, 'AUTO');
  assert.strictEqual(data.checkinOpen.toISOString(), '2026-10-20T01:00:00.000Z');

  const half = await request(app).post('/api/events').set('Authorization', auth('btc-1')).send({ ...base, checkinOpen: '2026-10-20T01:00:00Z' });
  assert.strictEqual(half.status, 400);
  const reversed = await request(app).post('/api/events').set('Authorization', auth('btc-1'))
    .send({ ...base, checkinOpen: '2026-10-20T10:00:00Z', checkinClose: '2026-10-20T01:00:00Z' });
  assert.strictEqual(reversed.status, 400);
});

test('sửa sự kiện PUBLIC: tắt công tắc khung giờ xoá lịch; không mở được đăng ký/check-out', async () => {
  loginAs();
  stubEvent({ checkinOpen: new Date(), checkinClose: new Date(Date.now() + 3600e3), checkinState: 'AUTO' });
  const update = stubMethod(prisma.event, 'update', async ({ data }) => ({ ...EVENT, ...data }));
  const res = await request(app).put('/api/events/evt-pub').set('Authorization', auth('btc-1'))
    .send({ checkinOpen: null, checkinClose: null, checkinState: 'OPEN', allowRegistration: true, checkoutOpen: '2026-10-20T09:00:00Z' });
  assert.strictEqual(res.status, 200);
  const data = update.calls[0][0].data;
  assert.strictEqual(data.checkinOpen, null);
  assert.strictEqual(data.checkinClose, null);
  assert.strictEqual(data.checkinState, 'OPEN');
  assert.strictEqual(data.allowRegistration, undefined);
  assert.strictEqual(data.checkoutOpen, undefined);
});

test('API của kiểu tự quét bị chặn trên sự kiện PUBLIC; màn QR trả link cố định', async () => {
  loginAs();
  stubEvent();
  const qr = await request(app).get('/api/events/evt-pub/qr').set('Authorization', auth('btc-1'));
  assert.strictEqual(qr.status, 200);
  assert.match(qr.body.data.publicUrl, /\/check-in\/evt-pub$/);
  assert.strictEqual(qr.body.data.gate.open, true);

  const manual = await request(app).post('/api/events/evt-pub/manual-checkin').set('Authorization', auth('btc-1')).send({ identifier: 'SE1' });
  assert.strictEqual(manual.body.error, 'PUBLIC_EVENT');

  const self = await request(app).post('/api/checkin').set('Authorization', auth('stu-1'))
    .send({ eventId: 'evt-pub', token: qrService.generateToken('evt-pub', 'checkin'), type: 'checkin', deviceId: 'd' });
  assert.strictEqual(self.body.error, 'PUBLIC_EVENT');
});

// ── Trang công khai ─────────────────────────────────────────────

test('GET trang check-in: trả form, không lộ toạ độ; sự kiện không phải PUBLIC → 404', async () => {
  stubEvent({ gpsEnabled: true });
  const res = await request(app).get('/api/public/checkin/evt-pub');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.gpsEnabled, true);
  assert.strictEqual(res.body.data.event.lat, undefined);
  assert.strictEqual(JSON.stringify(res.body).includes('10.84'), false);
  assert.deepStrictEqual(res.body.data.uniqueLabels, ['Số điện thoại', 'MSSV']);
  assert.strictEqual(res.body.data.gate.open, true);

  restoreStubs();
  stubEvent({ kind: 'STANDARD' });
  assert.strictEqual((await request(app).get('/api/public/checkin/evt-pub')).status, 404);
});

test('check-in thành công: ghi khách + khoá chống trùng trong một transaction, trả lời cảm ơn', async () => {
  stubEvent();
  stubMethod(prisma.eventGuestKey, 'findFirst', async () => null);
  const created = [];
  stubMethod(prisma.eventGuest, 'create', ({ data }) => { created.push(data); return { op: 'guest' }; });
  stubMethod(prisma.eventGuestKey, 'createMany', ({ data }) => { created.push(data); return { op: 'keys' }; });
  const tx = stubMethod(prisma, '$transaction', async (ops) => ops);
  stubMethod(prisma.eventGuest, 'findUnique', async () => ({ name: 'Lê Hoa', checkedInAt: new Date() }));

  const res = await request(app).post('/api/public/checkin/evt-pub').send(GOOD);
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.data.thankYou, 'Mời bạn nhận quà ở quầy 2');
  assert.strictEqual(tx.calls[0][0].length, 2);
  const [guest, keys] = created;
  assert.strictEqual(guest.checkedInBy, 'Tự check-in');
  assert.strictEqual(guest.phone, '0912345678');
  assert.ok(guest.checkedInAt instanceof Date);
  assert.deepStrictEqual(keys.map((k) => k.key), ['f_phone:0912345678', 'f_mssv:se12345']);
  assert.ok(keys.every((k) => k.guestId === guest.id && k.eventId === 'evt-pub'));
});

test('trùng SĐT: 409 kèm giờ cũ nhưng KHÔNG lộ tên người đã check-in', async () => {
  stubEvent();
  stubMethod(prisma.eventGuestKey, 'findFirst', async () => ({ guest: { name: 'Người Khác', checkedInAt: new Date('2026-10-20T07:05:00Z') } }));
  const create = stubMethod(prisma.eventGuest, 'create', () => { throw new Error('không được tạo'); });
  const res = await request(app).post('/api/public/checkin/evt-pub').send(GOOD);
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error, 'ALREADY_CHECKED_IN');
  assert.match(res.body.message, /14:05/);
  assert.ok(!JSON.stringify(res.body).includes('Người Khác'));
  assert.strictEqual(create.calls.length, 0);
});

test('hai người gửi cùng SĐT cùng lúc: P2002 từ khoá unique → 409', async () => {
  stubEvent();
  let lookups = 0;
  stubMethod(prisma.eventGuestKey, 'findFirst', async () => (lookups++ === 0 ? null : { guest: { checkedInAt: new Date() } }));
  stubMethod(prisma.eventGuest, 'create', () => ({}));
  stubMethod(prisma.eventGuestKey, 'createMany', () => ({}));
  stubMethod(prisma, '$transaction', async () => { const e = new Error('unique'); e.code = 'P2002'; throw e; });
  const res = await request(app).post('/api/public/checkin/evt-pub').send(GOOD);
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error, 'ALREADY_CHECKED_IN');
});

test('cổng đóng / ngoài giờ → không ghi', async () => {
  stubEvent({ checkinState: 'CLOSED' });
  const closed = await request(app).post('/api/public/checkin/evt-pub').send(GOOD);
  assert.strictEqual(closed.body.error, 'ATTENDANCE_CLOSED');

  restoreStubs();
  stubEvent({ checkinState: 'AUTO', checkinOpen: new Date(Date.now() + 3600e3), checkinClose: new Date(Date.now() + 7200e3) });
  const early = await request(app).post('/api/public/checkin/evt-pub').send(GOOD);
  assert.strictEqual(early.body.error, 'OUTSIDE_TIME_WINDOW');
});

test('GPS bật: thiếu toạ độ → GPS_REQUIRED; ngoài bán kính → OUT_OF_RANGE + ghi log gian lận', async () => {
  stubEvent({ gpsEnabled: true });
  const missing = await request(app).post('/api/public/checkin/evt-pub').send(GOOD);
  assert.strictEqual(missing.body.error, 'GPS_REQUIRED');

  const fraud = stubMethod(prisma.fraudLog, 'create', async () => ({}));
  const far = await request(app).post('/api/public/checkin/evt-pub').set('X-Device-ID', 'dev-9')
    .send({ ...GOOD, gps: { lat: 10.9, lng: 106.8 } });
  assert.strictEqual(far.body.error, 'OUT_OF_RANGE');
  assert.strictEqual(fraud.calls[0][0].data.reason, 'GPS_OUT_OF_RANGE');
  assert.strictEqual(fraud.calls[0][0].data.deviceId, 'dev-9');
  assert.strictEqual(fraud.calls[0][0].data.eventId, 'evt-pub');
});

test('form sai → 400 INVALID_ANSWERS', async () => {
  stubEvent();
  const res = await request(app).post('/api/public/checkin/evt-pub').send({ ...GOOD, answers: { f_phone: '0912345678' } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'INVALID_ANSWERS');
  assert.match(res.body.message, /Biết qua/);
});

// ── BTC ─────────────────────────────────────────────────────────

test('lưu form: đã có người check-in thì khoá trường nhưng vẫn sửa được lời cảm ơn', async () => {
  loginAs();
  stubEvent();
  stubMethod(prisma.eventGuest, 'count', async () => 3);
  const update = stubMethod(prisma.event, 'update', async () => ({}));

  const changed = await request(app).put('/api/events/evt-pub/public-form').set('Authorization', auth('btc-1'))
    .send({ fields: FORM.fields.slice(1), thankYou: 'x' });
  assert.strictEqual(changed.status, 409);
  assert.strictEqual(changed.body.error, 'FORM_LOCKED');

  const thanks = await request(app).put('/api/events/evt-pub/public-form').set('Authorization', auth('btc-1'))
    .send({ fields: FORM.fields, thankYou: '  Cảm ơn!  ' });
  assert.strictEqual(thanks.status, 200);
  assert.strictEqual(update.calls[0][0].data.publicForm.thankYou, 'Cảm ơn!');
});

test('BTC thêm tay: bỏ qua cổng đóng và GPS, ghi tên BTC; trùng thì báo tên người trùng', async () => {
  loginAs();
  stubEvent({ checkinState: 'CLOSED', gpsEnabled: true });
  stubMethod(prisma.eventGuestKey, 'findFirst', async () => null);
  const created = [];
  stubMethod(prisma.eventGuest, 'create', ({ data }) => { created.push(data); return {}; });
  stubMethod(prisma.eventGuestKey, 'createMany', () => ({}));
  stubMethod(prisma, '$transaction', async (ops) => ops);
  stubMethod(prisma.eventGuest, 'findUnique', async () => ({ id: 'g', name: 'Lê Hoa', code: 'x'.repeat(20), checkedInAt: new Date() }));
  const ok = await request(app).post('/api/events/evt-pub/public-checkins').set('Authorization', auth('btc-1')).send(GOOD);
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(created[0].checkedInBy, 'Trần BTC');

  restoreStubs();
  loginAs();
  stubEvent();
  stubMethod(prisma.eventGuestKey, 'findFirst', async () => ({ guest: { name: 'Lê Hoa', checkedInAt: new Date() } }));
  const dup = await request(app).post('/api/events/evt-pub/public-checkins').set('Authorization', auth('btc-1')).send(GOOD);
  assert.strictEqual(dup.status, 409);
  assert.match(dup.body.message, /Lê Hoa/);
});

test('màn chiếu: /live của sự kiện PUBLIC đọc từ bảng khách, không có mẫu số đăng ký', async () => {
  loginAs();
  stubEvent();
  stubMethod(prisma.eventGuest, 'findMany', async () => [{ id: 'g1', name: 'Hoa', checkedInAt: new Date() }]);
  stubMethod(prisma.eventGuest, 'count', async () => 1);
  const res = await request(app).get('/api/events/evt-pub/live').set('Authorization', auth('btc-1'));
  assert.strictEqual(res.body.data.checkedIn, 1);
  assert.strictEqual(res.body.data.registered, 0);
  assert.strictEqual(res.body.data.recent[0].name, 'Hoa');
});

test('báo cáo HTML: cột theo form, chọn nhiều nối bằng dấu phẩy, biểu đồ theo giờ VN, escape', () => {
  const html = buildPublicHtmlReport(EVENT, [
    { name: '<b>Hoa</b>', checkedInAt: new Date('2026-10-20T07:30:00Z'), answers: { f_int: ['AI', 'Kinh doanh'], f_phone: '0912' } },
    { name: 'Minh', checkedInAt: new Date('2026-10-20T07:45:00Z'), answers: {} },
  ], FORM);
  assert.ok(html.includes('<th>Quan tâm</th>'));
  assert.ok(html.includes('AI, Kinh doanh'));
  assert.ok(html.includes('20/10 14:00'));
  assert.ok(!html.includes('<b>Hoa</b>'));
  assert.match(html, /Người đã check-in <span class="badge green">2 người/);
});

test('xuất Excel sự kiện PUBLIC dùng danh sách khách', async () => {
  loginAs();
  stubEvent();
  stubMethod(prisma.eventGuest, 'findMany', async () => [{ name: 'Hoa', checkedInAt: new Date(), answers: { f_phone: '0912' } }]);
  stubMethod(prisma.attendance, 'findMany', async () => { throw new Error('không được đọc bảng điểm danh'); });
  const res = await request(app).get('/api/reports/events/evt-pub/export').set('Authorization', auth('btc-1'));
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-disposition'], /checkin-/);
});
