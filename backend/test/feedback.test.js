const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const prisma = require('../src/lib/prisma');
const app = require('../src/app');
const {
  normalizeQuestions, validateAnswers, summarizeResponses,
} = require('../src/lib/feedbackForm');
const { stubMethod, restoreStubs } = require('../testenv');

const USERS = {
  'btc-1': { id: 'btc-1', mssv: null, email: 'btc@f.c', name: 'BTC Một', role: 'BTC', isActive: true, isFirstLogin: false },
  'btc-2': { id: 'btc-2', mssv: null, email: 'btc2@f.c', name: 'BTC Hai', role: 'BTC', isActive: true, isFirstLogin: false },
  'admin-1': { id: 'admin-1', mssv: null, email: 'ad@f.c', name: 'Admin', role: 'ADMIN', isActive: true, isFirstLogin: false },
  // Người tham gia dùng thẻ OTP (test ở checkin-otp.test.js); đường JWT còn cho nhân sự đi dự.
  'stu-1': { id: 'stu-1', mssv: 'SE1', email: 'se1@f.c', name: 'Sinh Viên', role: 'LECTURER', isActive: true, isFirstLogin: false },
  'par-1': { id: 'par-1', mssv: 'SE9', email: 'se9@f.c', name: 'Người tham gia', role: 'STUDENT', isActive: true, isFirstLogin: false },
};
const auth = (id) => `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET)}`;

function loginAs() {
  stubMethod(prisma.user, 'findUnique', async ({ where }) => USERS[where.id] || null);
}

const QUESTIONS = [
  { id: 'q1', type: 'RATING', label: 'Mức độ hài lòng', required: true },
  { id: 'q2', type: 'TEXT', label: 'Góp ý', required: false },
];

function form(overrides = {}) {
  return {
    id: 'form-1', eventId: 'evt-1', templateId: null, title: 'Đánh giá',
    description: null, questions: QUESTIONS, isAnonymous: false, isOpen: true, ...overrides,
  };
}

// Sự kiện do btc-1 tạo — cho loadEventForWrite.
function ownedEvent() {
  stubMethod(prisma.event, 'findUnique', async () => ({ id: 'evt-1', name: 'Hội thảo', createdById: 'btc-1' }));
}

// Ngữ cảnh người gửi phiếu.
function respondentContext({ formRow = form(), status = 'CHECKED_OUT', existing = null } = {}) {
  stubMethod(prisma.event, 'findFirst', async () => ({ id: 'evt-1', name: 'Hội thảo', location: 'A1', checkinOpen: null }));
  stubMethod(prisma.eventFeedbackForm, 'findUnique', async () => formRow);
  stubMethod(prisma.attendance, 'findUnique', async () => (status ? { status } : null));
  stubMethod(prisma.feedbackResponse, 'findUnique', async () => existing);
}

afterEach(() => restoreStubs());

// ── lib/feedbackForm ────────────────────────────────────────────

test('normalizeQuestions: chuẩn hoá loại/nội dung và sinh id cho câu thiếu hoặc trùng', () => {
  const { value, error } = normalizeQuestions([
    { id: 'a', type: 'rating', label: '  Hài lòng?  ' },
    { id: 'a', type: 'TEXT', label: 'Góp ý', required: false },
    { type: 'TEXT', label: 'Khác' },
  ]);
  assert.strictEqual(error, undefined);
  assert.deepStrictEqual(value[0], { id: 'a', type: 'RATING', label: 'Hài lòng?', required: true });
  assert.notStrictEqual(value[1].id, 'a');
  assert.strictEqual(value[1].required, false);
  assert.strictEqual(new Set(value.map((q) => q.id)).size, 3);
});

test('normalizeQuestions: từ chối form rỗng, loại lạ và câu không có nội dung', () => {
  assert.ok(normalizeQuestions([]).error);
  assert.ok(normalizeQuestions([{ type: 'CHOICE', label: 'x' }]).error);
  assert.ok(normalizeQuestions([{ type: 'TEXT', label: '   ' }]).error);
  assert.ok(normalizeQuestions(Array.from({ length: 31 }, () => ({ type: 'TEXT', label: 'x' }))).error);
});

test('validateAnswers: sao phải là số nguyên 1–5, câu bắt buộc phải trả lời, khoá lạ bị bỏ', () => {
  assert.deepStrictEqual(validateAnswers(QUESTIONS, { q1: 4, q2: '  Tốt  ', hack: 'x' }).value, { q1: 4, q2: 'Tốt' });
  assert.deepStrictEqual(validateAnswers(QUESTIONS, { q1: '5' }).value, { q1: 5 });
  assert.ok(validateAnswers(QUESTIONS, { q2: 'Tốt' }).error, 'thiếu câu bắt buộc');
  assert.ok(validateAnswers(QUESTIONS, { q1: 6 }).error);
  assert.ok(validateAnswers(QUESTIONS, { q1: 3.5 }).error);
  assert.ok(validateAnswers(QUESTIONS, { q1: 0 }).error);
  assert.ok(validateAnswers(QUESTIONS, null).error);
});

test('summarizeResponses: tính trung bình, phân bố và ẩn người gửi khi ẩn danh', () => {
  const responses = [
    { answers: { q1: 5, q2: 'Rất hay' }, updatedAt: new Date(), user: { name: 'A', mssv: 'SE1' } },
    { answers: { q1: 4 }, updatedAt: new Date(), user: { name: 'B', mssv: 'SE2' } },
    { answers: { q1: 4, q2: 'Âm thanh nhỏ' }, updatedAt: new Date(), user: null },
  ];
  const named = summarizeResponses(QUESTIONS, responses, { anonymous: false });
  assert.strictEqual(named.responseCount, 3);
  assert.strictEqual(named.questions[0].average, 4.33);
  assert.deepStrictEqual(named.questions[0].distribution, [0, 0, 0, 2, 1]);
  assert.strictEqual(named.questions[1].answers[0].name, 'A');
  assert.strictEqual(named.questions[1].answers[1].name, '(Tài khoản đã xoá)');
  assert.strictEqual(named.responses.length, 3);

  const anon = summarizeResponses(QUESTIONS, responses, { anonymous: true });
  assert.strictEqual(anon.responses, undefined);
  for (const a of anon.questions[1].answers) assert.deepStrictEqual(Object.keys(a), ['text']);
});

// ── Mẫu đánh giá ────────────────────────────────────────────────

test('LECTURER không truy cập được thư viện mẫu', async () => {
  loginAs();
  const res = await request(app).get('/api/feedback/templates').set('Authorization', auth('stu-1'));
  assert.strictEqual(res.status, 403);
});

test('người tham gia (STUDENT) không còn đăng nhập được — JWT cũ bị từ chối', async () => {
  loginAs();
  const res = await request(app).get('/api/feedback/templates').set('Authorization', auth('par-1'));
  assert.strictEqual(res.status, 401);
});

test('BTC tạo mẫu: câu hỏi được chuẩn hoá và gắn người tạo', async () => {
  loginAs();
  const create = stubMethod(prisma.feedbackTemplate, 'create', async ({ data }) => ({ id: 'tpl-1', ...data }));
  const res = await request(app).post('/api/feedback/templates').set('Authorization', auth('btc-1'))
    .send({ name: 'Mẫu hội thảo', questions: [{ type: 'rating', label: 'Diễn giả' }] });
  assert.strictEqual(res.status, 201);
  const { data } = create.calls[0][0];
  assert.strictEqual(data.createdById, 'btc-1');
  assert.strictEqual(data.questions[0].type, 'RATING');
  assert.strictEqual(res.body.data.canEdit, true);
});

test('BTC tạo mẫu không có câu hỏi → 400', async () => {
  loginAs();
  const res = await request(app).post('/api/feedback/templates').set('Authorization', auth('btc-1'))
    .send({ name: 'Mẫu', questions: [] });
  assert.strictEqual(res.status, 400);
});

test('BTC không sửa/xoá được mẫu của người khác, ADMIN thì được', async () => {
  loginAs();
  stubMethod(prisma.feedbackTemplate, 'findUnique', async () => ({ id: 'tpl-1', name: 'M', createdById: 'btc-1', questions: QUESTIONS }));
  const del = stubMethod(prisma.feedbackTemplate, 'delete', async () => ({}));

  const forbidden = await request(app).delete('/api/feedback/templates/tpl-1').set('Authorization', auth('btc-2'));
  assert.strictEqual(forbidden.status, 403);
  assert.strictEqual(del.calls.length, 0);

  const ok = await request(app).delete('/api/feedback/templates/tpl-1').set('Authorization', auth('admin-1'));
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(del.calls.length, 1);
});

// ── Form của sự kiện ────────────────────────────────────────────

test('gắn form từ mẫu: sao chép câu hỏi của mẫu vào form sự kiện', async () => {
  loginAs();
  ownedEvent();
  stubMethod(prisma.feedbackTemplate, 'findUnique', async () => ({ id: 'tpl-1', name: 'Mẫu hội thảo', description: null, questions: QUESTIONS }));
  stubMethod(prisma.eventFeedbackForm, 'findUnique', async () => null);
  const create = stubMethod(prisma.eventFeedbackForm, 'create', async ({ data }) => ({ id: 'form-1', ...data }));

  const res = await request(app).put('/api/feedback/events/evt-1/form').set('Authorization', auth('btc-1'))
    .send({ templateId: 'tpl-1', isAnonymous: true });
  assert.strictEqual(res.status, 201);
  const { data } = create.calls[0][0];
  assert.strictEqual(data.eventId, 'evt-1');
  assert.strictEqual(data.templateId, 'tpl-1');
  assert.strictEqual(data.title, 'Mẫu hội thảo');
  assert.strictEqual(data.isAnonymous, true);
  assert.deepStrictEqual(data.questions.map((q) => q.id), ['q1', 'q2']);
});

test('BTC không phải người tạo sự kiện không gắn được form', async () => {
  loginAs();
  ownedEvent();
  const res = await request(app).put('/api/feedback/events/evt-1/form').set('Authorization', auth('btc-2'))
    .send({ title: 'x', questions: QUESTIONS });
  assert.strictEqual(res.status, 403);
});

test('đã có phiếu trả lời thì không đổi được câu hỏi và không gỡ được form', async () => {
  loginAs();
  ownedEvent();
  stubMethod(prisma.eventFeedbackForm, 'findUnique', async () => form());
  stubMethod(prisma.feedbackResponse, 'count', async () => 2);
  const update = stubMethod(prisma.eventFeedbackForm, 'update', async () => ({}));
  const del = stubMethod(prisma.eventFeedbackForm, 'delete', async () => ({}));

  const put = await request(app).put('/api/feedback/events/evt-1/form').set('Authorization', auth('btc-1'))
    .send({ title: 'Mới', questions: QUESTIONS });
  assert.strictEqual(put.status, 409);
  assert.strictEqual(put.body.error, 'FEEDBACK_HAS_RESPONSES');

  const remove = await request(app).delete('/api/feedback/events/evt-1/form').set('Authorization', auth('btc-1'));
  assert.strictEqual(remove.status, 409);

  assert.strictEqual(update.calls.length, 0);
  assert.strictEqual(del.calls.length, 0);
});

test('đóng/mở form vẫn được khi đã có phiếu', async () => {
  loginAs();
  ownedEvent();
  stubMethod(prisma.eventFeedbackForm, 'findUnique', async () => form());
  stubMethod(prisma.feedbackResponse, 'count', async () => 5);
  const update = stubMethod(prisma.eventFeedbackForm, 'update', async ({ data }) => form(data));

  const res = await request(app).patch('/api/feedback/events/evt-1/form').set('Authorization', auth('btc-1'))
    .send({ isOpen: false });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(update.calls[0][0].data, { isOpen: false });
});

test('không tắt được ẩn danh khi form ẩn danh đã có phiếu, nhưng bật thì được', async () => {
  loginAs();
  ownedEvent();
  stubMethod(prisma.eventFeedbackForm, 'findUnique', async () => form({ isAnonymous: true }));
  stubMethod(prisma.feedbackResponse, 'count', async () => 1);
  const update = stubMethod(prisma.eventFeedbackForm, 'update', async ({ data }) => form(data));

  const res = await request(app).patch('/api/feedback/events/evt-1/form').set('Authorization', auth('btc-1'))
    .send({ isAnonymous: false });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error, 'FEEDBACK_ANONYMITY_LOCKED');
  assert.strictEqual(update.calls.length, 0);

  restoreStubs();
  loginAs();
  ownedEvent();
  stubMethod(prisma.eventFeedbackForm, 'findUnique', async () => form({ isAnonymous: false }));
  stubMethod(prisma.feedbackResponse, 'count', async () => 1);
  const update2 = stubMethod(prisma.eventFeedbackForm, 'update', async ({ data }) => form(data));
  const turnOn = await request(app).patch('/api/feedback/events/evt-1/form').set('Authorization', auth('btc-1'))
    .send({ isAnonymous: true });
  assert.strictEqual(turnOn.status, 200);
  assert.deepStrictEqual(update2.calls[0][0].data, { isAnonymous: true });
});

test('PATCH với giá trị không phải boolean → 400', async () => {
  loginAs();
  ownedEvent();
  stubMethod(prisma.eventFeedbackForm, 'findUnique', async () => form());
  const res = await request(app).patch('/api/feedback/events/evt-1/form').set('Authorization', auth('btc-1'))
    .send({ isOpen: 'yes' });
  assert.strictEqual(res.status, 400);
});

test('kết quả form ẩn danh: không select user từ DB và không trả thông tin người gửi', async () => {
  loginAs();
  ownedEvent();
  stubMethod(prisma.eventFeedbackForm, 'findUnique', async () => form({ isAnonymous: true }));
  stubMethod(prisma.attendance, 'count', async () => 10);
  const findMany = stubMethod(prisma.feedbackResponse, 'findMany', async () => [
    { answers: { q1: 5, q2: 'Hay' }, updatedAt: new Date() },
    { answers: { q1: 3 }, updatedAt: new Date() },
  ]);

  const res = await request(app).get('/api/feedback/events/evt-1/results').set('Authorization', auth('btc-1'));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(findMany.calls[0][0].select.user, undefined);
  assert.strictEqual(res.body.data.eligibleCount, 10);
  assert.strictEqual(res.body.data.responseCount, 2);
  assert.strictEqual(res.body.data.questions[0].average, 4);
  assert.strictEqual(res.body.data.responses, undefined);
  assert.doesNotMatch(JSON.stringify(res.body), /SE1|"name"/);
});

// ── Người tham dự gửi phiếu ─────────────────────────────────────

test('gửi phiếu khi form đang đóng → 403 FEEDBACK_CLOSED', async () => {
  loginAs();
  respondentContext({ formRow: form({ isOpen: false }) });
  const upsert = stubMethod(prisma.feedbackResponse, 'upsert', async () => ({}));
  const res = await request(app).post('/api/feedback/events/evt-1/response').set('Authorization', auth('stu-1'))
    .send({ answers: { q1: 5 } });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'FEEDBACK_CLOSED');
  assert.strictEqual(upsert.calls.length, 0);
});

test('chỉ check-in mà chưa check-out → 403 FEEDBACK_NOT_ELIGIBLE', async () => {
  for (const status of ['CHECKED_IN', 'REGISTERED', null]) {
    restoreStubs();
    loginAs();
    respondentContext({ status });
    const upsert = stubMethod(prisma.feedbackResponse, 'upsert', async () => ({}));
    const res = await request(app).post('/api/feedback/events/evt-1/response').set('Authorization', auth('stu-1'))
      .send({ answers: { q1: 5 } });
    assert.strictEqual(res.status, 403, `status=${status}`);
    assert.strictEqual(res.body.error, 'FEEDBACK_NOT_ELIGIBLE');
    assert.strictEqual(upsert.calls.length, 0);
  }
});

test('sự kiện chưa có form → 404 FEEDBACK_NOT_FOUND', async () => {
  loginAs();
  respondentContext({ formRow: null });
  const res = await request(app).post('/api/feedback/events/evt-1/response').set('Authorization', auth('stu-1'))
    .send({ answers: { q1: 5 } });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'FEEDBACK_NOT_FOUND');
});

test('câu trả lời sai → 400 INVALID_ANSWERS', async () => {
  loginAs();
  respondentContext();
  const res = await request(app).post('/api/feedback/events/evt-1/response').set('Authorization', auth('stu-1'))
    .send({ answers: { q1: 9 } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'INVALID_ANSWERS');
});

test('người đã check-out gửi phiếu hợp lệ → lưu đúng câu trả lời đã chuẩn hoá', async () => {
  loginAs();
  respondentContext();
  const upsert = stubMethod(prisma.feedbackResponse, 'upsert', async ({ create }) => ({ answers: create.answers, updatedAt: new Date() }));
  const res = await request(app).post('/api/feedback/events/evt-1/response').set('Authorization', auth('stu-1'))
    .send({ answers: { q1: 4, q2: '  Rất bổ ích ', extra: 'bỏ' } });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.updated, false);
  const args = upsert.calls[0][0];
  assert.deepStrictEqual(args.where, { formId_userId: { formId: 'form-1', userId: 'stu-1' } });
  assert.deepStrictEqual(args.create.answers, { q1: 4, q2: 'Rất bổ ích' });
});

test('gửi lại khi đã có phiếu → cập nhật phiếu cũ (200)', async () => {
  loginAs();
  respondentContext({ existing: { id: 'resp-1' } });
  stubMethod(prisma.feedbackResponse, 'upsert', async ({ update }) => ({ answers: update.answers, updatedAt: new Date() }));
  const res = await request(app).post('/api/feedback/events/evt-1/response').set('Authorization', auth('stu-1'))
    .send({ answers: { q1: 2 } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.updated, true);
});

test('GET phiếu của tôi: trả form, phiếu cũ và lý do không gửi được', async () => {
  loginAs();
  respondentContext({ status: 'CHECKED_IN', existing: null });
  const res = await request(app).get('/api/feedback/events/evt-1/response').set('Authorization', auth('stu-1'));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.canSubmit, false);
  assert.strictEqual(res.body.data.reason, 'FEEDBACK_NOT_ELIGIBLE');
  assert.strictEqual(res.body.data.form.questions.length, 2);
  assert.strictEqual(res.body.data.myResponse, null);
});

// ── Danh sách sự kiện của sinh viên ─────────────────────────────

// ── Hiện form ngay sau khi quét mã check-out ────────────────────

const qrService = require('../src/services/qr.service');

function checkoutScan({ attendanceRow, formRow, existing = null, formLookup = async () => formRow }) {
  loginAs();
  stubMethod(prisma.event, 'findUnique', async () => ({
    id: 'evt-1', name: 'Hội thảo', location: 'A1', isActive: true, isWhitelisted: false, gpsEnabled: false,
    checkinOpen: new Date(Date.now() - 3600e3), checkinClose: new Date(Date.now() + 3600e3),
    checkoutOpen: new Date(Date.now() - 3600e3), checkoutClose: new Date(Date.now() + 3600e3),
    lat: null, lng: null, radius: 100,
  }));
  stubMethod(prisma.deviceBinding, 'findFirst', async () => ({ id: 'b1', isTrusted: true }));
  stubMethod(prisma.attendance, 'findUnique', async () => attendanceRow);
  stubMethod(prisma.attendance, 'update', async () => ({ ...attendanceRow, status: 'CHECKED_OUT' }));
  stubMethod(prisma.eventFeedbackForm, 'findUnique', formLookup);
  stubMethod(prisma.feedbackResponse, 'findUnique', async () => existing);
  return request(app).post('/api/checkin').set('Authorization', auth('stu-1')).send({
    eventId: 'evt-1', token: qrService.generateToken('evt-1', 'checkout'), type: 'checkout', gps: null, deviceId: 'dev-1',
  });
}

const CHECKED_IN = { id: 'a1', checkinTime: new Date(), checkoutTime: null, status: 'CHECKED_IN' };

test('check-out thành công + form đang mở → response báo cần đánh giá', async () => {
  const res = await checkoutScan({ attendanceRow: CHECKED_IN, formRow: { id: 'form-1', isOpen: true } });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.feedback, { isOpen: true, submitted: false });
});

test('check-out thành công nhưng form đang đóng hoặc chưa có → không kèm feedback', async () => {
  for (const formRow of [{ id: 'form-1', isOpen: false }, null]) {
    restoreStubs();
    const res = await checkoutScan({ attendanceRow: CHECKED_IN, formRow });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.feedback, undefined);
  }
});

test('lỗi tra cứu form không làm hỏng lượt check-out đã ghi', async () => {
  const broken = await checkoutScan({
    attendanceRow: CHECKED_IN,
    formLookup: async () => { throw new Error('db down'); },
  });
  assert.strictEqual(broken.status, 200);
  assert.strictEqual(broken.body.success, true);
  assert.strictEqual(broken.body.feedback, undefined);
});

test('quét lại mã check-out khi đã check-out → vẫn kèm form nếu chưa đánh giá', async () => {
  const done = { ...CHECKED_IN, checkoutTime: new Date(), status: 'CHECKED_OUT' };
  const res = await checkoutScan({ attendanceRow: done, formRow: { id: 'form-1', isOpen: true } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'ALREADY_CHECKED_OUT');
  assert.deepStrictEqual(res.body.feedback, { isOpen: true, submitted: false });

  restoreStubs();
  const submitted = await checkoutScan({ attendanceRow: done, formRow: { id: 'form-1', isOpen: true }, existing: { id: 'r1' } });
  assert.deepStrictEqual(submitted.body.feedback, { isOpen: true, submitted: true });
});
