const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const { PDFDocument } = require('pdf-lib');
const { unzipSync } = require('fflate');
const prisma = require('../src/lib/prisma');
const qrService = require('../src/services/qr.service');
const emailService = require('../src/services/email.service');
const app = require('../src/app');
const {
  normalizeFields, withAllFields, invitationFieldText, extractGuestCode, generateGuestCode, invitationUrl, qrMatrix, layoutQr, invitationValues,
  invitationFileNames,
} = require('../src/lib/invitationLayout');
const { normalizeGuestInput, maskPhone, maskEmail } = require('../src/lib/guestCheckin');
const { renderInvitationsPdf, wrapText } = require('../src/services/invitationPdf');
const { deliverInvitations } = require('../src/controllers/guest.controller');
const { buildGuestHtmlReport } = require('../src/services/htmlReport.service');
const { stubMethod, restoreStubs } = require('../testenv');

// Sự kiện thiệp mời — docs/superpowers/specs/2026-10-16-invitation-event-design.md

const USERS = {
  'btc-1': { id: 'btc-1', mssv: null, email: 'btc@f.c', name: 'Trần BTC', role: 'BTC', isActive: true, isFirstLogin: false },
  'btc-2': { id: 'btc-2', mssv: null, email: 'btc2@f.c', name: 'BTC 2', role: 'BTC', isActive: true, isFirstLogin: false },
  // Người tham gia không đăng nhập (2026-11-07): người dùng không phải BTC giờ là nhân sự khác.
  'stu-1': { id: 'stu-1', mssv: 'SE1', email: 'se1@f.c', name: 'An', role: 'LECTURER', isActive: true, isFirstLogin: false },
};
const auth = (id) => `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET)}`;
const loginAs = () => stubMethod(prisma.user, 'findUnique', async ({ where }) => USERS[where.id] || null);

const SCANNER_TOKEN = 'scanner-token-abcdefghijklmnop';
const EVENT = {
  id: 'evt-1', name: 'Gala Doanh nghiệp', location: 'Hội trường A', kind: 'INVITATION', isActive: true,
  createdById: 'btc-1', startsAt: new Date('2026-10-20T07:30:00Z'), scannerToken: SCANNER_TOKEN,
};
const stubEvent = (overrides = {}) => stubMethod(prisma.event, 'findUnique', async ({ where }) => {
  const ev = { ...EVENT, ...overrides };
  if (where.scannerToken !== undefined) return where.scannerToken === ev.scannerToken ? ev : null;
  return where.id === ev.id ? ev : null;
});

const CODE = generateGuestCode();
const guest = (overrides = {}) => ({
  id: 'g-1', eventId: 'evt-1', name: 'Lê Thị Hoa', phone: '0912345678', email: 'hoa@corp.vn', code: CODE,
  isWalkIn: false, inviteStatus: 'PENDING', inviteSentAt: null, checkedInAt: null, checkedInBy: null,
  createdAt: new Date(), ...overrides,
});

afterEach(() => restoreStubs());

// ── Bố cục / mã ─────────────────────────────────────────────────

test('normalizeFields: đủ 7 ô, ô tên và ô QR luôn bật, QR chỉ giữ x/y/size và bị kẹp', () => {
  const { value } = normalizeFields([
    { key: 'name', enabled: false },
    { key: 'qr', enabled: false, x: 2, y: -1, size: 9, font: 'script' },
    { key: 'location', enabled: false },
  ]);
  assert.deepStrictEqual(value.map((f) => f.key), ['name', 'event', 'time', 'location', 'seat', 'tickets', 'qr']);
  assert.strictEqual(value[0].enabled, true);
  assert.strictEqual(value[3].enabled, false);
  assert.strictEqual(value[4].enabled, true); // mẫu cũ chưa có ô ghế → nhận ô mặc định
  assert.deepStrictEqual(value[6], { key: 'qr', enabled: true, x: 1, y: 0, size: 0.6, background: false });
  const withBg = normalizeFields([{ key: 'qr', x: 0.5, y: 0.5, size: 0.3, background: true }]).value[6];
  assert.strictEqual(withBg.background, true);
  assert.ok(normalizeFields(null).error);
});

test('withAllFields: mẫu cũ chưa có ô số vé → đặt ngay dưới ô ghế, cùng kiểu chữ', () => {
  const seat = { key: 'seat', enabled: true, x: 0.3, y: 0.5, size: 0.02, maxWidth: 0.4, font: 'playfair', color: '#B91C1C', align: 'left', uppercase: true, bare: false };
  const { fields } = withAllFields({ width: 1000, height: 2000, fields: [seat] });
  const tickets = fields.find((f) => f.key === 'tickets');
  assert.deepStrictEqual({ ...tickets, y: undefined }, { ...seat, key: 'tickets', y: undefined });
  assert.ok(Math.abs(tickets.y - (0.5 + 0.02 * 0.5 * 1.4)) < 1e-9);

  // Mẫu đã có ô số vé thì giữ nguyên chỗ BTC đặt.
  const saved = withAllFields({ width: 1000, height: 2000, fields: [seat, { ...seat, key: 'tickets', x: 0.7, y: 0.9 }] });
  assert.strictEqual(saved.fields.find((f) => f.key === 'tickets').y, 0.9);
});

test('invitationFieldText: in hoa, ô ghế/số vé bỏ nhãn thì in giá trị trần', () => {
  const values = invitationValues({ name: 'Trần Thị Đào', ticketCount: 1, seats: [{ seat: 'E08' }] }, EVENT);
  assert.strictEqual(invitationFieldText({ key: 'name', uppercase: true }, values), 'TRẦN THỊ ĐÀO');
  assert.strictEqual(invitationFieldText({ key: 'seat', uppercase: true }, values), 'GHẾ E08');
  assert.strictEqual(invitationFieldText({ key: 'seat', bare: true }, values), 'E08');
  // 1 vé: ô có nhãn để trống (thiệp như cũ), ô trần vẫn in "1" vì mẫu đã có nhãn "SỐ VÉ".
  assert.strictEqual(invitationFieldText({ key: 'tickets' }, values), '');
  assert.strictEqual(invitationFieldText({ key: 'tickets', bare: true }, values), '1');
  // bare chỉ có nghĩa với ô ghế/số vé.
  assert.strictEqual(invitationFieldText({ key: 'name', bare: true }, values), 'Trần Thị Đào');

  const { value } = normalizeFields([{ key: 'name', bare: true, uppercase: 'yes' }, { key: 'seat', bare: true, uppercase: true }]);
  assert.deepStrictEqual([value[0].uppercase, 'bare' in value[0]], [false, false]);
  assert.deepStrictEqual([value[4].uppercase, value[4].bare, value[5].bare], [true, true, false]);
});

test('extractGuestCode: nhận link /thiep/<mã> ở mọi tên miền và mã thô; từ chối nội dung lạ', () => {
  assert.strictEqual(extractGuestCode(`https://fpt-event.vercel.app/thiep/${CODE}`), CODE);
  assert.strictEqual(extractGuestCode(`http://localhost:5173/thiep/${CODE}?x=1`), CODE);
  assert.strictEqual(extractGuestCode(`  ${CODE}  `), CODE);
  assert.strictEqual(extractGuestCode('https://example.com'), null);
  assert.strictEqual(extractGuestCode('/scan?e=evt-1&t=abc&type=checkin'), null);
  assert.strictEqual(extractGuestCode(undefined), null);
  assert.match(generateGuestCode(), /^[A-Za-z0-9_-]{20}$/);
});

test('layoutQr: x, y là tâm ô vuông, cạnh theo chiều rộng', () => {
  assert.deepStrictEqual(layoutQr({ x: 0.5, y: 0.5, size: 0.2 }, 1000, 600), { left: 400, top: 200, side: 200 });
  const m = qrMatrix(invitationUrl(CODE));
  assert.ok(m.size >= 21);
  assert.strictEqual(typeof m.dark(0, 0), 'boolean');
});

test('invitationValues: giờ in theo giờ VN dù server chạy UTC', () => {
  const v = invitationValues({ name: 'Hoa' }, EVENT);
  assert.strictEqual(v.time, '14:30 · Thứ Ba, 20/10/2026');
  assert.strictEqual(v.location, 'Hội trường A');
});

test('normalizeGuestInput: chuẩn hoá SĐT/email, bắt buộc họ tên', () => {
  assert.deepStrictEqual(normalizeGuestInput({ name: '  Lê   Hoa ', phone: '091 234.56-78', email: ' HOA@Corp.VN ' }).value,
    { name: 'Lê Hoa', phone: '0912345678', email: 'hoa@corp.vn' });
  assert.deepStrictEqual(normalizeGuestInput({ name: 'Hoa' }).value, { name: 'Hoa', phone: null, email: null });
  assert.ok(normalizeGuestInput({ name: '' }).error);
  assert.ok(normalizeGuestInput({ name: 'Hoa', phone: 'abc' }).error);
  assert.ok(normalizeGuestInput({ name: 'Hoa', email: 'x@' }).error);
  assert.strictEqual(maskPhone('0912345678'), '091••••678');
  assert.strictEqual(maskEmail('hoa@corp.vn'), 'ho•••@corp.vn');
});

test('wrapText: ngắt theo từ và cắt "…" khi quá số dòng', () => {
  const font = { widthOfTextAtSize: (t) => t.length };
  assert.deepStrictEqual(wrapText('một hai ba bốn', font, 1, 7, 3), ['một hai', 'ba bốn']);
  assert.deepStrictEqual(wrapText('aaaa bbbb cccc dddd', font, 1, 4, 2), ['aaaa', 'bbb…']);
  assert.deepStrictEqual(wrapText('abcdefgh', font, 1, 3, 3), ['abc', 'def', 'gh']);
});

// ── PDF ─────────────────────────────────────────────────────────

test('renderInvitationsPdf: thiệp mặc định, mỗi khách một trang A5', async () => {
  const items = ['A', 'B', 'C'].map((name) => ({ values: invitationValues({ name }, EVENT), qrText: invitationUrl(CODE) }));
  const doc = await PDFDocument.load(await renderInvitationsPdf(null, items, { title: 't' }));
  assert.strictEqual(doc.getPageCount(), 3);
  const { width, height } = doc.getPage(0).getSize();
  assert.deepStrictEqual([width, height], [420, 595]);
});

// ── Tạo / sửa sự kiện ───────────────────────────────────────────

test('tạo sự kiện thiệp mời: bắt buộc giờ bắt đầu, khoá các trường của kiểu tự quét', async () => {
  loginAs();
  const create = stubMethod(prisma.event, 'create', async ({ data }) => ({ id: 'new', ...data }));

  const missing = await request(app).post('/api/events').set('Authorization', auth('btc-1'))
    .send({ kind: 'INVITATION', name: 'Gala', location: 'A' });
  assert.strictEqual(missing.status, 400);

  const res = await request(app).post('/api/events').set('Authorization', auth('btc-1')).send({
    kind: 'INVITATION', name: ' Gala ', location: 'A', startsAt: '2026-10-20T07:30:00Z',
    gpsEnabled: true, lat: 10, lng: 106, allowRegistration: true, isWhitelisted: false, checkinOpen: '2026-10-20T07:00:00Z',
  });
  assert.strictEqual(res.status, 201);
  const data = create.calls[0][0].data;
  assert.strictEqual(data.kind, 'INVITATION');
  assert.strictEqual(data.name, 'Gala');
  assert.strictEqual(data.gpsEnabled, false);
  assert.strictEqual(data.lat, null);
  assert.strictEqual(data.allowRegistration, false);
  assert.strictEqual(data.isWhitelisted, true);
  assert.strictEqual(data.checkinOpen, null);
  assert.strictEqual(data.startsAt.toISOString(), '2026-10-20T07:30:00.000Z');
});

test('sửa sự kiện thiệp mời: chỉ đổi thông tin in thiệp, không mở được GPS/đăng ký', async () => {
  loginAs();
  stubEvent();
  const update = stubMethod(prisma.event, 'update', async ({ data }) => ({ ...EVENT, ...data }));
  const res = await request(app).put('/api/events/evt-1').set('Authorization', auth('btc-1'))
    .send({ name: 'Gala mới', gpsEnabled: true, allowRegistration: true, kind: 'STANDARD', startsAt: '2026-10-21T01:00:00Z' });
  assert.strictEqual(res.status, 200);
  const data = update.calls[0][0].data;
  assert.strictEqual(data.name, 'Gala mới');
  assert.strictEqual(data.gpsEnabled, false);
  assert.strictEqual(data.allowRegistration, false);
  assert.strictEqual(data.kind, undefined);
  assert.strictEqual(data.startsAt.toISOString(), '2026-10-21T01:00:00.000Z');
});

test('chức năng của kiểu tự quét bị chặn trên sự kiện thiệp mời', async () => {
  loginAs();
  stubEvent();
  const qr = await request(app).get('/api/events/evt-1/qr').set('Authorization', auth('btc-1'));
  assert.strictEqual(qr.status, 400);
  assert.strictEqual(qr.body.error, 'INVITATION_EVENT');

  const manual = await request(app).post('/api/events/evt-1/manual-checkin').set('Authorization', auth('btc-1'))
    .send({ identifier: 'SE1', type: 'checkin' });
  assert.strictEqual(manual.body.error, 'INVITATION_EVENT');

  const self = await request(app).post('/api/checkin').set('Authorization', auth('stu-1')).send({
    eventId: 'evt-1', token: qrService.generateToken('evt-1', 'checkin'), type: 'checkin', deviceId: 'd',
  });
  assert.strictEqual(self.status, 400);
  assert.strictEqual(self.body.error, 'INVITATION_EVENT');
});

// ── Quyền ───────────────────────────────────────────────────────

test('API khách mời: chỉ ADMIN/người tạo, và chỉ trên sự kiện thiệp mời', async () => {
  loginAs();
  stubEvent();
  const other = await request(app).get('/api/events/evt-1/guests').set('Authorization', auth('btc-2'));
  assert.strictEqual(other.status, 403);
  const student = await request(app).get('/api/events/evt-1/guests').set('Authorization', auth('stu-1'));
  assert.strictEqual(student.status, 403);

  restoreStubs();
  loginAs();
  stubEvent({ kind: 'STANDARD' });
  const standard = await request(app).get('/api/events/evt-1/guests').set('Authorization', auth('btc-1'));
  assert.strictEqual(standard.status, 400);
  assert.strictEqual(standard.body.error, 'NOT_INVITATION_EVENT');
});

// ── Danh sách khách ─────────────────────────────────────────────

test('thêm khách: sinh mã, chặn trùng email/SĐT trong sự kiện', async () => {
  loginAs();
  stubEvent();
  stubMethod(prisma.eventGuest, 'findFirst', async ({ where }) =>
    (where.OR.some((c) => c.email === 'hoa@corp.vn') ? guest() : null));
  const create = stubMethod(prisma.eventGuest, 'create', async ({ data }) => guest(data));
  stubMethod(prisma, '$transaction', async (ops) => Promise.all(ops));
  stubMethod(prisma.eventGuest, 'findUnique', async ({ where }) => guest({ ...create.calls.at(-1)[0].data, id: where.id }));

  const dup = await request(app).post('/api/events/evt-1/guests').set('Authorization', auth('btc-1'))
    .send({ name: 'Hoa 2', email: 'HOA@corp.vn' });
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(dup.body.error, 'DUPLICATE_GUEST');

  const ok = await request(app).post('/api/events/evt-1/guests').set('Authorization', auth('btc-1'))
    .send({ name: 'Phạm Minh', phone: '0987 654 321' });
  assert.strictEqual(ok.status, 201);
  const data = create.calls[0][0].data;
  assert.strictEqual(data.phone, '0987654321');
  assert.strictEqual(data.email, null);
  assert.match(data.code, /^[A-Za-z0-9_-]{20}$/);
  assert.match(ok.body.data.inviteUrl, /\/thiep\/[A-Za-z0-9_-]{20}$/);
});

test('import Excel: nhận tiêu đề tiếng Việt, bỏ dòng lỗi/trùng (cả trùng trong file)', async () => {
  loginAs();
  stubEvent();
  stubMethod(prisma.eventGuest, 'findMany', async () => [{ email: 'old@corp.vn', phone: null }]);
  stubMethod(prisma.eventGuestSeat, 'findMany', async () => []);
  stubMethod(prisma, '$transaction', async (ops) => Promise.all(ops));
  const createMany = stubMethod(prisma.eventGuest, 'createMany', async ({ data }) => ({ count: data.length }));

  const sheet = XLSX.utils.aoa_to_sheet([
    ['Họ và tên', 'Số điện thoại', 'E-mail'],
    ['Nguyễn An', '0901 111 222', 'an@corp.vn'],
    ['', '', ''],
    ['Khách Cũ', '', 'OLD@corp.vn'],
    ['A', '', ''],
    ['Trần Bình', '0901111222', ''],
    ['Lý Chi', '', ''],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'DS');
  const file = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const res = await request(app).post('/api/events/evt-1/guests/import').set('Authorization', auth('btc-1'))
    .attach('file', file, 'khach.xlsx');
  assert.strictEqual(res.status, 200);
  const created = createMany.calls[0][0].data;
  assert.deepStrictEqual(created.map((g) => g.name), ['Nguyễn An', 'Lý Chi']);
  assert.strictEqual(created[0].phone, '0901111222');
  assert.strictEqual(res.body.data.added, 2);
  assert.deepStrictEqual(res.body.data.skipped.map((s) => s.row), [4, 5, 6]);
});

test('import: file không có cột họ tên → 400', async () => {
  loginAs();
  stubEvent();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Foo', 'Bar'], ['1', '2']]), 'S');
  const res = await request(app).post('/api/events/evt-1/guests/import').set('Authorization', auth('btc-1'))
    .attach('file', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'x.xlsx');
  assert.strictEqual(res.status, 400);
});

test('đổi email khách → trạng thái gửi về chờ gửi; cấp lại mã đổi mã và chờ gửi lại', async () => {
  loginAs();
  stubEvent();
  stubMethod(prisma.eventGuest, 'findFirst', async ({ where }) => (where.id === 'g-1' ? guest({ inviteStatus: 'SENT' }) : null));
  const update = stubMethod(prisma.eventGuest, 'update', async ({ data }) => guest(data));
  stubMethod(prisma, '$transaction', async (ops) => Promise.all(ops));
  stubMethod(prisma.eventGuest, 'findUnique', async () => guest());

  await request(app).put('/api/events/evt-1/guests/g-1').set('Authorization', auth('btc-1'))
    .send({ name: 'Lê Thị Hoa', email: 'moi@corp.vn' });
  assert.strictEqual(update.calls[0][0].data.inviteStatus, 'PENDING');

  await request(app).post('/api/events/evt-1/guests/g-1/rotate-code').set('Authorization', auth('btc-1'));
  const data = update.calls[1][0].data;
  assert.notStrictEqual(data.code, CODE);
  assert.strictEqual(data.inviteStatus, 'PENDING');
});

// ── Quét thiệp ──────────────────────────────────────────────────

function stubGuestLookup(g) {
  stubMethod(prisma.eventGuest, 'findUnique', async ({ where }) => {
    if (where.code) return where.code === g.code ? g : null;
    return where.id === g.id ? g : null;
  });
}

test('quét thiệp: check-in thành công, ghi tên người quét', async () => {
  loginAs();
  stubEvent();
  stubGuestLookup(guest());
  const upd = stubMethod(prisma.eventGuest, 'updateMany', async () => ({ count: 1 }));

  const res = await request(app).post('/api/events/evt-1/guests/scan').set('Authorization', auth('btc-1'))
    .send({ code: invitationUrl(CODE) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.guest.name, 'Lê Thị Hoa');
  assert.strictEqual(res.body.guest.phone, '0912345678');
  assert.deepStrictEqual(upd.calls[0][0].where, { id: 'g-1', checkedInAt: null });
  assert.strictEqual(upd.calls[0][0].data.checkedInBy, 'Trần BTC');
});

test('quét thiệp: đã check-in → 409 kèm giờ; thiệp sự kiện khác; mã lạ; mã không tồn tại', async () => {
  loginAs();
  stubEvent();
  stubGuestLookup(guest({ checkedInAt: new Date('2026-10-20T07:05:00Z') }));
  const again = await request(app).post('/api/events/evt-1/guests/scan').set('Authorization', auth('btc-1')).send({ code: CODE });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.body.error, 'ALREADY_CHECKED_IN');
  assert.match(again.body.message, /14:05/);

  restoreStubs(); loginAs(); stubEvent();
  stubGuestLookup(guest({ eventId: 'evt-other' }));
  const wrong = await request(app).post('/api/events/evt-1/guests/scan').set('Authorization', auth('btc-1')).send({ code: CODE });
  assert.strictEqual(wrong.body.error, 'WRONG_EVENT');

  const junk = await request(app).post('/api/events/evt-1/guests/scan').set('Authorization', auth('btc-1')).send({ code: 'hello' });
  assert.strictEqual(junk.body.error, 'INVALID_CODE');

  const missing = await request(app).post('/api/events/evt-1/guests/scan').set('Authorization', auth('btc-1'))
    .send({ code: generateGuestCode() });
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.body.error, 'GUEST_NOT_FOUND');
});

test('hai cửa quét cùng một thiệp cùng lúc: bên thua nhận "đã check-in", giờ không bị ghi đè', async () => {
  loginAs();
  stubEvent();
  let reads = 0;
  stubMethod(prisma.eventGuest, 'findUnique', async () => (reads++ === 0 ? guest() : guest({ checkedInAt: new Date() })));
  stubMethod(prisma.eventGuest, 'updateMany', async () => ({ count: 0 }));
  const res = await request(app).post('/api/events/evt-1/guests/scan').set('Authorization', auth('btc-1')).send({ code: CODE });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error, 'ALREADY_CHECKED_IN');
});

test('khách tại chỗ: trùng SĐT với khách đã có → trả khách đó, không tạo mới', async () => {
  loginAs();
  stubEvent();
  stubMethod(prisma.eventGuest, 'findFirst', async () => guest());
  const create = stubMethod(prisma.eventGuest, 'create', async () => { throw new Error('không được tạo'); });
  const res = await request(app).post('/api/events/evt-1/guests/walk-in').set('Authorization', auth('btc-1'))
    .send({ name: 'Hoa', phone: '0912345678' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error, 'GUEST_EXISTS');
  assert.strictEqual(res.body.guest.id, 'g-1');
  assert.strictEqual(create.calls.length, 0);
});

test('khách tại chỗ mới: tạo kèm check-in luôn', async () => {
  loginAs();
  stubEvent();
  stubMethod(prisma.eventGuest, 'findFirst', async () => null);
  const create = stubMethod(prisma.eventGuest, 'create', async ({ data }) => guest({ ...data, id: 'g-w' }));
  const res = await request(app).post('/api/events/evt-1/guests/walk-in').set('Authorization', auth('btc-1'))
    .send({ name: 'Khách Mới' });
  assert.strictEqual(res.status, 201);
  const data = create.calls[0][0].data;
  assert.strictEqual(data.isWalkIn, true);
  assert.ok(data.checkedInAt instanceof Date);
  assert.strictEqual(data.checkedInBy, 'Trần BTC');
});

// ── Link quét cho tình nguyện viên ──────────────────────────────

test('link quét: token sai/đã thu hồi → 404 SCANNER_NOT_FOUND; sự kiện thường cũng 404', async () => {
  stubEvent();
  const bad = await request(app).get('/api/public/scanner/khong-ton-tai-0123456789');
  assert.strictEqual(bad.status, 404);
  assert.strictEqual(bad.body.error, 'SCANNER_NOT_FOUND');

  restoreStubs();
  stubEvent({ kind: 'STANDARD' });
  const standard = await request(app).get(`/api/public/scanner/${SCANNER_TOKEN}`);
  assert.strictEqual(standard.status, 404);
});

test('link quét: quét thành công trả khách đã che SĐT/email, ghi tên tình nguyện viên', async () => {
  stubEvent();
  stubGuestLookup(guest());
  const upd = stubMethod(prisma.eventGuest, 'updateMany', async () => ({ count: 1 }));
  const res = await request(app).post(`/api/public/scanner/${SCANNER_TOKEN}/scan`)
    .send({ code: invitationUrl(CODE), scannerName: '  Mai   Anh ' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.guest.phone, '091••••678');
  assert.strictEqual(res.body.guest.email, 'ho•••@corp.vn');
  assert.strictEqual(res.body.guest.inviteUrl, undefined);
  assert.strictEqual(upd.calls[0][0].data.checkedInBy, 'Mai Anh (link quét)');
});

test('link quét: tìm khách cần ít nhất 2 ký tự và trả bản che', async () => {
  stubEvent();
  const findMany = stubMethod(prisma.eventGuest, 'findMany', async () => [guest()]);
  const short = await request(app).get(`/api/public/scanner/${SCANNER_TOKEN}/guests`).query({ q: 'L' });
  assert.deepStrictEqual(short.body.data, []);
  assert.strictEqual(findMany.calls.length, 0);

  const res = await request(app).get(`/api/public/scanner/${SCANNER_TOKEN}/guests`).query({ q: 'Hoa' });
  assert.strictEqual(res.body.data[0].phone, '091••••678');
  assert.strictEqual(res.body.data[0].code, undefined);
});

test('link quét: BTC tạo link (giữ link cũ nếu đã có, ?rotate=1 cấp mới) và thu hồi', async () => {
  loginAs();
  stubEvent();
  const update = stubMethod(prisma.event, 'update', async ({ data }) => data);
  const keep = await request(app).post('/api/events/evt-1/scanner-link').set('Authorization', auth('btc-1'));
  assert.match(keep.body.data.url, new RegExp(`/quet/${SCANNER_TOKEN}$`));
  assert.strictEqual(update.calls.length, 0);

  const rotated = await request(app).post('/api/events/evt-1/scanner-link?rotate=1').set('Authorization', auth('btc-1'));
  assert.ok(!rotated.body.data.url.endsWith(SCANNER_TOKEN));

  const revoked = await request(app).delete('/api/events/evt-1/scanner-link').set('Authorization', auth('btc-1'));
  assert.strictEqual(revoked.body.data.shared, false);
});

// ── Trang thiệp của khách ───────────────────────────────────────

test('trang thiệp công khai: mã sai → 404; mã đúng trả nội dung thiệp, không lộ SĐT/email', async () => {
  stubMethod(prisma.eventGuest, 'findUnique', async ({ where }) => (where.code === CODE ? { ...guest(), event: EVENT } : null));
  stubMethod(prisma.eventInvitationTemplate, 'findUnique', async () => null);
  const bad = await request(app).get(`/api/public/invitations/${generateGuestCode()}`);
  assert.strictEqual(bad.status, 404);
  assert.strictEqual(bad.body.error, 'INVITATION_NOT_FOUND');

  const ok = await request(app).get(`/api/public/invitations/${CODE}`);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.data.guest.name, 'Lê Thị Hoa');
  assert.strictEqual(ok.body.data.guest.phone, undefined);
  assert.strictEqual(ok.body.data.qrText, invitationUrl(CODE));

  const pdf = await request(app).get(`/api/public/invitations/${CODE}/pdf`).buffer(true)
    .parse((r, cb) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });
  assert.strictEqual(pdf.headers['content-type'], 'application/pdf');
  assert.strictEqual((await PDFDocument.load(pdf.body)).getPageCount(), 1);
});

// ── Xuất từng thiệp riêng ───────────────────────────────────────

const readBinary = (r, cb) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); };

test('invitationFileNames: giữ dấu tiếng Việt, bỏ ký tự cấm, trùng tên (kể cả khác hoa thường) thì đánh số', () => {
  assert.deepStrictEqual(
    invitationFileNames(['Nguyễn Văn A', 'nguyễn văn a', 'a\\b/c:d?', '  ...', 'Trần B. ', 'Nguyễn Văn A']),
    ['Nguyễn Văn A', 'nguyễn văn a (2)', 'a b c d', 'Khach moi', 'Trần B', 'Nguyễn Văn A (3)'],
  );
});

test('xuất ZIP: mỗi khách (trừ khách tại chỗ) một file PDF một trang, tên file theo tên khách', async () => {
  loginAs();
  stubEvent();
  stubMethod(prisma.eventInvitationTemplate, 'findUnique', async () => null);
  const findMany = stubMethod(prisma.eventGuest, 'findMany', async () => [
    guest({ id: 'g-1', name: 'Lê Thị Hoa' }),
    guest({ id: 'g-2', name: 'Lê Thị Hoa', code: generateGuestCode() }),
    guest({ id: 'g-3', name: 'Phạm Minh', code: generateGuestCode() }),
  ]);
  const res = await request(app).get('/api/events/evt-1/invitations/zip').set('Authorization', auth('btc-1'))
    .buffer(true).parse(readBinary);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['content-type'], 'application/zip');
  assert.match(res.headers['content-disposition'], /^attachment; filename="thiep-moi-Gala_Doanh_nghiep\.zip"/);
  assert.deepStrictEqual(findMany.calls[0][0].where, { eventId: 'evt-1', isWalkIn: false });

  const files = unzipSync(new Uint8Array(res.body));
  assert.deepStrictEqual(Object.keys(files), ['Lê Thị Hoa.pdf', 'Lê Thị Hoa (2).pdf', 'Phạm Minh.pdf']);
  for (const bytes of Object.values(files)) assert.strictEqual((await PDFDocument.load(bytes)).getPageCount(), 1);
});

test('xuất ZIP: chưa có khách → 400 NO_GUESTS; BTC khác không xuất được', async () => {
  loginAs();
  stubEvent();
  stubMethod(prisma.eventGuest, 'findMany', async () => []);
  const empty = await request(app).get('/api/events/evt-1/invitations/zip').set('Authorization', auth('btc-1'));
  assert.strictEqual(empty.status, 400);
  assert.strictEqual(empty.body.error, 'NO_GUESTS');
  const other = await request(app).get('/api/events/evt-1/invitations/zip').set('Authorization', auth('btc-2'));
  assert.strictEqual(other.status, 403);
});

test('dữ liệu vẽ PNG: chuỗi in + link QR + tên file từng khách; ?guestId lọc một khách; mẫu null = thiệp mặc định', async () => {
  loginAs();
  stubEvent();
  stubMethod(prisma.eventGuest, 'findMany', async () => [guest(), guest({ id: 'g-2', name: 'lê thị hoa', code: 'x'.repeat(20) })]);
  let template = null;
  stubMethod(prisma.eventInvitationTemplate, 'findUnique', async () => template);

  const all = await request(app).get('/api/events/evt-1/invitations/cards').set('Authorization', auth('btc-1'));
  assert.strictEqual(all.status, 200);
  assert.strictEqual(all.body.data.template, null);
  assert.deepStrictEqual(all.body.data.items.map((it) => it.fileName), ['Lê Thị Hoa', 'lê thị hoa (2)']);
  assert.strictEqual(all.body.data.items[0].qrText, invitationUrl(CODE));
  assert.strictEqual(all.body.data.items[0].values.event, 'Gala Doanh nghiệp');

  template = { width: 1000, height: 1400, fields: [{ key: 'qr', x: 0.5, y: 0.5, size: 0.2 }], updatedAt: new Date() };
  const one = await request(app).get('/api/events/evt-1/invitations/cards?guestId=g-2').set('Authorization', auth('btc-1'));
  assert.deepStrictEqual(one.body.data.items.map((it) => it.fileName), ['lê thị hoa (2)']);
  assert.strictEqual(one.body.data.template.fields.length, 7); // withAllFields bù đủ ô
  assert.strictEqual(one.body.data.template.image, undefined);

  const missing = await request(app).get('/api/events/evt-1/invitations/cards?guestId=nope').set('Authorization', auth('btc-1'));
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.body.error, 'GUEST_NOT_FOUND');
});

// ── Gửi thiệp ───────────────────────────────────────────────────

test('gửi thiệp: không truyền guestIds → chỉ khách có email chưa nhận (chờ gửi/lỗi), trả 202', async () => {
  loginAs();
  stubEvent();
  const findMany = stubMethod(prisma.eventGuest, 'findMany', async () => []);
  const none = await request(app).post('/api/events/evt-1/invitations/send').set('Authorization', auth('btc-1'));
  assert.strictEqual(none.status, 400);
  assert.strictEqual(none.body.error, 'NOTHING_TO_SEND');
  const where = findMany.calls[0][0].where;
  assert.deepStrictEqual(where.inviteStatus, { in: ['PENDING', 'FAILED'] });
  assert.strictEqual(where.isWalkIn, false);
  assert.deepStrictEqual(where.email, { not: null });
});

test('deliverInvitations: giành từng khách trước khi gửi, kèm PDF; lỗi thì đánh dấu FAILED', async () => {
  stubMethod(prisma.eventInvitationTemplate, 'findUnique', async () => null);
  stubMethod(prisma.eventGuest, 'updateMany', async ({ where }) => ({ count: where.id === 'g-taken' ? 0 : 1 }));
  stubMethod(prisma.eventGuest, 'findUnique', async ({ where }) => guest({ id: where.id, email: `${where.id}@corp.vn` }));
  const update = stubMethod(prisma.eventGuest, 'update', async () => ({}));
  const sent = stubMethod(emailService, 'sendInvitationEmail', async (email) => {
    if (email.startsWith('g-bad')) throw new Error('Brevo 400');
  });

  await deliverInvitations(EVENT, ['g-ok', 'g-taken', 'g-bad']);
  assert.deepStrictEqual(sent.calls.map((c) => c[0]), ['g-ok@corp.vn', 'g-bad@corp.vn']);
  const opts = sent.calls[0][3];
  assert.ok(opts.pdf.length > 1000);
  assert.strictEqual(opts.viewUrl, invitationUrl(CODE));
  assert.match(opts.filename, /^[\w\- ]+\.pdf$/);
  const statuses = Object.fromEntries(update.calls.map((c) => [c[0].where.id, c[0].data.inviteStatus]));
  assert.deepStrictEqual(statuses, { 'g-ok': 'SENT', 'g-bad': 'FAILED' });
});

// ── Báo cáo ─────────────────────────────────────────────────────

test('báo cáo HTML khách mời: tách khách mời đã tới / tại chỗ / chưa tới, escape tên', () => {
  const html = buildGuestHtmlReport(EVENT, [
    guest({ id: '1', name: 'Đã Tới', checkedInAt: new Date('2026-10-20T07:10:00Z'), checkedInBy: 'BTC' }),
    guest({ id: '2', name: '<script>x</script>', checkedInAt: null }),
    guest({ id: '3', name: 'Tại Chỗ', isWalkIn: true, checkedInAt: new Date('2026-10-20T07:20:00Z') }),
  ]);
  assert.ok(!html.includes('<script>x'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('14:10'));
  assert.match(html, /Khách mời chưa tới <span class="badge red">1 người/);
  assert.match(html, /Đã có mặt <span class="badge green">2 người/);
  assert.ok(!html.includes('<script'));
});

test('xuất báo cáo HTML của sự kiện thiệp mời dùng danh sách khách', async () => {
  loginAs();
  stubEvent();
  stubMethod(prisma.eventGuest, 'findMany', async () => [guest({ name: 'Khách Báo Cáo' })]);
  stubMethod(prisma.attendance, 'findMany', async () => { throw new Error('không được đọc bảng điểm danh'); });
  const res = await request(app).get('/api/reports/events/evt-1/export-html?view=1').set('Authorization', auth('btc-1'));
  assert.strictEqual(res.status, 200);
  assert.ok(res.text.includes('Khách Báo Cáo'));
  assert.ok(res.text.includes('Báo cáo khách mời'));
});
