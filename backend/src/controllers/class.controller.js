const prisma = require('../lib/prisma');
const { addUsersToEvent } = require('../lib/eventMembership');
const { parseEventDates, parseGateState } = require('../lib/parseOptionalDate');
const { gateSummary } = require('../lib/attendanceGate');
const { fmtDate } = require('../lib/datetime');
const { addParticipantsToClass, parseSheet, importSummary } = require('../lib/participants');

const CLASS_NOT_FOUND = { success: false, message: 'Không tìm thấy lớp' };

async function loadClass(id) {
  return prisma.class.findUnique({ where: { id } });
}

// ───────────────────────────────────────────────────────────────
// CRUD lớp học
// ───────────────────────────────────────────────────────────────

async function listClasses(req, res) {
  try {
    const { search } = req.query;
    const where = search ? { name: { contains: search, mode: 'insensitive' } } : {};

    const classes = await prisma.class.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { createdBy: { select: { name: true } }, _count: { select: { members: true } } },
    });

    const data = classes.map(({ _count, ...c }) => ({ ...c, memberCount: _count.members }));
    return res.json({ success: true, data });
  } catch (err) {
    console.error('List classes error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function createClass(req, res) {
  try {
    const name = String(req.body?.name || '').trim();
    const description = req.body?.description ? String(req.body.description).trim() : null;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Vui lòng nhập tên lớp' });
    }

    const existing = await prisma.class.findUnique({ where: { name } });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Tên lớp đã tồn tại' });
    }

    const cls = await prisma.class.create({
      data: { name, description, createdById: req.user.id },
    });

    return res.status(201).json({ success: true, data: { ...cls, memberCount: 0 } });
  } catch (err) {
    console.error('Create class error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function getClass(req, res) {
  try {
    const cls = await loadClass(req.params.id);
    if (!cls) return res.status(404).json(CLASS_NOT_FOUND);

    const memberCount = await prisma.classMember.count({ where: { classId: cls.id } });

    return res.json({ success: true, data: { ...cls, memberCount } });
  } catch (err) {
    console.error('Get class error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// Thành viên lớp nằm ở ClassMember (theo id lớp) nên đổi tên lớp không phải sửa gì thêm.
async function updateClass(req, res) {
  try {
    const cls = await loadClass(req.params.id);
    if (!cls) return res.status(404).json(CLASS_NOT_FOUND);

    const { description, isActive } = req.body;
    const nameRaw = req.body.name;
    const name = nameRaw !== undefined ? String(nameRaw).trim() : undefined;

    if (name !== undefined && !name) {
      return res.status(400).json({ success: false, message: 'Tên lớp không được để trống' });
    }

    if (name && name !== cls.name) {
      const conflict = await prisma.class.findFirst({ where: { name, id: { not: cls.id } } });
      if (conflict) {
        return res.status(400).json({ success: false, message: 'Tên lớp đã tồn tại' });
      }
    }

    const updated = await prisma.class.update({
      where: { id: cls.id },
      data: {
        ...(name && name !== cls.name && { name }),
        ...(description !== undefined && { description: description ? String(description).trim() : null }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
      },
    });

    const memberCount = await prisma.classMember.count({ where: { classId: updated.id } });

    return res.json({ success: true, data: { ...updated, memberCount } });
  } catch (err) {
    console.error('Update class error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// Xoá lớp xoá luôn danh sách của lớp (cascade). Các buổi điểm danh đã tạo vẫn giữ
// danh sách và lịch sử riêng của chúng (Event.classId → SetNull).
async function deleteClass(req, res) {
  try {
    const cls = await loadClass(req.params.id);
    if (!cls) return res.status(404).json(CLASS_NOT_FOUND);

    await prisma.class.delete({ where: { id: cls.id } });
    return res.json({ success: true, message: 'Đã xoá lớp' });
  } catch (err) {
    console.error('Delete class error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// ───────────────────────────────────────────────────────────────
// Quản lý thành viên trong lớp (bulk)
// ───────────────────────────────────────────────────────────────

async function listMembers(req, res) {
  try {
    const cls = await loadClass(req.params.id);
    if (!cls) return res.status(404).json(CLASS_NOT_FOUND);

    const { page = 1, limit = 20, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      classId: cls.id,
      ...(search && {
        user: {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { mssv: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        },
      }),
    };

    const [rows, total] = await Promise.all([
      prisma.classMember.findMany({
        where,
        skip,
        take: parseInt(limit),
        select: { user: { select: { id: true, mssv: true, name: true, email: true, isActive: true } } },
        orderBy: { user: { name: 'asc' } },
      }),
      prisma.classMember.count({ where }),
    ]);

    return res.json({ success: true, data: rows.map((r) => r.user), total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('List class members error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// Nhập người vào danh sách lớp bằng email + họ tên (MSSV, SĐT tuỳ chọn) — người
// tham gia không có tài khoản, xem lib/participants.js.
async function addMembers(req, res) {
  try {
    const cls = await loadClass(req.params.id);
    if (!cls) return res.status(404).json(CLASS_NOT_FOUND);

    const result = await addParticipantsToClass(cls.id, req.body?.participants);
    if (result.error) return res.status(400).json({ success: false, message: result.error });

    return res.json({ success: true, ...result, message: importSummary(result) });
  } catch (err) {
    console.error('Add class members error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function importMembers(req, res) {
  try {
    const cls = await loadClass(req.params.id);
    if (!cls) return res.status(404).json(CLASS_NOT_FOUND);
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ success: false, message: 'Chưa chọn file' });
    }

    const sheet = parseSheet(req.file.buffer);
    if (sheet.error) return res.status(400).json({ success: false, message: sheet.error });

    const result = await addParticipantsToClass(cls.id, sheet.rows, { firstLine: 2 });
    if (result.error) return res.status(400).json({ success: false, message: result.error });

    return res.json({ success: true, ...result, message: importSummary(result) });
  } catch (err) {
    console.error('Import class members error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// Gỡ khỏi danh sách lớp — không đụng tới các buổi đã tạo (mỗi buổi có danh sách riêng).
async function removeMembers(req, res) {
  try {
    const cls = await loadClass(req.params.id);
    if (!cls) return res.status(404).json(CLASS_NOT_FOUND);

    const userIds = Array.isArray(req.body?.userIds) ? [...new Set(req.body.userIds)] : [];
    if (userIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Chưa chọn người để gỡ' });
    }

    const result = await prisma.classMember.deleteMany({
      where: { classId: cls.id, userId: { in: userIds } },
    });

    return res.json({
      success: true,
      updated: result.count,
      message: `Đã gỡ ${result.count} người khỏi lớp`,
    });
  } catch (err) {
    console.error('Remove class members error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// ───────────────────────────────────────────────────────────────
// Buổi điểm danh (Event gắn classId) — "mã điểm danh theo buổi học"
// ───────────────────────────────────────────────────────────────

// Khung giờ TUỲ CHỌN — buổi học không cần đặt lịch, BTC có thể tạo và điểm
// danh ngay (xem createSession: không đặt giờ nào → tự mở điểm danh luôn).
function parseSessionInput(body) {
  const { name, location, checkinOpen, checkinClose, checkoutOpen, checkoutClose } = body;

  if (!location || !String(location).trim()) {
    return { error: 'Vui lòng nhập địa điểm buổi học' };
  }

  const { value: parsed, error: dateError } = parseEventDates({ checkinOpen, checkinClose, checkoutOpen, checkoutClose });
  if (dateError) return { error: dateError };

  const { lat, lng, radius, gpsEnabled } = body;
  const latVal = lat === undefined || lat === null || lat === '' ? null : Number(lat);
  const lngVal = lng === undefined || lng === null || lng === '' ? null : Number(lng);
  const gpsOn = gpsEnabled !== false;

  if (gpsOn) {
    const okLat = latVal !== null && Number.isFinite(latVal) && latVal >= -90 && latVal <= 90;
    const okLng = lngVal !== null && Number.isFinite(lngVal) && lngVal >= -180 && lngVal <= 180;
    if (!okLat || !okLng) return { error: 'Bật GPS thì phải nhập toạ độ hợp lệ' };
  }

  const radiusVal = radius === undefined || radius === null || radius === '' ? 100 : Number(radius);
  if (!Number.isFinite(radiusVal) || radiusVal <= 0) return { error: 'Bán kính không hợp lệ' };

  return {
    value: {
      name: name && String(name).trim() ? String(name).trim() : null,
      location: String(location).trim(),
      ...parsed,
      lat: latVal, lng: lngVal, radius: radiusVal, gpsEnabled: gpsOn,
    },
  };
}

// Tạo một buổi điểm danh cho lớp: sinh Event whitelist riêng cho lớp (không mở
// đăng ký công khai), rồi chép danh sách lớp (ClassMember) vào danh sách tham gia
// của buổi — BTC mở màn hình QR ngay sau khi tạo là điểm danh được.
async function createSession(req, res) {
  try {
    const cls = await loadClass(req.params.id);
    if (!cls) return res.status(404).json(CLASS_NOT_FOUND);

    const { value, error } = parseSessionInput(req.body || {});
    if (error) return res.status(400).json({ success: false, message: error });

    const sessionDate = value.checkinOpen || new Date();
    const sessionName = value.name || `${cls.name} - Buổi điểm danh ${fmtDate(sessionDate)}`;

    // Không đặt khung giờ check-in nào → mặc định MỞ điểm danh ngay khi tạo,
    // đúng tinh thần "buổi học không cần đặt lịch trước". Có đặt giờ thì theo
    // lịch (AUTO) như bình thường; BTC truyền checkinState rõ ràng thì ưu tiên.
    const noSchedule = !value.checkinOpen && !value.checkinClose;
    const checkinState = req.body.checkinState !== undefined
      ? parseGateState(req.body.checkinState)
      : (noSchedule ? 'OPEN' : 'AUTO');

    const event = await prisma.event.create({
      data: {
        name: sessionName,
        location: value.location,
        lat: value.lat, lng: value.lng, radius: value.radius, gpsEnabled: value.gpsEnabled,
        checkinOpen: value.checkinOpen, checkinClose: value.checkinClose,
        checkoutOpen: value.checkoutOpen, checkoutClose: value.checkoutClose,
        checkinState,
        checkoutState: parseGateState(req.body.checkoutState),
        isWhitelisted: true,
        allowRegistration: false,
        createdById: req.user.id,
        classId: cls.id,
      },
    });

    const members = await prisma.classMember.findMany({
      where: { classId: cls.id, user: { isActive: true } },
      select: { userId: true },
    });
    const { added } = await addUsersToEvent(event.id, members.map((m) => m.userId));

    return res.status(201).json({
      success: true,
      data: { ...event, gate: gateSummary(event) },
      enrolled: added,
      message: `Đã tạo buổi điểm danh và thêm ${added} người của lớp ${cls.name}`,
    });
  } catch (err) {
    console.error('Create class session error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function listSessions(req, res) {
  try {
    const cls = await loadClass(req.params.id);
    if (!cls) return res.status(404).json(CLASS_NOT_FOUND);

    const sessions = await prisma.event.findMany({
      where: { classId: cls.id },
      orderBy: { checkinOpen: { sort: 'desc', nulls: 'first' } },
      include: { _count: { select: { attendances: true, eventMembers: true } } },
    });

    return res.json({ success: true, data: sessions.map((s) => ({ ...s, gate: gateSummary(s) })) });
  } catch (err) {
    console.error('List class sessions error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

module.exports = {
  listClasses, createClass, getClass, updateClass, deleteClass,
  listMembers, addMembers, importMembers, removeMembers,
  createSession, listSessions,
};
