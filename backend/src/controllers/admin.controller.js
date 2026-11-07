const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const emailService = require('../services/email.service');
const { profileStatus } = require('../lib/faceProfile');
const {
  MAX_BULK,
  MAX_BULK_PASSWORD,
  parseUserIds,
  selfSkipEntry,
  missingSkipEntries,
} = require('../lib/bulkUsers');

function generateTempPassword() {
  return 'Fpt@' + crypto.randomInt(100000, 1000000).toString();
}

// Chỉ nhân sự có tài khoản đăng nhập. Người tham gia (STUDENT) không có tài khoản —
// BTC nhập họ trong từng sự kiện/lớp (lib/participants.js), admin không tạo, không
// đặt mật khẩu và không đổi ai thành STUDENT được.
const STAFF_ROLES = ['ADMIN', 'BTC', 'LECTURER'];
const NOT_STAFF_MESSAGE = 'Người tham gia không có tài khoản — hãy thêm họ vào danh sách của sự kiện hoặc lớp học.';

async function listUsers(req, res) {
  try {
    const { page = 1, limit = 20, search, role, status } = req.query;
    // Trần 200: trang admin dùng chính endpoint này để lấy id cho 'chọn tất cả
    // kết quả khớp bộ lọc', nên limit là input của người dùng, phải chặn.
    const take = Math.min(Math.max(parseInt(limit) || 20, 1), MAX_BULK);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

    const where = {
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { mssv: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      }),
      // Mặc định chỉ liệt kê tài khoản nhân sự; role=STUDENT để xem người tham gia.
      role: role || { not: 'STUDENT' },
      ...(status === 'active' && { isActive: true }),
      ...(status === 'locked' && { isActive: false }),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take,
        select: {
          id: true, mssv: true, email: true, name: true, role: true, class: true, isActive: true, createdAt: true,
          // Chỉ cột nhỏ để tính trạng thái — embedding/thumbnail nặng, tải riêng khi mở ảnh.
          faceProfile: { select: { model: true, consentAt: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count({ where }),
    ]);

    const data = users.map(({ faceProfile, ...u }) => ({ ...u, faceStatus: profileStatus(faceProfile) }));
    return res.json({ success: true, data, total });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function createUser(req, res) {
  try {
    const { mssv, email, name, class: userClass, faculty, phone } = req.body;
    const role = req.body.role || 'BTC';
    if (!STAFF_ROLES.includes(role)) {
      return res.status(400).json({ success: false, error: 'NOT_STAFF', message: NOT_STAFF_MESSAGE });
    }

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, ...(mssv ? [{ mssv }] : [])] },
    });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email hoặc MSSV đã tồn tại' });
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const user = await prisma.user.create({
      data: { mssv, email, name, role, class: userClass, faculty, phone, passwordHash, isFirstLogin: true },
      select: { id: true, mssv: true, email: true, name: true, role: true },
    });

    try {
      await emailService.sendWelcomeEmail(email, name, mssv, tempPassword);
    } catch (emailErr) {
      console.error('Failed to send welcome email:', emailErr);
    }

    return res.status(201).json({ success: true, data: user });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function updateUser(req, res) {
  try {
    const { mssv, email, name, role, class: userClass, faculty, phone, isActive } = req.body;
    if (role !== undefined && !STAFF_ROLES.includes(role)) {
      return res.status(400).json({ success: false, error: 'NOT_STAFF', message: NOT_STAFF_MESSAGE });
    }

    // Khi đổi email/mssv: kiểm tra trùng với user KHÁC
    if (email !== undefined || mssv !== undefined) {
      const conflict = await prisma.user.findFirst({
        where: {
          id: { not: req.params.id },
          OR: [
            ...(email ? [{ email }] : []),
            ...(mssv ? [{ mssv }] : []),
          ],
        },
        select: { id: true },
      });
      if (conflict) {
        return res.status(400).json({ success: false, message: 'Email hoặc MSSV đã tồn tại ở tài khoản khác' });
      }
    }

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        ...(mssv !== undefined && { mssv: mssv || null }),
        ...(email && { email }),
        ...(name && { name }),
        ...(role && { role }),
        ...(userClass !== undefined && { class: userClass || null }),
        ...(faculty !== undefined && { faculty: faculty || null }),
        ...(phone !== undefined && { phone: phone || null }),
        ...(isActive !== undefined && { isActive }),
      },
      select: { id: true, mssv: true, email: true, name: true, role: true, class: true, faculty: true, phone: true, isActive: true },
    });
    return res.json({ success: true, data: updated });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// Xoá CỨNG user. Vì Attendance/Event ràng buộc onDelete RESTRICT về User,
// phải dọn dependent records trong 1 transaction. Sự kiện do user tạo thì
// KHÔNG xoá theo (dữ liệu sự kiện quan trọng) → chặn và yêu cầu khoá thay vì xoá.
async function deleteUser(req, res) {
  try {
    const targetId = req.params.id;

    if (targetId === req.user.id) {
      return res.status(400).json({ success: false, message: 'Không thể tự xoá tài khoản của chính mình' });
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, _count: { select: { createdEvents: true } } },
    });
    if (!target) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
    }
    if (target._count.createdEvents > 0) {
      return res.status(400).json({
        success: false,
        message: 'Người dùng này đã tạo sự kiện nên không thể xoá. Hãy khoá tài khoản thay vì xoá.',
      });
    }

    await prisma.$transaction([
      prisma.otpToken.deleteMany({ where: { userId: targetId } }),
      prisma.deviceBinding.deleteMany({ where: { userId: targetId } }),
      prisma.eventMember.deleteMany({ where: { userId: targetId } }),
      prisma.attendance.deleteMany({ where: { userId: targetId } }),
      prisma.fraudLog.updateMany({ where: { userId: targetId }, data: { userId: null } }),
      prisma.user.delete({ where: { id: targetId } }),
    ]);

    return res.json({ success: true, message: 'Đã xoá người dùng' });
  } catch (err) {
    console.error('Delete user error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// Admin đặt lại mật khẩu cho BẤT KỲ tài khoản nào — không cần mật khẩu cũ.
// Bỏ trống newPassword → sinh mật khẩu tạm. Mật khẩu luôn được gửi email cho
// người dùng và trả về cho admin để bàn giao thủ công khi email lỗi.
// Lưu ý: JWT đang phát hành không có cơ chế thu hồi nên phiên đăng nhập cũ của
// người dùng vẫn còn hiệu lực tới khi token hết hạn (1 ngày).
async function resetPassword(req, res) {
  try {
    const { newPassword } = req.body || {};

    if (newPassword) {
      if (typeof newPassword !== 'string' || newPassword.length < 6) {
        return res.status(400).json({ success: false, message: 'Mật khẩu mới phải ít nhất 6 ký tự' });
      }
    }

    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, email: true, name: true, role: true },
    });
    if (!target) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
    }
    // Đặt mật khẩu cho người tham gia = cấp cho họ một tài khoản đăng nhập.
    if (target.role === 'STUDENT') {
      return res.status(400).json({ success: false, error: 'NOT_STAFF', message: NOT_STAFF_MESSAGE });
    }

    const password = newPassword || generateTempPassword();
    const passwordHash = await bcrypt.hash(password, 10);

    await prisma.user.update({
      where: { id: target.id },
      data: {
        passwordHash,
        // Buộc đổi mật khẩu ở lần đăng nhập kế tiếp + gỡ khoá do đăng nhập sai.
        isFirstLogin: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    let emailSent = true;
    try {
      await emailService.sendPasswordResetEmail(target.email, target.name, password);
    } catch (emailErr) {
      emailSent = false;
      console.error('Failed to send password reset email:', emailErr);
    }

    return res.json({
      success: true,
      emailSent,
      password,
      message: emailSent
        ? `Đã đặt lại mật khẩu và gửi email đến ${target.email}`
        : 'Đã đặt lại mật khẩu nhưng KHÔNG gửi được email. Hãy chuyển mật khẩu cho người dùng theo cách khác.',
    });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function resetDeviceBinding(req, res) {
  try {
    await prisma.deviceBinding.deleteMany({ where: { userId: req.params.id } });
    return res.json({ success: true, message: 'Đã reset thiết bị. Sinh viên có thể đăng nhập trên thiết bị mới.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function getStats(req, res) {
  try {
    const [totalUsers, totalEvents, totalStudents, totalCheckins] = await Promise.all([
      prisma.user.count({ where: { isActive: true } }),
      prisma.event.count({ where: { isActive: true } }),
      prisma.user.count({ where: { role: 'STUDENT', isActive: true } }),
      prisma.attendance.count({ where: { checkinTime: { not: null } } }),
    ]);
    return res.json({ success: true, data: { totalUsers, totalEvents, totalStudents, totalCheckins } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// ───────────────────────────────────────────────────────────────
// Thao tác hàng loạt (admin chọn nhiều tài khoản trên bảng)
// ───────────────────────────────────────────────────────────────
//
// Mọi handler dưới đây trả về CÙNG một hình dạng:
//   { success, updated, skipped: [{ id, name, reason }], message }
// Frontend render nguyên danh sách skipped nên phải luôn kèm lý do tiếng Việt —
// thao tác hàng loạt "thành công một phần" là chuyện bình thường (người đã tạo
// sự kiện thì không xoá được), không phải lỗi để trả 4xx.

const ROLES = STAFF_ROLES;

// Gửi email theo lô nhỏ: Brevo giới hạn tốc độ và 50 request song song từ
// Render free tier hay bị nghẽn. 5 một lượt là đủ nhanh mà vẫn an toàn.
async function sendInBatches(items, send, size = 5) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(send));
  }
}

function bulkErrorResponse(res, message) {
  return res.status(400).json({ success: false, error: 'BULK_INVALID', message });
}

// Sửa hàng loạt: chỉ các trường AN TOÀN khi áp cho nhiều người cùng lúc.
// email/mssv/tên là duy nhất theo từng người nên cố tình KHÔNG có ở đây.
async function bulkUpdateUsers(req, res) {
  try {
    const { ids, selfSkipped, error } = parseUserIds(req.body, { selfId: req.user.id });
    if (error) return bulkErrorResponse(res, error);

    const { role, class: userClass, faculty, isActive } = req.body;
    const data = {};

    if (role !== undefined) {
      if (!ROLES.includes(role)) return bulkErrorResponse(res, 'Vai trò không hợp lệ');
      data.role = role;
    }
    if (userClass !== undefined) data.class = userClass ? String(userClass).trim() : null;
    if (faculty !== undefined) data.faculty = faculty ? String(faculty).trim() : null;
    if (isActive !== undefined) data.isActive = Boolean(isActive);

    if (Object.keys(data).length === 0) {
      return bulkErrorResponse(res, 'Chưa chọn thông tin nào để thay đổi');
    }

    const result = ids.length
      ? await prisma.user.updateMany({ where: { id: { in: ids } }, data })
      : { count: 0 };

    const skipped = selfSkipped ? [selfSkipEntry(req.user)] : [];
    return res.json({
      success: true,
      updated: result.count,
      skipped,
      message: `Đã cập nhật ${result.count} tài khoản`,
    });
  } catch (err) {
    console.error('Bulk update users error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// Reset mật khẩu hàng loạt: mỗi người một mật khẩu tạm riêng, gửi email và
// TRẢ VỀ cho admin để bàn giao thủ công khi email lỗi (giống bản 1 người).
async function bulkResetPasswords(req, res) {
  try {
    const { ids, selfSkipped, error } = parseUserIds(req.body, {
      selfId: req.user.id,
      max: MAX_BULK_PASSWORD,
    });
    if (error) return bulkErrorResponse(res, error);

    const targets = ids.length
      ? await prisma.user.findMany({
          where: { id: { in: ids }, role: { not: 'STUDENT' } },
          select: { id: true, name: true, email: true },
        })
      : [];

    const results = [];
    for (const target of targets) {
      const password = generateTempPassword();
      const passwordHash = await bcrypt.hash(password, 10);
      await prisma.user.update({
        where: { id: target.id },
        data: { passwordHash, isFirstLogin: true, failedLoginAttempts: 0, lockedUntil: null },
      });
      results.push({ ...target, password, emailSent: false });
    }

    await sendInBatches(results, async (entry) => {
      try {
        await emailService.sendPasswordResetEmail(entry.email, entry.name, entry.password);
        entry.emailSent = true;
      } catch (emailErr) {
        console.error('Failed to send password reset email:', emailErr);
      }
    });

    const emailFailed = results.filter((r) => !r.emailSent).length;
    const skipped = [
      ...(selfSkipped ? [selfSkipEntry(req.user)] : []),
      ...missingSkipEntries(ids, targets),
    ];

    return res.json({
      success: true,
      updated: results.length,
      results,
      emailFailed,
      skipped,
      message: emailFailed
        ? `Đã đặt lại mật khẩu cho ${results.length} tài khoản, ${emailFailed} email gửi lỗi — hãy sao chép mật khẩu bên dưới.`
        : `Đã đặt lại mật khẩu và gửi email cho ${results.length} tài khoản`,
    });
  } catch (err) {
    console.error('Bulk reset password error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function bulkResetDevices(req, res) {
  try {
    const { ids, selfSkipped, error } = parseUserIds(req.body, { selfId: req.user.id });
    if (error) return bulkErrorResponse(res, error);

    if (ids.length) {
      await prisma.deviceBinding.deleteMany({ where: { userId: { in: ids } } });
    }

    return res.json({
      success: true,
      updated: ids.length,
      skipped: selfSkipped ? [selfSkipEntry(req.user)] : [],
      message: `Đã reset thiết bị cho ${ids.length} tài khoản`,
    });
  } catch (err) {
    console.error('Bulk reset device error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// Xoá hàng loạt — cùng ràng buộc với deleteUser: người đã tạo sự kiện thì bỏ
// qua (không xoá kèm dữ liệu sự kiện) thay vì làm hỏng cả lô.
async function bulkDeleteUsers(req, res) {
  try {
    const { ids, selfSkipped, error } = parseUserIds(req.body, { selfId: req.user.id });
    if (error) return bulkErrorResponse(res, error);

    const targets = ids.length
      ? await prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, _count: { select: { createdEvents: true } } },
        })
      : [];

    const deletable = targets.filter((t) => t._count.createdEvents === 0).map((t) => t.id);

    if (deletable.length) {
      await prisma.$transaction([
        prisma.otpToken.deleteMany({ where: { userId: { in: deletable } } }),
        prisma.deviceBinding.deleteMany({ where: { userId: { in: deletable } } }),
        prisma.eventMember.deleteMany({ where: { userId: { in: deletable } } }),
        prisma.attendance.deleteMany({ where: { userId: { in: deletable } } }),
        prisma.fraudLog.updateMany({ where: { userId: { in: deletable } }, data: { userId: null } }),
        prisma.user.deleteMany({ where: { id: { in: deletable } } }),
      ]);
    }

    const skipped = [
      ...(selfSkipped ? [selfSkipEntry(req.user)] : []),
      ...targets
        .filter((t) => t._count.createdEvents > 0)
        .map((t) => ({
          id: t.id,
          name: t.name,
          reason: 'Đã tạo sự kiện nên không thể xoá — hãy khoá tài khoản thay vì xoá',
        })),
      ...missingSkipEntries(ids, targets),
    ];

    return res.json({
      success: true,
      updated: deletable.length,
      skipped,
      message: `Đã xoá ${deletable.length} tài khoản`,
    });
  } catch (err) {
    console.error('Bulk delete users error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

module.exports = {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  resetPassword,
  resetDeviceBinding,
  getStats,
  bulkUpdateUsers,
  bulkResetPasswords,
  bulkResetDevices,
  bulkDeleteUsers,
};
