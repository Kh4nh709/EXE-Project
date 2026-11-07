const prisma = require('../lib/prisma');
const { validateToken } = require('../services/qr.service');
const { issueTicket } = require('../lib/scanTicket');
const {
  logFraud, scanProofValid, qrExpiredBody, nonStandardRejection, performSelfCheckin,
} = require('../lib/selfCheckin');

// Đổi token QR lấy vé quét. Gọi được khi CHƯA đăng nhập — đó chính là mục đích:
// chạy ngay lúc vừa quét, trước khi người dùng mất vài phút đăng nhập.
// Cố tình không đụng vào DB: token QR đã được ký HMAC theo eventId nên không thể
// bịa ra eventId lạ, còn sự kiện có tồn tại / có mở cổng hay không thì bước điểm
// danh thật vẫn kiểm tra đầy đủ.
async function issueScanTicket(req, res) {
  try {
    const { eventId, token, type, deviceId } = req.body || {};

    if (!eventId || !token || !type || !deviceId) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAMS', message: 'Thiếu thông tin' });
    }
    if (type !== 'checkin' && type !== 'checkout') {
      return res.status(400).json({ success: false, error: 'MISSING_PARAMS', message: 'Loại điểm danh không hợp lệ' });
    }

    if (!validateToken(token, eventId, type)) {
      return res.status(400).json({
        success: false,
        error: 'QR_EXPIRED',
        message: 'Mã QR đã hết hạn. Vui lòng quét lại mã mới.',
      });
    }

    const { ticket, expiresAt } = issueTicket(eventId, type, deviceId);
    return res.json({ success: true, ticket, expiresAt });
  } catch (err) {
    console.error('Issue scan ticket error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function processCheckin(req, res) {
  try {
    const { eventId, token, ticket, type, gps, deviceId } = req.body;
    const userId = req.user.id;

    if (!eventId || !type || !deviceId || (!token && !ticket)) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAMS', message: 'Thiếu thông tin' });
    }

    // 1. Bằng chứng đã quét mã: vé quét (đổi từ token lúc vừa quét) hoặc chính
    //    token QR nếu client chưa kịp/không đổi được vé.
    if (!scanProofValid({ ticket, token, eventId, type, deviceId })) {
      await logFraud(userId, eventId, ticket ? 'INVALID_SCAN_TICKET' : 'INVALID_QR_TOKEN', req, {
        token: ticket || token,
      });
      return res.status(400).json(qrExpiredBody(!!ticket));
    }

    // 2. Sự kiện
    const event = await prisma.event.findUnique({ where: { id: eventId, isActive: true } });
    if (!event) {
      return res.status(404).json({ success: false, error: 'EVENT_NOT_FOUND', message: 'Không tìm thấy sự kiện' });
    }
    const nonStandard = nonStandardRejection(event);
    if (nonStandard) return res.status(400).json(nonStandard);

    // 3–7: danh sách → cổng → GPS → thiết bị → ghi điểm danh (lib/selfCheckin.js).
    const { status, body } = await performSelfCheckin({
      event, user: req.user, type, gps, deviceId, req, requireDeviceBinding: true,
    });
    return res.status(status).json(body);
  } catch (err) {
    console.error('Checkin error:', err);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Lỗi server. Vui lòng thử lại.' });
  }
}

async function getCheckinStatus(req, res) {
  try {
    const { eventId } = req.params;
    const userId = req.user.id;

    const attendance = await prisma.attendance.findUnique({
      where: { userId_eventId: { userId, eventId } },
    });

    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, name: true, location: true, gpsEnabled: true, checkinOpen: true, checkinClose: true, checkoutOpen: true, checkoutClose: true },
    });

    return res.json({ success: true, attendance, event });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

module.exports = { issueScanTicket, processCheckin, getCheckinStatus };
