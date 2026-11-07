const prisma = require('../lib/prisma');
const { addParticipantsToEvent } = require('../lib/participants');
const emailService = require('../services/email.service');

// Các trường sự kiện an toàn để lộ ra endpoint công khai (KHÔNG kèm lat/lng/radius
// để tránh rò toạ độ geofence cho người chưa đăng nhập — xem event.controller#getEvent).
const PUBLIC_EVENT_FIELDS = {
  id: true,
  name: true,
  description: true,
  location: true,
  checkinOpen: true,
  checkinClose: true,
  checkoutOpen: true,
  checkoutClose: true,
  isWhitelisted: true,
  allowRegistration: true,
  createdBy: { select: { name: true } },
  _count: { select: { eventMembers: true } },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeInput(body = {}) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    name: str(body.name).replace(/\s+/g, ' '),
    mssv: str(body.mssv).toUpperCase(),
    email: str(body.email).toLowerCase(),
    phone: str(body.phone),
  };
}

// Sự kiện còn nhận đăng ký khi: đang hoạt động, bật cho phép đăng ký và
// chưa đóng cổng check-in. checkinClose giờ là tuỳ chọn (BTC có thể chủ động
// mở/đóng điểm danh thay vì đặt lịch) — null nghĩa là KHÔNG có hạn đăng ký,
// không phải "đã đóng".
function registrationWindowError(event, now = new Date()) {
  if (!event.allowRegistration) {
    return 'Sự kiện này không mở đăng ký trực tuyến. Vui lòng liên hệ Ban tổ chức.';
  }
  if (event.checkinClose && now > event.checkinClose) {
    return 'Sự kiện đã đóng cổng đăng ký.';
  }
  return null;
}

// ───────────────────────────────────────────────────────────────
// Endpoint công khai (không cần đăng nhập)
// ───────────────────────────────────────────────────────────────

// Danh sách sự kiện đang mở đăng ký, để người ngoài chọn sự kiện muốn tham gia.
async function listOpenEvents(req, res) {
  try {
    const { search, limit = 30 } = req.query;
    const take = Math.min(parseInt(limit, 10) || 30, 50);

    const events = await prisma.event.findMany({
      where: {
        isActive: true,
        allowRegistration: true,
        // checkinClose = null → không có hạn đăng ký, vẫn phải liệt kê.
        OR: [{ checkinClose: null }, { checkinClose: { gte: new Date() } }],
        ...(search && { name: { contains: search, mode: 'insensitive' } }),
      },
      select: PUBLIC_EVENT_FIELDS,
      orderBy: { checkinOpen: { sort: 'asc', nulls: 'first' } },
      take,
    });

    return res.json({ success: true, data: events });
  } catch (err) {
    console.error('List open events error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function getPublicEvent(req, res) {
  try {
    const event = await prisma.event.findFirst({
      where: { id: req.params.id, isActive: true },
      select: PUBLIC_EVENT_FIELDS,
    });

    if (!event) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy sự kiện' });
    }

    return res.json({
      success: true,
      data: { ...event, registrationClosed: Boolean(registrationWindowError(event)) },
    });
  } catch (err) {
    console.error('Get public event error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// Đăng ký tham gia sự kiện bằng form (họ tên / MSSV / email). Người tham gia không có
// tài khoản (lib/participants.js): chỉ thêm vào danh sách của sự kiện, không mật khẩu.
async function registerPublic(req, res) {
  try {
    const { name, mssv, email, phone } = normalizeInput(req.body);

    if (!name || name.length < 2) {
      return res.status(400).json({ success: false, message: 'Vui lòng nhập họ tên hợp lệ' });
    }
    if (!mssv) {
      return res.status(400).json({ success: false, message: 'Vui lòng nhập mã số sinh viên' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ success: false, message: 'Email không hợp lệ' });
    }

    const event = await prisma.event.findFirst({
      where: { id: req.params.id, isActive: true, kind: 'STANDARD' },
      select: { id: true, name: true, location: true, checkinOpen: true, checkinClose: true, allowRegistration: true },
    });
    if (!event) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy sự kiện' });
    }

    const windowError = registrationWindowError(event);
    if (windowError) {
      return res.status(400).json({ success: false, message: windowError });
    }

    const result = await addParticipantsToEvent(event.id, [{ email, name, mssv, phone }]);
    if (result.skipped?.length) {
      return res.status(409).json({
        success: false,
        message: `${result.skipped[0].reason}. Vui lòng kiểm tra lại hoặc liên hệ Ban tổ chức.`,
      });
    }
    const alreadyRegistered = result.added === 0;

    let emailSent = false;
    if (!alreadyRegistered) {
      try {
        await emailService.sendEventRegistrationEmail(email, name, event);
        emailSent = true;
      } catch (emailErr) {
        console.error('Failed to send registration email:', emailErr);
      }
    }

    return res.status(alreadyRegistered ? 200 : 201).json({
      success: true,
      alreadyRegistered,
      emailSent,
      data: {
        event: { id: event.id, name: event.name, location: event.location, checkinOpen: event.checkinOpen },
        participant: { name, email },
      },
      message: alreadyRegistered
        ? 'Bạn đã có tên trong danh sách tham gia sự kiện này.'
        : 'Đăng ký tham gia sự kiện thành công!',
    });
  } catch (err) {
    console.error('Public registration error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

module.exports = { listOpenEvents, getPublicEvent, registerPublic };
