const prisma = require('../lib/prisma');
const { loadEventForWrite } = require('../lib/eventAccess');
const { gateRejection, gateSummary } = require('../lib/attendanceGate');
const { fmtTime } = require('../lib/datetime');
const {
  FACE_MODEL, MAX_IMPORT_ITEMS,
  decodeEmbedding, decodeThumbnail,
  isActiveProfile, profileStatus, adminProfileData, loadProfileVectors, findDuplicateIn, findDuplicate,
} = require('../lib/faceProfile');
const { rejectNonStandardEvent } = require('./event.controller');

function base64(bytes) {
  return bytes ? Buffer.from(bytes).toString('base64') : null;
}

// ───────────────────────────────────────────────────────────────
// Admin import ảnh thẻ theo lô (theo MSSV/email)
// ───────────────────────────────────────────────────────────────

async function importFaceProfiles(req, res) {
  try {
    const items = req.body?.items;
    // Mặc định không đè ảnh sinh viên tự chụp; admin chủ động tick "ghi đè" khi cần thay
    // hàng loạt (vd sinh viên tự chụp ảnh mờ, nhà trường cấp ảnh thẻ mới).
    const overwrite = req.body?.overwrite === true;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Danh sách ảnh không hợp lệ' });
    }
    if (items.length > MAX_IMPORT_ITEMS) {
      return res.status(400).json({ success: false, message: `Chỉ xử lý tối đa ${MAX_IMPORT_ITEMS} ảnh mỗi lần.` });
    }

    const mssvs = [...new Set(items.map((i) => (typeof i?.mssv === 'string' ? i.mssv.trim().toUpperCase() : '')).filter(Boolean))];
    const users = await prisma.user.findMany({
      // MSSV trong DB lưu nguyên văn lúc nhập (có thể chữ thường) — so không phân biệt hoa thường.
      where: { role: 'STUDENT', OR: mssvs.map((m) => ({ mssv: { equals: m, mode: 'insensitive' } })) },
      select: { id: true, mssv: true, faceProfile: { select: { source: true, model: true, consentAt: true } } },
    });
    const byMssv = new Map(users.map((u) => [u.mssv.toUpperCase(), u]));
    const known = await loadProfileVectors();

    let updated = 0;
    const skipped = [];
    const seen = new Set();
    for (const item of items) {
      const mssv = typeof item?.mssv === 'string' ? item.mssv.trim().toUpperCase() : '';
      const skip = (reason) => skipped.push({ mssv: mssv || '(trống)', reason });
      if (!mssv) { skip('Thiếu MSSV'); continue; }
      if (seen.has(mssv)) { skip('MSSV lặp lại trong lô'); continue; }
      seen.add(mssv);

      const user = byMssv.get(mssv);
      if (!user) { skip('Không tìm thấy sinh viên với MSSV này'); continue; }
      // Sinh viên đã tự chụp và đang dùng — ảnh tự chụp mới hơn ảnh thẻ, đừng ghi đè.
      if (!overwrite && user.faceProfile?.source === 'SELF' && isActiveProfile(user.faceProfile)) {
        skip('Sinh viên đã tự đăng ký khuôn mặt'); continue;
      }
      const embedding = decodeEmbedding(item.embedding);
      if (embedding.error) { skip(embedding.error); continue; }
      const thumbnail = decodeThumbnail(item.thumbnail);
      if (thumbnail.error) { skip(thumbnail.error); continue; }
      if (findDuplicateIn(embedding.vector, known, user.id)) {
        skip('Quá giống khuôn mặt của một sinh viên khác'); continue;
      }

      const data = adminProfileData(embedding, thumbnail);
      await prisma.faceProfile.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
      // Ảnh sau trong cùng lô cũng phải so với ảnh vừa ghi.
      const idx = known.findIndex((k) => k.userId === user.id);
      if (idx >= 0) known.splice(idx, 1);
      known.push({ userId: user.id, vector: embedding.vector });
      updated += 1;
    }

    return res.json({ success: true, data: { updated, skipped } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// ───────────────────────────────────────────────────────────────
// Admin xem / thay / xoá khuôn mặt của từng người (trang Quản lý người dùng)
// ───────────────────────────────────────────────────────────────

function adminFaceView(profile) {
  const status = profileStatus(profile);
  if (status === 'none') return { status };
  return {
    status,
    source: profile.source,
    consentAt: profile.consentAt,
    updatedAt: profile.updatedAt,
    thumbnail: base64(profile.thumbnail),
  };
}

// Ba thao tác dùng chung cho admin (theo người) và BTC (theo người trong sự kiện của mình).
async function sendFace(userId, res) {
  const profile = await prisma.faceProfile.findUnique({ where: { userId } });
  return res.json({ success: true, data: adminFaceView(profile) });
}

// Thay ảnh của một người. Vẫn chặn mặt trùng người khác như mọi lần ghi — chống một
// người được đăng ký hai lần để điểm danh hộ.
async function writeFace(userId, body, res) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
  if (!user) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND', message: 'Không tìm thấy người này' });
  // Check-in khuôn mặt dành cho người tham gia, không phải tài khoản ADMIN/BTC.
  if (user.role !== 'STUDENT') {
    return res.status(400).json({
      success: false, error: 'FACE_STUDENT_ONLY',
      message: 'Chỉ đặt được ảnh khuôn mặt cho người tham gia.',
    });
  }
  const embedding = decodeEmbedding(body?.embedding);
  if (embedding.error) return res.status(400).json({ success: false, error: 'FACE_INVALID', message: embedding.error });
  const thumbnail = decodeThumbnail(body?.thumbnail);
  if (thumbnail.error) return res.status(400).json({ success: false, error: 'FACE_INVALID', message: thumbnail.error });

  if (await findDuplicate(embedding.vector, user.id)) {
    return res.status(409).json({
      success: false, error: 'FACE_DUPLICATE',
      message: 'Khuôn mặt trong ảnh quá giống khuôn mặt đã đăng ký của một người khác.',
    });
  }

  const data = adminProfileData(embedding, thumbnail);
  const profile = await prisma.faceProfile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, ...data },
    update: data,
  });
  return res.json({
    success: true,
    message: 'Đã cập nhật ảnh khuôn mặt. Kiosk dùng ảnh này ngay.',
    data: adminFaceView(profile),
  });
}

async function removeFace(userId, res) {
  const result = await prisma.faceProfile.deleteMany({ where: { userId } });
  if (result.count === 0) {
    return res.status(404).json({ success: false, error: 'FACE_NOT_FOUND', message: 'Người này chưa có ảnh khuôn mặt.' });
  }
  return res.json({ success: true, message: 'Đã xoá ảnh khuôn mặt.' });
}

const faceHandler = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (err) {
    console.error('Face profile error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
};

const getUserFaceProfile = faceHandler((req, res) => sendFace(req.params.id, res));
const setUserFaceProfile = faceHandler((req, res) => writeFace(req.params.id, req.body, res));
const deleteUserFaceProfile = faceHandler((req, res) => removeFace(req.params.id, res));

// BTC (ADMIN hoặc người tạo sự kiện) quản lý khuôn mặt của người trong danh sách tham
// gia sự kiện mình — để dùng kiosk khuôn mặt. Người tham gia dùng chung theo email nên
// ảnh đặt ở đây cũng dùng được ở sự kiện khác có người đó (product owner chấp nhận).
async function loadParticipant(req, res) {
  const event = await loadEventForWrite(req, res);
  if (!event) return null;
  const member = await prisma.eventMember.findUnique({
    where: { eventId_userId: { eventId: event.id, userId: req.params.userId } },
    select: { userId: true },
  });
  if (!member) {
    res.status(404).json({
      success: false, error: 'NOT_A_MEMBER',
      message: 'Người này không có trong danh sách tham gia sự kiện.',
    });
    return null;
  }
  return member.userId;
}

const getParticipantFace = faceHandler(async (req, res) => {
  const userId = await loadParticipant(req, res);
  return userId ? sendFace(userId, res) : undefined;
});
const setParticipantFace = faceHandler(async (req, res) => {
  const userId = await loadParticipant(req, res);
  return userId ? writeFace(userId, req.body, res) : undefined;
});
const deleteParticipantFace = faceHandler(async (req, res) => {
  const userId = await loadParticipant(req, res);
  return userId ? removeFace(userId, res) : undefined;
});

// ───────────────────────────────────────────────────────────────
// Kiosk check-in bằng khuôn mặt của BTC
// ───────────────────────────────────────────────────────────────

// Kiosk so khớp trong trình duyệt nên cần vector của mọi thành viên có khuôn mặt hợp lệ.
// Thumbnail không gửi kèm (vài trăm người × vài KB) — kiosk tải riêng khi khớp ai đó.
async function getFaceGallery(req, res) {
  try {
    const event = await loadEventForWrite(req, res);
    if (!event) return;
    if (rejectNonStandardEvent(event, res)) return;

    const [members, checkedIn] = await Promise.all([
      prisma.eventMember.findMany({
        where: { eventId: event.id },
        select: {
          user: {
            select: {
              id: true, name: true, mssv: true,
              faceProfile: { select: { embedding: true, model: true, consentAt: true } },
            },
          },
        },
      }),
      prisma.attendance.findMany({
        where: { eventId: event.id, checkinTime: { not: null } },
        select: { userId: true },
      }),
    ]);
    const checkedInIds = new Set(checkedIn.map((a) => a.userId));
    const people = members
      .filter((m) => isActiveProfile(m.user.faceProfile))
      .map(({ user }) => ({
        userId: user.id,
        name: user.name,
        mssv: user.mssv,
        embedding: base64(user.faceProfile.embedding),
        checkedIn: checkedInIds.has(user.id),
      }));

    return res.json({
      success: true,
      data: {
        model: FACE_MODEL,
        gate: gateSummary(event),
        totalMembers: members.length,
        withFace: people.length,
        people,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function getFaceThumbnail(req, res) {
  try {
    const event = await loadEventForWrite(req, res);
    if (!event) return;
    const { userId } = req.params;
    const [membership, profile] = await Promise.all([
      prisma.eventMember.findUnique({ where: { eventId_userId: { eventId: event.id, userId } } }),
      prisma.faceProfile.findUnique({ where: { userId }, select: { thumbnail: true, model: true, consentAt: true } }),
    ]);
    if (!membership || !isActiveProfile(profile) || !profile.thumbnail) {
      return res.status(404).json({ success: false, error: 'FACE_NOT_FOUND', message: 'Không có ảnh' });
    }
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    return res.send(Buffer.from(profile.thumbnail));
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// Kiosk đã khớp xong (tự động hoặc BTC bấm xác nhận) → chấm check-in. Server tin kết quả
// khớp: kiosk chạy dưới tài khoản BTC, mà BTC vốn đã check-in tay được bất kỳ ai.
// Khác check-in tay ở chỗ VẪN áp cổng điểm danh, vì kiosk chạy tự động không người bấm.
async function faceCheckin(req, res) {
  try {
    const event = await loadEventForWrite(req, res);
    if (!event) return;
    if (!event.isActive) return res.status(404).json({ success: false, message: 'Không tìm thấy sự kiện' });
    if (rejectNonStandardEvent(event, res)) return;

    const userId = typeof req.body.userId === 'string' ? req.body.userId : '';
    if (!userId) return res.status(400).json({ success: false, error: 'MISSING_PARAMS', message: 'Thiếu thông tin' });

    const [membership, profile] = await Promise.all([
      prisma.eventMember.findUnique({
        where: { eventId_userId: { eventId: event.id, userId } },
        select: { user: { select: { id: true, name: true, mssv: true } } },
      }),
      prisma.faceProfile.findUnique({ where: { userId }, select: { model: true, consentAt: true } }),
    ]);
    if (!membership) {
      return res.status(403).json({
        success: false, error: 'NOT_REGISTERED',
        message: 'Người này không có trong danh sách tham gia sự kiện.',
      });
    }
    // Chủ tài khoản vừa xoá khuôn mặt / rút đồng ý sau khi kiosk tải danh sách.
    if (!isActiveProfile(profile)) {
      return res.status(400).json({ success: false, error: 'FACE_NOT_FOUND', message: 'Người này chưa bật check-in bằng khuôn mặt.' });
    }

    const now = new Date();
    const closed = gateRejection(event, 'checkin', now);
    if (closed) return res.status(400).json(closed);

    // Điều kiện checkinTime: null nằm ngay trong câu UPDATE nên hai lần gửi trùng (kiosk
    // retry, hai máy cùng thấy một người) chỉ có một lần ghi được.
    const updated = await prisma.attendance.updateMany({
      where: { userId, eventId: event.id, checkinTime: null },
      data: { checkinTime: now, status: 'CHECKED_IN', deviceId: 'FACE' },
    });
    if (updated.count === 0) {
      const attendance = await prisma.attendance.findUnique({ where: { userId_eventId: { userId, eventId: event.id } } });
      if (attendance?.checkinTime) {
        return res.status(400).json({
          success: false, error: 'ALREADY_CHECKED_IN',
          message: `${membership.user.name} đã check-in lúc ${fmtTime(attendance.checkinTime)} rồi.`,
        });
      }
      // Dữ liệu cũ: thành viên có EventMember nhưng thiếu dòng Attendance REGISTERED.
      try {
        await prisma.attendance.create({
          data: { userId, eventId: event.id, checkinTime: now, status: 'CHECKED_IN', deviceId: 'FACE' },
        });
      } catch (err) {
        if (err.code !== 'P2002') throw err;
        return res.status(400).json({ success: false, error: 'ALREADY_CHECKED_IN', message: `${membership.user.name} đã check-in rồi.` });
      }
    }

    return res.json({
      success: true,
      message: `Xin chào ${membership.user.name}!`,
      data: { userId, name: membership.user.name, mssv: membership.user.mssv, checkinTime: now },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

module.exports = {
  importFaceProfiles, getUserFaceProfile, setUserFaceProfile, deleteUserFaceProfile,
  getParticipantFace, setParticipantFace, deleteParticipantFace,
  getFaceGallery, getFaceThumbnail, faceCheckin,
};
