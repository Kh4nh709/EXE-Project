const prisma = require('../lib/prisma');
const { loadEventForWrite } = require('../lib/eventAccess');
const { gateRejection, gateSummary } = require('../lib/attendanceGate');
const { fmtTime } = require('../lib/datetime');
const {
  FACE_MODEL, SELF_VS_IMPORT_THRESHOLD, MAX_IMPORT_ITEMS,
  similarity, decodeEmbedding, decodeThumbnail, toVector,
  isActiveProfile, profileStatus, adminProfileData, loadProfileVectors, findDuplicateIn, findDuplicate,
} = require('../lib/faceProfile');
const { rejectNonStandardEvent } = require('./event.controller');

const DUPLICATE_MESSAGE = 'Khuôn mặt này quá giống khuôn mặt đã đăng ký của một tài khoản khác. '
  + 'Nếu đây đúng là bạn, hãy liên hệ Ban tổ chức.';

function base64(bytes) {
  return bytes ? Buffer.from(bytes).toString('base64') : null;
}

// ───────────────────────────────────────────────────────────────
// Sinh viên tự quản lý khuôn mặt của mình
// ───────────────────────────────────────────────────────────────

async function getMyFaceProfile(req, res) {
  try {
    const profile = await prisma.faceProfile.findUnique({ where: { userId: req.user.id } });
    const status = profileStatus(profile);
    return res.json({
      success: true,
      data: status === 'none'
        ? { status }
        : { status, source: profile.source, updatedAt: profile.updatedAt, thumbnail: base64(profile.thumbnail) },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function saveMyFaceProfile(req, res) {
  try {
    const userId = req.user.id;
    // Dữ liệu sinh trắc học: không có đồng ý rõ ràng thì không lưu.
    if (req.body.consent !== true) {
      return res.status(400).json({
        success: false, error: 'FACE_CONSENT_REQUIRED',
        message: 'Bạn cần đồng ý cho phép dùng khuôn mặt để check-in.',
      });
    }
    const embedding = decodeEmbedding(req.body.embedding);
    if (embedding.error) return res.status(400).json({ success: false, error: 'FACE_INVALID', message: embedding.error });
    const thumbnail = decodeThumbnail(req.body.thumbnail);
    if (thumbnail.error) return res.status(400).json({ success: false, error: 'FACE_INVALID', message: thumbnail.error });

    // Đã có ảnh nhà trường import thì ảnh tự chụp phải là cùng một người — không thì ai
    // cũng tự thay ảnh thẻ của mình bằng mặt bạn để bạn đi qua cửa hộ.
    const existing = await prisma.faceProfile.findUnique({ where: { userId } });
    if (existing?.importEmbedding && existing.model === FACE_MODEL) {
      const score = similarity(embedding.vector, toVector(Buffer.from(existing.importEmbedding)));
      if (score < SELF_VS_IMPORT_THRESHOLD) {
        return res.status(400).json({
          success: false, error: 'FACE_MISMATCH',
          message: 'Ảnh chụp không khớp với ảnh nhà trường đã cung cấp. Hãy chụp lại chính diện, đủ sáng.',
        });
      }
    }

    if (await findDuplicate(embedding.vector, userId)) {
      return res.status(409).json({ success: false, error: 'FACE_DUPLICATE', message: DUPLICATE_MESSAGE });
    }

    const data = {
      embedding: embedding.buffer,
      thumbnail: thumbnail.buffer,
      model: FACE_MODEL,
      source: 'SELF',
      consentAt: new Date(),
    };
    // Ảnh import của mô hình cũ không còn so được → bỏ luôn, đừng giữ lại để chặn nhầm.
    if (existing && existing.model !== FACE_MODEL) data.importEmbedding = null;
    const profile = await prisma.faceProfile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return res.json({
      success: true,
      message: 'Đã lưu khuôn mặt. Bạn có thể check-in bằng khuôn mặt ở các sự kiện có kiosk.',
      data: { status: profileStatus(profile), source: profile.source, updatedAt: profile.updatedAt, thumbnail: base64(profile.thumbnail) },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// Đồng ý dùng ảnh nhà trường đã import. Ảnh admin đặt giờ có hiệu lực ngay; endpoint này còn
// cho các ảnh import trước đó vẫn đang chờ đồng ý.
async function consentMyFaceProfile(req, res) {
  try {
    const result = await prisma.faceProfile.updateMany({
      where: { userId: req.user.id, model: FACE_MODEL, consentAt: null },
      data: { consentAt: new Date() },
    });
    if (result.count === 0) {
      return res.status(404).json({ success: false, error: 'FACE_NOT_FOUND', message: 'Không có ảnh nào đang chờ bạn đồng ý.' });
    }
    return res.json({ success: true, message: 'Đã bật check-in bằng khuôn mặt.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// Xoá hẳn — kể cả ảnh nhà trường import — vì đây là quyền xoá dữ liệu cá nhân.
async function deleteMyFaceProfile(req, res) {
  try {
    await prisma.faceProfile.deleteMany({ where: { userId: req.user.id } });
    return res.json({ success: true, message: 'Đã xoá dữ liệu khuôn mặt.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// ───────────────────────────────────────────────────────────────
// Admin import ảnh thẻ (embedding đã tính sẵn trong trình duyệt admin)
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

async function getUserFaceProfile(req, res) {
  try {
    const profile = await prisma.faceProfile.findUnique({ where: { userId: req.params.id } });
    return res.json({ success: true, data: adminFaceView(profile) });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// Thay ảnh của một người — được đè cả ảnh sinh viên tự chụp, vì đây là admin chủ động
// chọn đúng người đó. Vẫn chặn mặt trùng tài khoản khác như mọi lần ghi.
async function setUserFaceProfile(req, res) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, role: true } });
    if (!user) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND', message: 'Không tìm thấy người dùng' });
    // Check-in khuôn mặt là cho sinh viên, như import theo MSSV; và chỉ sinh viên vào được
    // /khuon-mat để tự xem/xoá ảnh của mình.
    if (user.role !== 'STUDENT') {
      return res.status(400).json({
        success: false, error: 'FACE_STUDENT_ONLY',
        message: 'Chỉ đặt được ảnh khuôn mặt cho tài khoản sinh viên.',
      });
    }
    const embedding = decodeEmbedding(req.body.embedding);
    if (embedding.error) return res.status(400).json({ success: false, error: 'FACE_INVALID', message: embedding.error });
    const thumbnail = decodeThumbnail(req.body.thumbnail);
    if (thumbnail.error) return res.status(400).json({ success: false, error: 'FACE_INVALID', message: thumbnail.error });

    if (await findDuplicate(embedding.vector, user.id)) {
      return res.status(409).json({
        success: false, error: 'FACE_DUPLICATE',
        message: 'Khuôn mặt trong ảnh quá giống khuôn mặt đã đăng ký của một tài khoản khác.',
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
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function deleteUserFaceProfile(req, res) {
  try {
    const result = await prisma.faceProfile.deleteMany({ where: { userId: req.params.id } });
    if (result.count === 0) {
      return res.status(404).json({ success: false, error: 'FACE_NOT_FOUND', message: 'Người dùng này chưa có ảnh khuôn mặt.' });
    }
    return res.json({ success: true, message: 'Đã xoá ảnh khuôn mặt.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

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
  getMyFaceProfile, saveMyFaceProfile, consentMyFaceProfile, deleteMyFaceProfile,
  importFaceProfiles, getUserFaceProfile, setUserFaceProfile, deleteUserFaceProfile,
  getFaceGallery, getFaceThumbnail, faceCheckin,
};
