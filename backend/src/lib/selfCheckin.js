const prisma = require('./prisma');
const { validateToken } = require('../services/qr.service');
const { validateTicket } = require('./scanTicket');
const { gateRejection } = require('./attendanceGate');
const { gpsRejection } = require('./geo');
const { fmtTime } = require('./datetime');
const { feedbackPromptFor } = require('./feedbackForm');

// Lõi của điểm danh tự quét, dùng chung cho hai đường vào:
//   - POST /api/checkin            (đã đăng nhập, danh tính = JWT)
//   - POST /api/public/checkin     (không đăng nhập, danh tính = thẻ điểm danh OTP)
// Hai đường PHẢI đi qua đây để mã lỗi giống hệt nhau — ScanLanding dùng chung một
// bảng tiêu đề lỗi cho cả hai.

async function logFraud(userId, eventId, reason, req, extra = {}) {
  try {
    await prisma.fraudLog.create({
      data: {
        userId,
        eventId,
        reason,
        ip: req.ip,
        deviceId: req.headers['x-device-id'] || req.body?.deviceId,
        token: extra.token,
        gps: extra.gps || null,
        metadata: extra,
      },
    });
  } catch {}
}

// Bằng chứng đã quét mã: vé quét (đổi từ token lúc vừa quét) hoặc chính token QR.
function scanProofValid({ ticket, token, eventId, type, deviceId }) {
  return ticket
    ? validateTicket(ticket, eventId, type, deviceId)
    : validateToken(token, eventId, type);
}

function qrExpiredBody(usedTicket) {
  return {
    success: false,
    error: 'QR_EXPIRED',
    message: usedTicket
      ? 'Phiên quét mã đã hết hạn. Vui lòng quét lại mã QR.'
      : 'Mã QR đã hết hạn. Vui lòng quét lại mã mới.',
  };
}

// Sự kiện thiệp mời / công khai không có QR động tự quét — chặn cả khi ai đó tự ghép request.
function nonStandardRejection(event) {
  if (event.kind === 'INVITATION') {
    return {
      success: false,
      error: 'INVITATION_EVENT',
      message: 'Sự kiện này check-in bằng thiệp mời. Vui lòng đưa thiệp cho Ban tổ chức quét.',
    };
  }
  if (event.kind === 'PUBLIC') {
    return {
      success: false,
      error: 'PUBLIC_EVENT',
      message: 'Sự kiện này check-in bằng cách quét mã QR tại chỗ và điền thông tin.',
    };
  }
  return null;
}

async function notRegisteredRejection(event, userId) {
  if (!event.isWhitelisted) return null;
  const membership = await prisma.eventMember.findUnique({
    where: { eventId_userId: { eventId: event.id, userId } },
  });
  if (membership) return null;
  return {
    success: false,
    error: 'NOT_REGISTERED',
    message: 'Bạn không có trong danh sách đăng ký tham gia sự kiện này.',
  };
}

// Một máy chỉ check-in được MỘT người mỗi sự kiện (chốt với product owner
// 2026-11-07). Chặn kiểu "một người cầm máy check-in hộ cả nhóm" — nhất là từ khi
// check-in bằng OTP email không cần đăng nhập. Áp cho cả đường đăng nhập, vì đăng
// nhập OTP cũng tự tin cậy máy mới nên bỏ qua đường đó thì luật này vô dụng.
// Máy hỏng phải mượn máy bạn: BTC điểm danh tay ở tab Điểm danh.
async function sharedDeviceRejection(eventId, userId, deviceId) {
  const other = await prisma.attendance.findFirst({
    where: { eventId, deviceId, checkinTime: { not: null }, NOT: { userId } },
    select: { userId: true },
  });
  if (!other) return null;
  return {
    success: false,
    error: 'DEVICE_USED_BY_OTHER',
    message: 'Thiết bị này đã được dùng để check-in cho người khác ở sự kiện này. Vui lòng dùng điện thoại của chính bạn hoặc liên hệ Ban tổ chức.',
  };
}

// Kiểm tra từ bước danh sách trở đi và ghi điểm danh. Trả { status, body }.
// requireDeviceBinding: chỉ đường JWT — ở đường thẻ, OTP gắn với thiết bị đã
// đóng vai trò đó.
async function performSelfCheckin({ event, user, type, gps, deviceId, req, now = new Date(), requireDeviceBinding }) {
  const eventId = event.id;
  const userId = user.id;

  // 3. Whitelist: chỉ thành viên trong danh sách mới được điểm danh (design 2026-07-14).
  const notRegistered = await notRegisteredRejection(event, userId);
  if (notRegistered) return { status: 403, body: notRegistered };

  // 4. Cổng điểm danh — theo lịch (AUTO) hoặc BTC mở/đóng thủ công.
  const closed = gateRejection(event, type, now);
  if (closed) return { status: 400, body: closed };

  // 5. GPS
  const gpsError = gpsRejection(event, gps);
  if (gpsError) {
    if (gpsError.fraud) await logFraud(userId, eventId, gpsError.fraud.reason, req, gpsError.fraud.extra);
    return { status: gpsError.status, body: gpsError.body };
  }

  // 6. Device binding (đường đăng nhập)
  if (requireDeviceBinding) {
    const deviceBinding = await prisma.deviceBinding.findFirst({
      where: { userId, deviceId, isTrusted: true },
    });
    if (!deviceBinding) {
      await logFraud(userId, eventId, 'UNBOUND_DEVICE', req);
      return {
        status: 403,
        body: {
          success: false,
          error: 'DEVICE_NOT_BOUND',
          message: 'Thiết bị chưa được xác thực. Vui lòng đăng xuất và đăng nhập lại.',
        },
      };
    }
  }

  // 6b. Một máy một người
  if (type === 'checkin') {
    const shared = await sharedDeviceRejection(eventId, userId, deviceId);
    if (shared) {
      await logFraud(userId, eventId, 'SHARED_DEVICE', req);
      return { status: 403, body: shared };
    }
  }

  // 7. Ghi điểm danh
  let attendance = await prisma.attendance.findUnique({
    where: { userId_eventId: { userId, eventId } },
  });

  if (type === 'checkin') {
    if (attendance?.checkinTime) {
      return {
        status: 400,
        body: {
          success: false,
          error: 'ALREADY_CHECKED_IN',
          message: `Bạn đã check-in lúc ${fmtTime(attendance.checkinTime)} rồi.`,
        },
      };
    }

    attendance = await prisma.attendance.upsert({
      where: { userId_eventId: { userId, eventId } },
      create: { userId, eventId, checkinTime: now, checkinGps: gps, deviceId, ip: req.ip, status: 'CHECKED_IN' },
      update: { checkinTime: now, checkinGps: gps, deviceId, status: 'CHECKED_IN' },
    });
  } else {
    if (!attendance?.checkinTime) {
      return {
        status: 400,
        body: { success: false, error: 'NOT_CHECKED_IN', message: 'Bạn chưa check-in cho sự kiện này.' },
      };
    }
    if (attendance?.checkoutTime) {
      // Quét lại mã check-out (vd. lỡ đóng tab trước khi đánh giá) vẫn nhận
      // được form đánh giá nếu chưa gửi.
      const feedback = await feedbackPromptFor(eventId, userId);
      return {
        status: 400,
        body: {
          success: false,
          error: 'ALREADY_CHECKED_OUT',
          message: `Bạn đã check-out lúc ${fmtTime(attendance.checkoutTime)} rồi.`,
          ...(feedback && { feedback }),
        },
      };
    }

    attendance = await prisma.attendance.update({
      where: { id: attendance.id },
      data: { checkoutTime: now, checkoutGps: gps, status: 'CHECKED_OUT' },
    });
  }

  // Check-out xong là lúc hỏi đánh giá — trang quét mã hiện form ngay nếu có.
  const feedback = type === 'checkout' ? await feedbackPromptFor(eventId, userId) : null;

  return {
    status: 200,
    body: {
      success: true,
      type,
      ...(feedback && { feedback }),
      time: now.toISOString(),
      timeDisplay: fmtTime(now, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      user: { name: user.name, mssv: user.mssv },
      event: { id: event.id, name: event.name, location: event.location },
    },
  };
}

module.exports = {
  logFraud,
  scanProofValid,
  qrExpiredBody,
  nonStandardRejection,
  notRegisteredRejection,
  sharedDeviceRejection,
  performSelfCheckin,
};
