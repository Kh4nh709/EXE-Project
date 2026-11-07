const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { PDFDocument } = require('pdf-lib');
const prisma = require('../src/lib/prisma');
const emailService = require('../src/services/email.service');
const { certificateToken } = require('../src/lib/certificateLink');
const app = require('../src/app');
const {
  DEFAULT_FIELDS, normalizeFields, layoutField, certificateValues, generateCertificateCode,
} = require('../src/lib/certificateLayout');
const { renderCertificatePdf, inspectTemplateImage, pageSize } = require('../src/services/certificatePdf');
const { sendCertificateEmails } = require('../src/controllers/certificate.controller');
const { stubMethod, restoreStubs } = require('../testenv');

const USERS = {
  'btc-1': { id: 'btc-1', mssv: null, email: 'btc@f.c', name: 'BTC', role: 'BTC', isActive: true, isFirstLogin: false },
  'btc-2': { id: 'btc-2', mssv: null, email: 'btc2@f.c', name: 'BTC 2', role: 'BTC', isActive: true, isFirstLogin: false },
  'stu-1': { id: 'stu-1', mssv: 'SE1', email: 'se1@f.c', name: 'An', role: 'STUDENT', isActive: true, isFirstLogin: false },
  'stu-2': { id: 'stu-2', mssv: 'SE2', email: 'se2@f.c', name: 'Bình', role: 'STUDENT', isActive: true, isFirstLogin: false },
};
const auth = (id) => `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET)}`;
const loginAs = () => stubMethod(prisma.user, 'findUnique', async ({ where }) => USERS[where.id] || null);
const EVENT = { id: 'evt-1', name: 'Hội thảo Đổi mới', createdById: 'btc-1', isActive: true, checkinOpen: new Date('2026-10-01T01:00:00Z') };
const ownedEvent = () => stubMethod(prisma.event, 'findUnique', async () => EVENT);

// PNG màu trơn tự tạo — không cần file mẫu trong repo.
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(w * 3 + 1);
  for (let x = 0; x < w; x++) row.set([250, 244, 230], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNG = makePng(1200, 850);
const TEMPLATE = { image: PNG, mimeType: 'image/png', width: 1200, height: 850, fields: DEFAULT_FIELDS };

afterEach(() => restoreStubs());

// ── Bố cục ──────────────────────────────────────────────────────

test('normalizeFields: giữ đủ 4 ô, kẹp giá trị, ô tên luôn bật, màu/font sai thì lấy mặc định', () => {
  const { value } = normalizeFields([
    { key: 'name', enabled: false, x: 2, y: -1, size: 5, font: 'comic', color: 'red', align: 'middle' },
    { key: 'code', enabled: false },
    { key: 'hack', x: 0.1 },
  ]);
  assert.deepStrictEqual(value.map((f) => f.key), ['name', 'event', 'date', 'code']);
  const name = value[0];
  assert.deepStrictEqual(
    { enabled: name.enabled, x: name.x, y: name.y, size: name.size, font: name.font, color: name.color, align: name.align },
    { enabled: true, x: 1, y: 0, size: 0.2, font: 'script', color: '#1F2A44', align: 'center' },
  );
  assert.strictEqual(value[3].enabled, false);
  assert.ok(normalizeFields('x').error);
});

test('layoutField: căn giữa/phải theo điểm neo và tự thu nhỏ chữ quá dài', () => {
  const measure = (t, size) => t.length * size * 0.5;
  const f = { x: 0.5, y: 0.5, size: 0.05, maxWidth: 0.5, align: 'center' };
  const short = layoutField(f, 'abcd', 1000, 700, measure); // rộng 100 < 500
  assert.deepStrictEqual(short, { left: 450, baseline: 350, fontSize: 50, width: 100 });
  const long = layoutField(f, 'x'.repeat(40), 1000, 700, measure); // rộng 1000 > 500 → thu nửa
  assert.strictEqual(long.fontSize, 25);
  assert.strictEqual(long.width, 500);
  assert.strictEqual(long.left, 250);
  const right = layoutField({ ...f, align: 'right', x: 0.9 }, 'abcd', 1000, 700, measure);
  assert.strictEqual(right.left, 800);
});

test('certificateValues: ngày theo giờ Việt Nam, kèm mã chứng nhận', () => {
  // 20:00 UTC ngày 30/9 = 03:00 ngày 1/10 ở VN.
  const v = certificateValues(
    { recipientName: 'Nguyễn Văn An', code: 'CN-ABCD-EFGH' },
    { name: 'Hội thảo', checkinOpen: new Date('2026-09-30T20:00:00Z') },
  );
  assert.deepStrictEqual(v, { name: 'Nguyễn Văn An', event: 'Hội thảo', date: 'Ngày 01/10/2026', code: 'Mã chứng nhận: CN-ABCD-EFGH' });
});

test('generateCertificateCode: định dạng CN-XXXX-XXXX, không có ký tự dễ nhầm', () => {
  for (let i = 0; i < 50; i++) assert.match(generateCertificateCode(), /^CN-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});

// ── Ảnh mẫu & PDF ───────────────────────────────────────────────

test('inspectTemplateImage: nhận PNG thật, từ chối file không phải ảnh', async () => {
  assert.deepStrictEqual((await inspectTemplateImage(PNG)).value, { mimeType: 'image/png', width: 1200, height: 850 });
  assert.ok((await inspectTemplateImage(Buffer.from('%PDF-1.7 not an image'))).error);
  assert.ok((await inspectTemplateImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 1, 2]))).error);
});

test('renderCertificatePdf: tạo PDF 1 trang đúng tỉ lệ ảnh, có font tiếng Việt', async () => {
  const values = certificateValues({ recipientName: 'Đặng Thị Phương Thảo', code: 'CN-ABCD-EFGH' }, EVENT);
  const bytes = await renderCertificatePdf(TEMPLATE, values, { title: 'Chứng nhận' });
  assert.strictEqual(Buffer.from(bytes).subarray(0, 5).toString(), '%PDF-');
  const doc = await PDFDocument.load(bytes);
  assert.strictEqual(doc.getPageCount(), 1);
  const { width, height } = doc.getPage(0).getSize();
  const [W, H] = pageSize(1200, 850);
  assert.strictEqual(Math.round(width), Math.round(W));
  assert.strictEqual(Math.round(height), Math.round(H));
  assert.strictEqual(Math.round(width), 842);
});

// ── BTC: mẫu ────────────────────────────────────────────────────

test('upload ảnh mẫu: người không phải chủ sự kiện → 403', async () => {
  loginAs();
  ownedEvent();
  const res = await request(app).put('/api/events/evt-1/certificate/image').set('Authorization', auth('btc-2'))
    .attach('file', PNG, 'mau.png');
  assert.strictEqual(res.status, 403);
});

test('upload ảnh mẫu: ảnh quá nhỏ hoặc không phải ảnh → 400', async () => {
  loginAs();
  ownedEvent();
  const small = await request(app).put('/api/events/evt-1/certificate/image').set('Authorization', auth('btc-1'))
    .attach('file', makePng(300, 200), 'nho.png');
  assert.strictEqual(small.status, 400);
  const txt = await request(app).put('/api/events/evt-1/certificate/image').set('Authorization', auth('btc-1'))
    .attach('file', Buffer.from('hello'), 'a.png');
  assert.strictEqual(txt.status, 400);
});

test('upload ảnh mẫu lần đầu: lưu ảnh + bố cục mặc định, đọc đúng kích thước', async () => {
  loginAs();
  ownedEvent();
  const upsert = stubMethod(prisma.eventCertificateTemplate, 'upsert', async () => ({}));
  stubMethod(prisma.eventCertificateTemplate, 'findUnique', async () => ({ mimeType: 'image/png', width: 1200, height: 850, fields: DEFAULT_FIELDS }));
  stubMethod(prisma.certificate, 'count', async () => 0);
  stubMethod(prisma.attendance, 'count', async () => 3);

  const res = await request(app).put('/api/events/evt-1/certificate/image').set('Authorization', auth('btc-1'))
    .attach('file', PNG, 'mau.png');
  assert.strictEqual(res.status, 200);
  const { create, update } = upsert.calls[0][0];
  assert.deepStrictEqual([create.width, create.height, create.mimeType], [1200, 850, 'image/png']);
  assert.deepStrictEqual(create.fields, DEFAULT_FIELDS);
  assert.strictEqual(update.fields, undefined, 'đổi ảnh không được xoá bố cục đang có');
  assert.strictEqual(res.body.data.pendingCount, 3);
});

test('gỡ mẫu khi đã cấp chứng nhận → 409', async () => {
  loginAs();
  ownedEvent();
  stubMethod(prisma.certificate, 'count', async () => 2);
  const del = stubMethod(prisma.eventCertificateTemplate, 'deleteMany', async () => ({ count: 1 }));
  const res = await request(app).delete('/api/events/evt-1/certificate').set('Authorization', auth('btc-1'));
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error, 'CERTIFICATES_ISSUED');
  assert.strictEqual(del.calls.length, 0);
});

test('xem thử PDF: trả PDF inline với tên mẫu', async () => {
  loginAs();
  ownedEvent();
  stubMethod(prisma.eventCertificateTemplate, 'findUnique', async () => TEMPLATE);
  const res = await request(app).get('/api/events/evt-1/certificate/preview?name=Tr%E1%BA%A7n%20B')
    .set('Authorization', auth('btc-1')).buffer(true).parse((r, cb) => { const d = []; r.on('data', (c) => d.push(c)); r.on('end', () => cb(null, Buffer.concat(d))); });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /^inline;/);
  assert.strictEqual(res.body.subarray(0, 5).toString(), '%PDF-');
});

// ── BTC: cấp chứng nhận ─────────────────────────────────────────

test('cấp chứng nhận khi chưa có mẫu → 400 NO_TEMPLATE', async () => {
  loginAs();
  ownedEvent();
  stubMethod(prisma.eventCertificateTemplate, 'findUnique', async () => null);
  const res = await request(app).post('/api/events/evt-1/certificates/issue').set('Authorization', auth('btc-1'));
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'NO_TEMPLATE');
});

test('cấp chứng nhận: chỉ người đã check-out chưa có chứng nhận, trả 202 rồi gửi email nền', async () => {
  loginAs();
  ownedEvent();
  stubMethod(prisma.eventCertificateTemplate, 'findUnique', async () => ({ id: 'tpl' }));
  const findPending = stubMethod(prisma.attendance, 'findMany', async () => [
    { user: { id: 'stu-1', name: 'An' } }, { user: { id: 'stu-2', name: 'Bình' } },
  ]);
  const createMany = stubMethod(prisma.certificate, 'createMany', async ({ data }) => ({ count: data.length }));
  stubMethod(prisma.certificate, 'findMany', async () => [
    { id: 'c1', recipientName: 'An', user: { email: 'se1@f.c' } },
    { id: 'c2', recipientName: 'Bình', user: { email: 'se2@f.c' } },
  ]);
  stubMethod(prisma.certificate, 'updateMany', async () => ({ count: 1 }));
  const update = stubMethod(prisma.certificate, 'update', async () => ({}));
  const email = stubMethod(emailService, 'sendCertificateEmail', async () => {});

  const res = await request(app).post('/api/events/evt-1/certificates/issue').set('Authorization', auth('btc-1'));
  assert.strictEqual(res.status, 202);
  assert.deepStrictEqual(res.body.data, { issued: 2, emailing: 2 });

  const where = findPending.calls[0][0].where;
  assert.strictEqual(where.status, 'CHECKED_OUT');
  assert.deepStrictEqual(where.user, { isActive: true, certificates: { none: { eventId: 'evt-1' } } });
  const { data, skipDuplicates } = createMany.calls[0][0];
  assert.strictEqual(skipDuplicates, true);
  assert.deepStrictEqual(data.map((d) => [d.userId, d.recipientName, d.issuedById]), [['stu-1', 'An', 'btc-1'], ['stu-2', 'Bình', 'btc-1']]);
  assert.notStrictEqual(data[0].code, data[1].code);

  for (let i = 0; i < 30 && update.calls.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(email.calls.map((c) => c[0]), ['se1@f.c', 'se2@f.c']);
  assert.ok(update.calls.every((c) => c[0].data.emailStatus === 'SENT'));
});

test('cấp chứng nhận khi không còn ai mới và không có email lỗi → 400 NOTHING_TO_ISSUE', async () => {
  loginAs();
  ownedEvent();
  stubMethod(prisma.eventCertificateTemplate, 'findUnique', async () => ({ id: 'tpl' }));
  stubMethod(prisma.attendance, 'findMany', async () => []);
  stubMethod(prisma.certificate, 'findMany', async () => []);
  const res = await request(app).post('/api/events/evt-1/certificates/issue').set('Authorization', auth('btc-1'));
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'NOTHING_TO_ISSUE');
});

test('gửi email: chứng nhận đã bị lượt khác giành thì bỏ qua; gửi lỗi thì đánh dấu FAILED', async () => {
  stubMethod(prisma.certificate, 'updateMany', async ({ where }) => ({ count: where.id === 'taken' ? 0 : 1 }));
  const update = stubMethod(prisma.certificate, 'update', async () => ({}));
  const email = stubMethod(emailService, 'sendCertificateEmail', async (to) => { if (to === 'bad@f.c') throw new Error('Brevo 400'); });
  await sendCertificateEmails(EVENT, [
    { id: 'taken', recipientName: 'X', user: { email: 'x@f.c' } },
    { id: 'ok', recipientName: 'Y', user: { email: 'y@f.c' } },
    { id: 'bad', recipientName: 'Z', user: { email: 'bad@f.c' } },
  ]);
  assert.deepStrictEqual(email.calls.map((c) => c[0]), ['y@f.c', 'bad@f.c']);
  const statusById = Object.fromEntries(update.calls.map((c) => [c[0].where.id, c[0].data.emailStatus]));
  assert.deepStrictEqual(statusById, { ok: 'SENT', bad: 'FAILED' });
});

// ── Người nhận ──────────────────────────────────────────────────

const CERT = {
  id: 'cert-1', code: 'CN-ABCD-EFGH', eventId: 'evt-1', userId: 'stu-1', recipientName: 'An',
  issuedAt: new Date('2026-10-01T10:00:00Z'), event: EVENT,
};

test('BTC không tạo sự kiện xem chứng nhận qua /api/certificates → 404', async () => {
  loginAs();
  stubMethod(prisma.certificate, 'findUnique', async () => CERT);
  for (const path of ['', '/pdf', '/background']) {
    const res = await request(app).get(`/api/certificates/cert-1${path}`).set('Authorization', auth('btc-2'));
    assert.strictEqual(res.status, 404, path);
  }
});

test('link chứng nhận sai chữ ký hoặc của chứng nhận khác → 404, không chạm DB', async () => {
  const find = stubMethod(prisma.certificate, 'findUnique', async () => CERT);
  const forged = certificateToken('cert-1').replace(/^cert-1\./, 'cert-2.');
  for (const token of ['cert-1.deadbeef', forged, 'cert-1']) {
    const res = await request(app).get(`/api/public/certificates/${token}`);
    assert.strictEqual(res.status, 404, token);
  }
  assert.strictEqual(find.calls.length, 0);
});

test('người nhận: xem dữ liệu để vẽ và tải PDF qua link trong email, không cần đăng nhập', async () => {
  stubMethod(prisma.certificate, 'findUnique', async () => CERT);
  stubMethod(prisma.eventCertificateTemplate, 'findUnique', async () => TEMPLATE);
  const token = certificateToken('cert-1');

  const view = await request(app).get(`/api/public/certificates/${token}`);
  assert.strictEqual(view.status, 200);
  assert.deepStrictEqual(view.body.data.values, {
    name: 'An', event: 'Hội thảo Đổi mới', date: 'Ngày 01/10/2026', code: 'Mã chứng nhận: CN-ABCD-EFGH',
  });

  const pdf = await request(app).get(`/api/public/certificates/${token}/pdf`);
  assert.strictEqual(pdf.status, 200);
  assert.strictEqual(pdf.headers['content-type'], 'application/pdf');
  assert.match(pdf.headers['content-disposition'], /^attachment;.*filename\*=UTF-8''/);
});

