const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const prisma = require('../src/lib/prisma');
const emailService = require('../src/services/email.service');
const qrService = require('../src/services/qr.service');
const { issueTicket } = require('../src/lib/scanTicket');
const { issuePass, validatePass } = require('../src/lib/checkinPass');
const { maskEmail } = require('../src/controllers/checkinOtp.controller');
const app = require('../src/app');
const { stubMethod, restoreStubs } = require('../testenv');

const realNow = Date.now;
afterEach(() => { Date.now = realNow; restoreStubs(); });

const STUDENT = {
  id: 'u1', mssv: 'SE1', email: 'nguyenvana@fpt.edu.vn', name: 'An', role: 'STUDENT', isActive: true,
};

function openEvent(overrides = {}) {
  return {
    id: 'evt-1', name: 'Hội thảo', location: 'A1', kind: 'STANDARD', isActive: true,
    isWhitelisted: true, otpCheckinEnabled: true, gpsEnabled: false, lat: null, lng: null, radius: 100,
    checkinOpen: new Date(Date.now() - 3600e3), checkinClose: new Date(Date.now() + 3600e3),
    checkoutOpen: new Date(Date.now() - 3600e3), checkoutClose: new Date(Date.now() + 3600e3),
    checkinState: 'AUTO', checkoutState: 'AUTO',
    ...overrides,
  };
}

// Mặc định: sự kiện mở, sinh viên có trong danh sách, chưa điểm danh, máy chưa ai dùng.
function mockRequestPath({ event = openEvent(), user = STUDENT, member = true, attendance = null, otherOnDevice = null, recentOtp = null } = {}) {
  stubMethod(prisma.event, 'findUnique', async () => event);
  stubMethod(prisma.user, 'findFirst', async () => user);
  stubMethod(prisma.eventMember, 'findUnique', async () => (member ? { id: 'm1' } : null));
  stubMethod(prisma.attendance, 'findUnique', async () => attendance);
  stubMethod(prisma.attendance, 'findFirst', async () => otherOnDevice);
  stubMethod(prisma.fraudLog, 'create', async () => ({}));
  stubMethod(prisma.otpToken, 'findFirst', async () => recentOtp);
  stubMethod(prisma.otpToken, 'deleteMany', async () => ({ count: 0 }));
  return {
    create: stubMethod(prisma.otpToken, 'create', async ({ data }) => ({ id: 'otp1', ...data })),
    mail: stubMethod(emailService, 'sendCheckinOtpEmail', async () => {}),
  };
}

function ticketFor(type = 'checkin', deviceId = 'dev-1') {
  return issueTicket('evt-1', type, deviceId).ticket;
}

function requestOtp(body = {}) {
  return request(app).post('/api/public/checkin-otp/request').send({
    eventId: 'evt-1', type: 'checkin', deviceId: 'dev-1', identifier: 'nguyenvana@fpt.edu.vn',
    ticket: ticketFor(body.type, body.deviceId), ...body,
  });
}

// ── checkin-otp/request ─────────────────────────────────────────────────────

test('request emails a CHECKIN code bound to the scanning device, without logging in', async () => {
  const { create, mail } = mockRequestPath();

  const res = await requestOtp();

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.maskedEmail, 'ng*****@fpt.edu.vn');
  const { data } = create.calls[0][0];
  assert.strictEqual(data.purpose, 'CHECKIN');
  assert.strictEqual(data.deviceId, 'dev-1');
  assert.match(data.token, /^\d{6}$/);
  assert.strictEqual(mail.calls[0][0], 'nguyenvana@fpt.edu.vn');
  assert.strictEqual(mail.calls[0][2], data.token);
  assert.strictEqual(mail.calls[0][3].name, 'Hội thảo');
});

test('request accepts the raw QR token too, and an MSSV instead of an email', async () => {
  const { mail } = mockRequestPath();

  const res = await requestOtp({ ticket: undefined, token: qrService.generateToken('evt-1', 'checkin'), identifier: 'se1' });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(mail.calls.length, 1);
});

test('request without a valid scan sends nothing', async () => {
  // Không đứng trước màn hình thì không dò được danh sách, không bắt gửi email hộ.
  const { mail } = mockRequestPath();

  const res = await requestOtp({ ticket: ticketFor('checkin', 'other-device') });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'QR_EXPIRED');
  assert.strictEqual(mail.calls.length, 0);
});

test('request refuses someone outside the participant list before any email', async () => {
  const { mail } = mockRequestPath({ member: false });

  const res = await requestOtp();

  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'NOT_REGISTERED');
  assert.strictEqual(mail.calls.length, 0);
});

test('request on a whitelisted event answers NOT_REGISTERED for an unknown email too', async () => {
  const { mail } = mockRequestPath({ user: null });

  const res = await requestOtp();

  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'NOT_REGISTERED');
  assert.strictEqual(mail.calls.length, 0);
});

test('request on an open event needs an existing account', async () => {
  const { mail } = mockRequestPath({ user: null, event: openEvent({ isWhitelisted: false }) });

  const res = await requestOtp();

  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'ACCOUNT_NOT_FOUND');
  assert.strictEqual(mail.calls.length, 0);
});

test('request is refused when BTC turned email check-in off', async () => {
  const { mail } = mockRequestPath({ event: openEvent({ otpCheckinEnabled: false }) });

  const res = await requestOtp();

  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'OTP_CHECKIN_DISABLED');
  assert.strictEqual(mail.calls.length, 0);
});

test('request is refused on invitation events', async () => {
  const { mail } = mockRequestPath({ event: openEvent({ kind: 'INVITATION' }) });

  const res = await requestOtp();

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'INVITATION_EVENT');
  assert.strictEqual(mail.calls.length, 0);
});

test('request does not spend an email while the gate is closed', async () => {
  const { mail } = mockRequestPath({ event: openEvent({ checkinState: 'CLOSED' }) });

  const res = await requestOtp();

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'ATTENDANCE_CLOSED');
  assert.strictEqual(mail.calls.length, 0);
});

test('request does not spend an email on someone already checked in', async () => {
  const { mail } = mockRequestPath({ attendance: { checkinTime: new Date(), checkoutTime: null } });

  const res = await requestOtp();

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'ALREADY_CHECKED_IN');
  assert.strictEqual(mail.calls.length, 0);
});

test('request refuses a device that already checked in someone else', async () => {
  const { mail } = mockRequestPath({ otherOnDevice: { userId: 'u2' } });

  const res = await requestOtp();

  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'DEVICE_USED_BY_OTHER');
  assert.strictEqual(mail.calls.length, 0);
});

test('request within the resend cooldown sends no second email', async () => {
  const { mail } = mockRequestPath({ recentOtp: { createdAt: new Date(Date.now() - 20_000) } });

  const res = await requestOtp();

  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.body.error, 'OTP_COOLDOWN');
  assert.ok(res.body.retryAfter > 0 && res.body.retryAfter <= 40);
  assert.strictEqual(res.body.maskedEmail, 'ng*****@fpt.edu.vn');
  assert.strictEqual(mail.calls.length, 0);
});

test('request is open to any role on the list — no account session is issued', async () => {
  const { mail } = mockRequestPath({ user: { ...STUDENT, role: 'LECTURER' } });

  const res = await requestOtp();

  assert.strictEqual(res.status, 200);
  assert.strictEqual(mail.calls.length, 1);
});

test('request drops the code when the email fails', async () => {
  mockRequestPath();
  stubMethod(emailService, 'sendCheckinOtpEmail', async () => { throw new Error('brevo down'); });
  const del = stubMethod(prisma.otpToken, 'deleteMany', async () => ({ count: 1 }));

  const res = await requestOtp();

  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.error, 'EMAIL_FAILED');
  // deleteMany lần 1 dọn mã cũ, lần 2 xoá mã vừa tạo
  assert.strictEqual(del.calls.length, 2);
});

// ── checkin-otp/verify ──────────────────────────────────────────────────────

function mockVerifyPath(record) {
  stubMethod(prisma.event, 'findUnique', async () => openEvent());
  stubMethod(prisma.user, 'findFirst', async () => STUDENT);
  const find = stubMethod(prisma.otpToken, 'findFirst', async () => record);
  const update = stubMethod(prisma.otpToken, 'update', async () => ({}));
  return { find, update };
}

function verify(body = {}) {
  return request(app).post('/api/public/checkin-otp/verify').send({
    eventId: 'evt-1', deviceId: 'dev-1', identifier: 'SE1', otp: '123456', ...body,
  });
}

test('verify with the right code returns a check-in pass and no JWT', async () => {
  const { find, update } = mockVerifyPath({ id: 'otp1', token: '123456', attempts: 0 });

  const res = await verify();

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.token, undefined);
  assert.strictEqual(validatePass(res.body.pass, 'evt-1', 'dev-1'), 'u1');
  assert.strictEqual(find.calls[0][0].where.deviceId, 'dev-1');
  assert.strictEqual(find.calls[0][0].where.purpose, 'CHECKIN');
  assert.deepStrictEqual(update.calls[0][0].data, { used: true });
});

test('verify counts a wrong code against that code', async () => {
  const { update } = mockVerifyPath({ id: 'otp1', token: '123456', attempts: 1 });

  const res = await verify({ otp: '000000' });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'INVALID_CHECKIN_OTP');
  assert.strictEqual(res.body.attemptsLeft, 3);
  assert.deepStrictEqual(update.calls[0][0].data, { attempts: 2 });
});

test('verify burns the code on the fifth wrong attempt', async () => {
  const { update } = mockVerifyPath({ id: 'otp1', token: '123456', attempts: 4 });

  const res = await verify({ otp: '000000' });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'OTP_TOO_MANY_ATTEMPTS');
  assert.deepStrictEqual(update.calls[0][0].data, { attempts: 5, used: true });
});

test('verify with no live code is a generic failure', async () => {
  mockVerifyPath(null);

  const res = await verify();

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'INVALID_CHECKIN_OTP');
});

// ── self-checkin (bằng thẻ) ─────────────────────────────────────────────────

function mockPassCheckin({ attendance = null, otherOnDevice = null, event = openEvent() } = {}) {
  stubMethod(prisma.event, 'findUnique', async () => event);
  stubMethod(prisma.user, 'findUnique', async () => STUDENT);
  stubMethod(prisma.eventMember, 'findUnique', async () => ({ id: 'm1' }));
  stubMethod(prisma.attendance, 'findFirst', async () => otherOnDevice);
  stubMethod(prisma.attendance, 'findUnique', async () => attendance);
  stubMethod(prisma.fraudLog, 'create', async () => ({}));
  stubMethod(prisma.eventFeedbackForm, 'findUnique', async () => null);
  return {
    binding: stubMethod(prisma.deviceBinding, 'findFirst', async () => null),
    upsert: stubMethod(prisma.attendance, 'upsert', async () => ({ id: 'a1' })),
    update: stubMethod(prisma.attendance, 'update', async () => ({ id: 'a1' })),
  };
}

function selfCheckin(body = {}) {
  return request(app).post('/api/public/self-checkin').send({
    eventId: 'evt-1', type: 'checkin', deviceId: 'dev-1',
    pass: issuePass('u1', 'evt-1', 'dev-1').pass, ticket: ticketFor(body.type), gps: null, ...body,
  });
}

test('a valid pass checks in without a JWT or device binding', async () => {
  const { binding, upsert } = mockPassCheckin();

  const res = await selfCheckin();

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.type, 'checkin');
  assert.strictEqual(res.body.user.name, 'An');
  assert.strictEqual(binding.calls.length, 0);
  const { create } = upsert.calls[0][0];
  assert.strictEqual(create.userId, 'u1');
  assert.strictEqual(create.deviceId, 'dev-1');
});

test('the same pass checks out later without a second email', async () => {
  const { update } = mockPassCheckin({ attendance: { id: 'a1', checkinTime: new Date(), checkoutTime: null } });

  const res = await selfCheckin({ type: 'checkout', ticket: ticketFor('checkout') });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(update.calls[0][0].data.status, 'CHECKED_OUT');
});

test('a pass minted on another device is rejected', async () => {
  const { upsert } = mockPassCheckin();

  const res = await selfCheckin({ pass: issuePass('u1', 'evt-1', 'dev-2').pass });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'PASS_INVALID');
  assert.strictEqual(upsert.calls.length, 0);
});

test('a pass for another event is rejected', async () => {
  mockPassCheckin();

  const res = await selfCheckin({ pass: issuePass('u1', 'evt-2', 'dev-1').pass });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'PASS_INVALID');
});

test('an expired pass is rejected', async () => {
  mockPassCheckin();
  const { pass } = issuePass('u1', 'evt-1', 'dev-1');
  const mintedAt = realNow();
  Date.now = () => mintedAt + 25 * 3600e3;

  const res = await selfCheckin({ pass });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'PASS_INVALID');
});

test('a pass still needs a fresh scan', async () => {
  mockPassCheckin();

  const res = await selfCheckin({ ticket: ticketFor('checkin', 'dev-2') });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'QR_EXPIRED');
});

test('a pass cannot check in a second person from the same phone', async () => {
  const { upsert } = mockPassCheckin({ otherOnDevice: { userId: 'u2' } });

  const res = await selfCheckin();

  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'DEVICE_USED_BY_OTHER');
  assert.strictEqual(upsert.calls.length, 0);
});

test('logged-in check-in obeys the one-phone-one-person rule too', async () => {
  // Đăng nhập OTP tự tin cậy máy mới, nên bỏ ngỏ đường này thì luật vô dụng.
  const { upsert } = mockPassCheckin({ otherOnDevice: { userId: 'u2' } });
  stubMethod(prisma.deviceBinding, 'findFirst', async () => ({ id: 'b1', isTrusted: true }));

  const res = await request(app)
    .post('/api/checkin')
    .set('Authorization', `Bearer ${jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET)}`)
    .send({ eventId: 'evt-1', type: 'checkin', deviceId: 'dev-1', ticket: ticketFor(), gps: null });

  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'DEVICE_USED_BY_OTHER');
  assert.strictEqual(upsert.calls.length, 0);
});

// ── Form đánh giá bằng thẻ ──────────────────────────────────────────────────

test('the pass opens the feedback form after check-out', async () => {
  stubMethod(prisma.user, 'findUnique', async () => STUDENT);
  stubMethod(prisma.event, 'findFirst', async () => ({ id: 'evt-1', name: 'Hội thảo' }));
  stubMethod(prisma.eventFeedbackForm, 'findUnique', async () => ({
    id: 'f1', title: 'Đánh giá', questions: [{ id: 'q1', type: 'RATING', label: 'Hay?', required: true }],
    isOpen: true, isAnonymous: false,
  }));
  stubMethod(prisma.attendance, 'findUnique', async () => ({ status: 'CHECKED_OUT' }));
  stubMethod(prisma.feedbackResponse, 'findUnique', async () => null);
  const saved = stubMethod(prisma.feedbackResponse, 'upsert', async ({ create }) => ({ answers: create.answers, updatedAt: new Date() }));
  const headers = { 'X-Checkin-Pass': issuePass('u1', 'evt-1', 'dev-1').pass, 'X-Device-ID': 'dev-1' };

  const got = await request(app).get('/api/public/feedback/evt-1/response').set(headers);
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.body.data.canSubmit, true);

  const sent = await request(app).post('/api/public/feedback/evt-1/response').set(headers).send({ answers: { q1: 5 } });
  assert.strictEqual(sent.status, 201);
  assert.strictEqual(saved.calls[0][0].create.userId, 'u1');
});

test('feedback without a pass is a 400, never a 401 that logs the page out', async () => {
  const res = await request(app).get('/api/public/feedback/evt-1/response').set('X-Device-ID', 'dev-1');

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'PASS_INVALID');
});

// ── Đơn vị ──────────────────────────────────────────────────────────────────

test('maskEmail keeps just enough to recognise the inbox', () => {
  assert.strictEqual(maskEmail('nguyenvana@fpt.edu.vn'), 'ng*****@fpt.edu.vn');
  assert.strictEqual(maskEmail('an@fpt.edu.vn'), 'a*****@fpt.edu.vn');
});

test('a tampered pass naming another user is rejected', () => {
  const { pass } = issuePass('u1', 'evt-1', 'dev-1');
  const forged = pass.replace(/^u1\./, 'u2.');
  assert.strictEqual(validatePass(forged, 'evt-1', 'dev-1'), null);
});
