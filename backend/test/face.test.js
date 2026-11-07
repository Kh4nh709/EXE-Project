const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const prisma = require('../src/lib/prisma');
const app = require('../src/app');
const { stubMethod, restoreStubs } = require('../testenv');
const face = require('../src/lib/faceProfile');

afterEach(() => restoreStubs());

const btcToken = jwt.sign({ userId: 'btc-1' }, process.env.JWT_SECRET);
const BTC_USER = { id: 'btc-1', mssv: null, email: 'btc@b.c', name: 'BTC One', role: 'BTC', isActive: true, isFirstLogin: false };
const adminToken = jwt.sign({ userId: 'admin-1' }, process.env.JWT_SECRET);
const ADMIN = { id: 'admin-1', mssv: null, email: 'a@b.c', name: 'Admin', role: 'ADMIN', isActive: true, isFirstLogin: false };

// Vector giả lập: mỗi "người" là một hướng khác nhau; noise nhỏ = cùng người, ảnh khác.
// Giả ngẫu nhiên có seed (LCG) để mỗi người là một vector độc lập, lặp lại được.
function vectorFor(seed, noise = 0) {
  const v = new Float32Array(face.EMBEDDING_DIM);
  let x = seed * 7919;
  for (let i = 0; i < v.length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    v[i] = (x / 2147483648 - 0.5) + noise * Math.cos(i * 1.7);
  }
  return v;
}
const b64 = (v) => Buffer.from(v.buffer).toString('base64');
const bytes = (v) => Buffer.from(v.buffer);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString('base64');

function openEvent(overrides = {}) {
  return {
    id: 'evt-1', kind: 'STANDARD', createdById: 'btc-1', isActive: true,
    checkinState: 'OPEN', checkoutState: 'AUTO',
    checkinOpen: null, checkinClose: null, checkoutOpen: null, checkoutClose: null,
    ...overrides,
  };
}
const activeProfile = { model: face.FACE_MODEL, consentAt: new Date() };

// ── lib ──────────────────────────────────────────────────────────

test('similarity: identical = 1, same person with small noise > threshold, different people < threshold', () => {
  const a = Array.from(vectorFor(1));
  assert.strictEqual(face.similarity(a, a), 1);
  assert.ok(face.similarity(a, Array.from(vectorFor(1, 0.02))) > face.DUPLICATE_THRESHOLD);
  assert.ok(face.similarity(a, Array.from(vectorFor(2))) < face.SELF_VS_IMPORT_THRESHOLD);
});

test('decodeEmbedding rejects wrong length, NaN and all-zero vectors', () => {
  assert.ok(face.decodeEmbedding(b64(vectorFor(1))).buffer);
  assert.ok(face.decodeEmbedding(Buffer.alloc(16).toString('base64')).error);
  const nan = vectorFor(1); nan[5] = NaN;
  assert.ok(face.decodeEmbedding(b64(nan)).error);
  assert.ok(face.decodeEmbedding(b64(new Float32Array(face.EMBEDDING_DIM))).error);
  assert.ok(face.decodeEmbedding(undefined).error);
});

test('decodeThumbnail accepts only small JPEG', () => {
  assert.strictEqual(face.decodeThumbnail(undefined).buffer, null);
  assert.ok(face.decodeThumbnail(JPEG).buffer);
  assert.ok(face.decodeThumbnail(Buffer.from('PNG...').toString('base64')).error);
  const big = Buffer.alloc(30 * 1024); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  assert.ok(face.decodeThumbnail(big.toString('base64')).error);
});

test('findDuplicateIn ignores the same user and finds a lookalike of another', () => {
  const profiles = [{ userId: 'u1', vector: Array.from(vectorFor(1)) }, { userId: 'u2', vector: Array.from(vectorFor(2)) }];
  const probe = Array.from(vectorFor(1, 0.02));
  assert.strictEqual(face.findDuplicateIn(probe, profiles, 'u1'), null);
  assert.strictEqual(face.findDuplicateIn(probe, profiles, 'u3').userId, 'u1');
});

// ── sinh viên tự đăng ký ─────────────────────────────────────────

// ── admin import ─────────────────────────────────────────────────

test('admin import: imports as active, skips unknown MSSV, self-enrolled students and duplicates', async () => {
  stubMethod(prisma.user, 'findUnique', async () => ADMIN);
  stubMethod(prisma.user, 'findMany', async () => [
    { id: 'u1', mssv: 'SE1', faceProfile: null },
    { id: 'u2', mssv: 'se2', faceProfile: { source: 'SELF', model: face.FACE_MODEL, consentAt: new Date() } },
    { id: 'u3', mssv: 'SE3', faceProfile: null },
  ]);
  stubMethod(prisma.faceProfile, 'findMany', async () => []);
  const upsert = stubMethod(prisma.faceProfile, 'upsert', async () => ({}));

  const res = await request(app).post('/api/admin/face-profiles/import').set('Authorization', `Bearer ${adminToken}`)
    .send({
      items: [
        { mssv: 'se1', embedding: b64(vectorFor(1)), thumbnail: JPEG },
        { mssv: 'SE2', embedding: b64(vectorFor(2)) },
        { mssv: 'SE9', embedding: b64(vectorFor(9)) },
        // Cùng mặt với SE1 vừa nhập trong lô → bị chặn.
        { mssv: 'SE3', embedding: b64(vectorFor(1, 0.02)) },
      ],
    });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.updated, 1);
  assert.deepStrictEqual(res.body.data.skipped.map((s) => s.mssv), ['SE2', 'SE9', 'SE3']);
  const { create } = upsert.calls[0][0];
  assert.strictEqual(create.source, 'IMPORT');
  assert.ok(create.consentAt instanceof Date);
  assert.ok(create.importEmbedding);
});

test('admin import: overwrite=true replaces a self-enrolled photo and stays active', async () => {
  stubMethod(prisma.user, 'findUnique', async () => ADMIN);
  stubMethod(prisma.user, 'findMany', async () => [
    { id: 'u2', mssv: 'SE2', faceProfile: { source: 'SELF', model: face.FACE_MODEL, consentAt: new Date() } },
  ]);
  stubMethod(prisma.faceProfile, 'findMany', async () => [{ userId: 'u2', embedding: bytes(vectorFor(5)) }]);
  const upsert = stubMethod(prisma.faceProfile, 'upsert', async () => ({}));

  const res = await request(app).post('/api/admin/face-profiles/import').set('Authorization', `Bearer ${adminToken}`)
    .send({ overwrite: true, items: [{ mssv: 'SE2', embedding: b64(vectorFor(2)) }] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.updated, 1);
  const { update } = upsert.calls[0][0];
  assert.strictEqual(update.source, 'IMPORT');
  assert.ok(update.consentAt instanceof Date);
});

// ── admin quản lý ảnh từng người ─────────────────────────────────

const byId = (target) => async ({ where }) => (where.id === 'admin-1' ? ADMIN : target);

test('admin get user face: returns status and thumbnail, none when absent', async () => {
  stubMethod(prisma.user, 'findUnique', async () => ADMIN);
  stubMethod(prisma.faceProfile, 'findUnique', async ({ where }) => (where.userId === 'u1'
    ? { userId: 'u1', model: face.FACE_MODEL, source: 'SELF', consentAt: new Date(), updatedAt: new Date(), thumbnail: Buffer.from(JPEG, 'base64') }
    : null));
  const ok = await request(app).get('/api/admin/users/u1/face-profile').set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.data.status, 'active');
  assert.strictEqual(ok.body.data.thumbnail, JPEG);
  const none = await request(app).get('/api/admin/users/u9/face-profile').set('Authorization', `Bearer ${adminToken}`);
  assert.deepStrictEqual(none.body.data, { status: 'none' });
});

test('admin set user face: overwrites as IMPORT, active immediately', async () => {
  stubMethod(prisma.user, 'findUnique', byId({ id: 'u1', role: 'STUDENT' }));
  stubMethod(prisma.faceProfile, 'findMany', async () => []);
  const upsert = stubMethod(prisma.faceProfile, 'upsert', async ({ update }) => ({ ...update, updatedAt: new Date() }));
  const res = await request(app).put('/api/admin/users/u1/face-profile').set('Authorization', `Bearer ${adminToken}`)
    .send({ embedding: b64(vectorFor(1)), thumbnail: JPEG });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.status, 'active');
  const { update, where } = upsert.calls[0][0];
  assert.strictEqual(where.userId, 'u1');
  assert.strictEqual(update.source, 'IMPORT');
  assert.ok(update.consentAt instanceof Date);
  assert.ok(update.importEmbedding);
});

test('admin set user face: rejects non-students, unknown users and lookalikes of another account', async () => {
  stubMethod(prisma.user, 'findUnique', byId({ id: 'b1', role: 'BTC' }));
  const btc = await request(app).put('/api/admin/users/b1/face-profile').set('Authorization', `Bearer ${adminToken}`)
    .send({ embedding: b64(vectorFor(1)) });
  assert.strictEqual(btc.body.error, 'FACE_STUDENT_ONLY');
  restoreStubs();

  stubMethod(prisma.user, 'findUnique', byId(null));
  const missing = await request(app).put('/api/admin/users/x/face-profile').set('Authorization', `Bearer ${adminToken}`)
    .send({ embedding: b64(vectorFor(1)) });
  assert.strictEqual(missing.status, 404);
  restoreStubs();

  stubMethod(prisma.user, 'findUnique', byId({ id: 'u1', role: 'STUDENT' }));
  stubMethod(prisma.faceProfile, 'findMany', async () => [{ userId: 'u2', embedding: bytes(vectorFor(2)) }]);
  const upsert = stubMethod(prisma.faceProfile, 'upsert', async () => ({}));
  const dup = await request(app).put('/api/admin/users/u1/face-profile').set('Authorization', `Bearer ${adminToken}`)
    .send({ embedding: b64(vectorFor(2, 0.02)) });
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(dup.body.error, 'FACE_DUPLICATE');
  assert.strictEqual(upsert.calls.length, 0);
});

test('admin delete user face: deletes, 404 when there is none', async () => {
  stubMethod(prisma.user, 'findUnique', async () => ADMIN);
  let count = 1;
  const del = stubMethod(prisma.faceProfile, 'deleteMany', async () => ({ count }));
  const ok = await request(app).delete('/api/admin/users/u1/face-profile').set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(del.calls[0][0], { where: { userId: 'u1' } });
  count = 0;
  const none = await request(app).delete('/api/admin/users/u1/face-profile').set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(none.status, 404);
});

test('admin face endpoints are ADMIN-only', async () => {
  stubMethod(prisma.user, 'findUnique', async () => BTC_USER);
  const res = await request(app).delete('/api/admin/users/u1/face-profile').set('Authorization', `Bearer ${btcToken}`);
  assert.strictEqual(res.status, 403);
});

// ── BTC đặt khuôn mặt cho người trong danh sách sự kiện của mình ─────────────

function participantFace({ member = true, event = openEvent() } = {}) {
  stubMethod(prisma.user, 'findUnique', async ({ where }) => (where.id === 'btc-1' ? BTC_USER : { id: where.id, role: 'STUDENT' }));
  stubMethod(prisma.event, 'findUnique', async () => event);
  stubMethod(prisma.eventMember, 'findUnique', async () => (member ? { userId: 'u1' } : null));
  stubMethod(prisma.faceProfile, 'findMany', async () => []);
  return stubMethod(prisma.faceProfile, 'upsert', async ({ update }) => ({ ...update, updatedAt: new Date() }));
}

test('BTC sets a face for someone on their event list — active immediately', async () => {
  const upsert = participantFace();
  const res = await request(app).put('/api/events/evt-1/members/u1/face-profile').set('Authorization', `Bearer ${btcToken}`)
    .send({ embedding: b64(vectorFor(1)), thumbnail: JPEG });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.status, 'active');
  assert.strictEqual(upsert.calls[0][0].where.userId, 'u1');
});

test('BTC cannot set a face for someone outside the event list', async () => {
  const upsert = participantFace({ member: false });
  const res = await request(app).put('/api/events/evt-1/members/u1/face-profile').set('Authorization', `Bearer ${btcToken}`)
    .send({ embedding: b64(vectorFor(1)), thumbnail: JPEG });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'NOT_A_MEMBER');
  assert.strictEqual(upsert.calls.length, 0);
});

test('BTC cannot manage faces on an event they did not create', async () => {
  const upsert = participantFace({ event: openEvent({ createdById: 'btc-2' }) });
  const res = await request(app).put('/api/events/evt-1/members/u1/face-profile').set('Authorization', `Bearer ${btcToken}`)
    .send({ embedding: b64(vectorFor(1)), thumbnail: JPEG });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(upsert.calls.length, 0);
});

test('admin import: rejects batches over the cap', async () => {
  stubMethod(prisma.user, 'findUnique', async () => ADMIN);
  const items = Array.from({ length: face.MAX_IMPORT_ITEMS + 1 }, (_, i) => ({ mssv: `SE${i}` }));
  const res = await request(app).post('/api/admin/face-profiles/import').set('Authorization', `Bearer ${adminToken}`).send({ items });
  assert.strictEqual(res.status, 400);
});

// ── kiosk ────────────────────────────────────────────────────────

test('gallery: only members with an active profile of the current model are sent', async () => {
  stubMethod(prisma.user, 'findUnique', async () => BTC_USER);
  stubMethod(prisma.event, 'findUnique', async () => openEvent());
  stubMethod(prisma.eventMember, 'findMany', async () => [
    { user: { id: 'u1', name: 'A', mssv: 'SE1', faceProfile: { embedding: bytes(vectorFor(1)), ...activeProfile } } },
    { user: { id: 'u2', name: 'B', mssv: 'SE2', faceProfile: { embedding: bytes(vectorFor(2)), model: face.FACE_MODEL, consentAt: null } } },
    { user: { id: 'u3', name: 'C', mssv: 'SE3', faceProfile: { embedding: bytes(vectorFor(3)), model: 'old-model', consentAt: new Date() } } },
    { user: { id: 'u4', name: 'D', mssv: 'SE4', faceProfile: null } },
  ]);
  stubMethod(prisma.attendance, 'findMany', async () => [{ userId: 'u1' }]);

  const res = await request(app).get('/api/events/evt-1/face-gallery').set('Authorization', `Bearer ${btcToken}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.totalMembers, 4);
  assert.strictEqual(res.body.data.withFace, 1);
  assert.deepStrictEqual(res.body.data.people.map((p) => [p.userId, p.checkedIn]), [['u1', true]]);
  assert.ok(res.body.data.gate.checkin);
});

test('gallery: non-owner BTC → 403, invitation event → 400', async () => {
  stubMethod(prisma.user, 'findUnique', async () => BTC_USER);
  const ev = stubMethod(prisma.event, 'findUnique', async () => openEvent({ createdById: 'btc-2' }));
  let res = await request(app).get('/api/events/evt-1/face-gallery').set('Authorization', `Bearer ${btcToken}`);
  assert.strictEqual(res.status, 403);
  restoreStubs();
  stubMethod(prisma.user, 'findUnique', async () => BTC_USER);
  stubMethod(prisma.event, 'findUnique', async () => openEvent({ kind: 'INVITATION' }));
  res = await request(app).get('/api/events/evt-1/face-gallery').set('Authorization', `Bearer ${btcToken}`);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'INVITATION_EVENT');
  assert.ok(ev);
});

function kioskCheckin(body = { userId: 'u1' }) {
  return request(app).post('/api/events/evt-1/face-checkin').set('Authorization', `Bearer ${btcToken}`).send(body);
}

test('face-checkin: non-member → 403 NOT_REGISTERED, nothing written', async () => {
  stubMethod(prisma.user, 'findUnique', async () => BTC_USER);
  stubMethod(prisma.event, 'findUnique', async () => openEvent());
  stubMethod(prisma.eventMember, 'findUnique', async () => null);
  stubMethod(prisma.faceProfile, 'findUnique', async () => activeProfile);
  const update = stubMethod(prisma.attendance, 'updateMany', async () => ({ count: 1 }));
  const res = await kioskCheckin();
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'NOT_REGISTERED');
  assert.strictEqual(update.calls.length, 0);
});

test('face-checkin: closed gate is enforced', async () => {
  stubMethod(prisma.user, 'findUnique', async () => BTC_USER);
  stubMethod(prisma.event, 'findUnique', async () => openEvent({ checkinState: 'CLOSED' }));
  stubMethod(prisma.eventMember, 'findUnique', async () => ({ user: { id: 'u1', name: 'A', mssv: 'SE1' } }));
  stubMethod(prisma.faceProfile, 'findUnique', async () => activeProfile);
  const update = stubMethod(prisma.attendance, 'updateMany', async () => ({ count: 1 }));
  const res = await kioskCheckin();
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'ATTENDANCE_CLOSED');
  assert.strictEqual(update.calls.length, 0);
});

test('face-checkin: withdrawn consent → FACE_NOT_FOUND', async () => {
  stubMethod(prisma.user, 'findUnique', async () => BTC_USER);
  stubMethod(prisma.event, 'findUnique', async () => openEvent());
  stubMethod(prisma.eventMember, 'findUnique', async () => ({ user: { id: 'u1', name: 'A', mssv: 'SE1' } }));
  stubMethod(prisma.faceProfile, 'findUnique', async () => null);
  const res = await kioskCheckin();
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'FACE_NOT_FOUND');
});

test('face-checkin: success marks CHECKED_IN with deviceId FACE, conditional on checkinTime null', async () => {
  stubMethod(prisma.user, 'findUnique', async () => BTC_USER);
  stubMethod(prisma.event, 'findUnique', async () => openEvent());
  stubMethod(prisma.eventMember, 'findUnique', async () => ({ user: { id: 'u1', name: 'A', mssv: 'SE1' } }));
  stubMethod(prisma.faceProfile, 'findUnique', async () => activeProfile);
  const update = stubMethod(prisma.attendance, 'updateMany', async () => ({ count: 1 }));
  const res = await kioskCheckin();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.name, 'A');
  const args = update.calls[0][0];
  assert.strictEqual(args.where.checkinTime, null);
  assert.strictEqual(args.data.status, 'CHECKED_IN');
  assert.strictEqual(args.data.deviceId, 'FACE');
});

test('face-checkin: second scan of the same person → ALREADY_CHECKED_IN', async () => {
  stubMethod(prisma.user, 'findUnique', async () => BTC_USER);
  stubMethod(prisma.event, 'findUnique', async () => openEvent());
  stubMethod(prisma.eventMember, 'findUnique', async () => ({ user: { id: 'u1', name: 'A', mssv: 'SE1' } }));
  stubMethod(prisma.faceProfile, 'findUnique', async () => activeProfile);
  stubMethod(prisma.attendance, 'updateMany', async () => ({ count: 0 }));
  stubMethod(prisma.attendance, 'findUnique', async () => ({ checkinTime: new Date() }));
  const create = stubMethod(prisma.attendance, 'create', async () => ({}));
  const res = await kioskCheckin();
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'ALREADY_CHECKED_IN');
  assert.strictEqual(create.calls.length, 0);
});
