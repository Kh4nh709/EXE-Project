const crypto = require('crypto');
const prisma = require('../lib/prisma');
const emailService = require('../services/email.service');
const { gateRejection } = require('../lib/attendanceGate');
const { issuePass, validatePass } = require('../lib/checkinPass');
const { safeEqual } = require('../lib/scanTicket');
const {
  logFraud, scanProofValid, qrExpiredBody, nonStandardRejection,
  notRegisteredRejection, sharedDeviceRejection, performSelfCheckin,
} = require('../lib/selfCheckin');
const { fmtTime } = require('../lib/datetime');

// ─────────────────────────────────────────────────────────────────────────────
// Check-in không cần đăng nhập: quét QR → nhập email/MSSV → OTP qua email → thẻ
// điểm danh (lib/checkinPass.js) → điểm danh. Spec: 2026-11-07-otp-checkin-design.md
//
// Khác /api/auth/login-otp ở chỗ KHÔNG cấp JWT: chiếm được hộp thư chỉ cho quyền
// điểm danh đúng sự kiện đó, không chiếm được tài khoản — nên mở cho mọi vai trò
// có trong danh sách, và mượn máy bạn để check-in không để lại phiên đăng nhập.
// ─────────────────────────────────────────────────────────────────────────────

const OTP_PURPOSE = 'CHECKIN';
const OTP_TTL_MS = 10 * 60 * 1000;
// Chặn bấm "Gửi lại" liên tục — mỗi lần là một email trong hạn mức Brevo/ngày.
// Cũng nuốt luôn lần gửi trùng khi api.js tự thử lại một request bị timeout.
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

// "nguyenvana@fpt.edu.vn" → "ng*****@fpt.edu.vn": đủ để người dùng nhận ra hộp
// thư của mình, không lộ email của MSSV người khác cho ai gõ thử. Số sao cố định
// để không lộ cả độ dài email (và không tràn dòng trên điện thoại).
function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!domain) return email;
  const keep = local.length <= 2 ? 1 : 2;
  return `${local.slice(0, keep)}*****@${domain}`;
}

function findUserByIdentifier(identifier) {
  const value = String(identifier).trim();
  return prisma.user.findFirst({
    where: {
      isActive: true,
      OR: [
        { email: { equals: value, mode: 'insensitive' } },
        { mssv: { equals: value, mode: 'insensitive' } },
      ],
    },
  });
}

// Sự kiện tự quét còn hoạt động và BTC chưa tắt check-in bằng email. Gửi lỗi và
// trả null nếu không đạt.
async function loadOtpEvent(eventId, res) {
  const event = await prisma.event.findUnique({ where: { id: eventId, isActive: true } });
  if (!event) {
    res.status(404).json({ success: false, error: 'EVENT_NOT_FOUND', message: 'Không tìm thấy sự kiện' });
    return null;
  }
  const nonStandard = nonStandardRejection(event);
  if (nonStandard) {
    res.status(400).json(nonStandard);
    return null;
  }
  if (event.otpCheckinEnabled === false) {
    res.status(403).json({
      success: false,
      error: 'OTP_CHECKIN_DISABLED',
      message: 'Sự kiện này yêu cầu đăng nhập tài khoản để điểm danh.',
    });
    return null;
  }
  return event;
}

function validType(type) {
  return type === 'checkin' || type === 'checkout';
}

// POST /api/public/checkin-otp/request
// Kiểm tra MỌI điều kiện kiểm được trước khi gửi email — người không có trong
// danh sách, cổng đã đóng, đã check-in rồi… không tốn email nào.
async function requestCheckinOtp(req, res) {
  try {
    const { eventId, type, deviceId, identifier, ticket, token } = req.body || {};

    if (!eventId || !validType(type) || !deviceId || (!ticket && !token)) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAMS', message: 'Thiếu thông tin' });
    }
    if (!identifier || typeof identifier !== 'string' || !identifier.trim()) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAMS', message: 'Vui lòng nhập email hoặc MSSV' });
    }

    // Phải vừa quét mã thật: người không đứng trước màn hình sự kiện không dò được
    // ai có trong danh sách và không bắt hệ thống gửi email hộ được.
    if (!scanProofValid({ ticket, token, eventId, type, deviceId })) {
      return res.status(400).json(qrExpiredBody(!!ticket));
    }

    const event = await loadOtpEvent(eventId, res);
    if (!event) return undefined;

    const closed = gateRejection(event, type, new Date());
    if (closed) return res.status(400).json(closed);

    const user = await findUserByIdentifier(identifier);
    if (!user) {
      return event.isWhitelisted
        ? res.status(403).json({
          success: false,
          error: 'NOT_REGISTERED',
          message: 'Email/MSSV này không có trong danh sách tham gia sự kiện.',
        })
        : res.status(404).json({
          success: false,
          error: 'ACCOUNT_NOT_FOUND',
          message: 'Không tìm thấy tài khoản với email/MSSV này.',
        });
    }

    const notRegistered = await notRegisteredRejection(event, user.id);
    if (notRegistered) {
      return res.status(403).json({ ...notRegistered, message: 'Email/MSSV này không có trong danh sách tham gia sự kiện.' });
    }

    const attendance = await prisma.attendance.findUnique({
      where: { userId_eventId: { userId: user.id, eventId } },
      select: { checkinTime: true, checkoutTime: true },
    });
    if (type === 'checkin' && attendance?.checkinTime) {
      return res.status(400).json({
        success: false,
        error: 'ALREADY_CHECKED_IN',
        message: `Bạn đã check-in lúc ${fmtTime(attendance.checkinTime)} rồi.`,
      });
    }
    if (type === 'checkout' && !attendance?.checkinTime) {
      return res.status(400).json({ success: false, error: 'NOT_CHECKED_IN', message: 'Bạn chưa check-in cho sự kiện này.' });
    }
    if (type === 'checkout' && attendance?.checkoutTime) {
      return res.status(400).json({
        success: false,
        error: 'ALREADY_CHECKED_OUT',
        message: `Bạn đã check-out lúc ${fmtTime(attendance.checkoutTime)} rồi.`,
      });
    }

    if (type === 'checkin') {
      const shared = await sharedDeviceRejection(eventId, user.id, deviceId);
      if (shared) {
        await logFraud(user.id, eventId, 'SHARED_DEVICE', req);
        return res.status(403).json(shared);
      }
    }

    const maskedEmail = maskEmail(user.email);

    const recent = await prisma.otpToken.findFirst({
      where: {
        userId: user.id,
        purpose: OTP_PURPOSE,
        used: false,
        createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (recent) {
      const retryAfter = Math.ceil((recent.createdAt.getTime() + RESEND_COOLDOWN_MS - Date.now()) / 1000);
      return res.status(429).json({
        success: false,
        error: 'OTP_COOLDOWN',
        message: `Mã vừa được gửi tới ${maskedEmail}. Bạn có thể yêu cầu mã mới sau ${retryAfter} giây.`,
        maskedEmail,
        retryAfter,
      });
    }

    await prisma.otpToken.deleteMany({ where: { userId: user.id, purpose: OTP_PURPOSE, used: false } });

    const otp = generateOtp();
    await prisma.otpToken.create({
      data: {
        userId: user.id,
        token: otp,
        // Buộc nhập đúng trên máy đã quét: mã bị chuyển tiếp sang máy khác vô dụng.
        deviceId,
        purpose: OTP_PURPOSE,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });

    try {
      await emailService.sendCheckinOtpEmail(user.email, user.name, otp, event);
    } catch (emailErr) {
      console.error('Failed to send check-in OTP email:', emailErr);
      await prisma.otpToken.deleteMany({ where: { userId: user.id, token: otp, purpose: OTP_PURPOSE } });
      return res.status(500).json({
        success: false,
        error: 'EMAIL_FAILED',
        message: 'Không gửi được email. Vui lòng thử lại sau hoặc đăng nhập bằng mật khẩu.',
      });
    }

    return res.json({
      success: true,
      maskedEmail,
      retryAfter: RESEND_COOLDOWN_MS / 1000,
      message: `Đã gửi mã xác minh tới ${maskedEmail}.`,
    });
  } catch (err) {
    console.error('Request check-in OTP error:', err);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Lỗi server. Vui lòng thử lại.' });
  }
}

const INVALID_OTP = {
  success: false,
  error: 'INVALID_CHECKIN_OTP',
  message: 'Mã xác minh không đúng hoặc đã hết hạn.',
};

// POST /api/public/checkin-otp/verify → thẻ điểm danh cho đúng sự kiện + thiết bị.
async function verifyCheckinOtp(req, res) {
  try {
    const { eventId, deviceId, identifier, otp } = req.body || {};

    if (!eventId || !deviceId || !identifier || !otp) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAMS', message: 'Thiếu thông tin' });
    }

    const event = await loadOtpEvent(eventId, res);
    if (!event) return undefined;

    const user = await findUserByIdentifier(identifier);
    const record = user
      ? await prisma.otpToken.findFirst({
        where: {
          userId: user.id,
          deviceId,
          purpose: OTP_PURPOSE,
          used: false,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      })
      : null;

    if (!record) return res.status(400).json(INVALID_OTP);

    if (!safeEqual(String(otp).trim(), record.token)) {
      // Đếm sai theo từng mã: 6 chữ số không chịu nổi dò vét nếu chỉ chặn theo IP
      // (cả lớp chung wifi) hay theo deviceId (tự đổi được).
      const attempts = (record.attempts || 0) + 1;
      const burned = attempts >= MAX_ATTEMPTS;
      await prisma.otpToken.update({
        where: { id: record.id },
        data: { attempts, ...(burned && { used: true }) },
      });
      if (burned) {
        return res.status(400).json({
          success: false,
          error: 'OTP_TOO_MANY_ATTEMPTS',
          message: `Bạn đã nhập sai ${MAX_ATTEMPTS} lần. Vui lòng yêu cầu mã mới.`,
        });
      }
      return res.status(400).json({ ...INVALID_OTP, attemptsLeft: MAX_ATTEMPTS - attempts });
    }

    await prisma.otpToken.update({ where: { id: record.id }, data: { used: true } });

    const { pass, expiresAt } = issuePass(user.id, eventId, deviceId);
    return res.json({ success: true, pass, expiresAt, user: { name: user.name } });
  } catch (err) {
    console.error('Verify check-in OTP error:', err);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Lỗi server. Vui lòng thử lại.' });
  }
}

const PASS_INVALID = {
  success: false,
  error: 'PASS_INVALID',
  message: 'Phiên xác minh đã hết hạn. Vui lòng nhập email để nhận mã mới.',
};

// POST /api/public/self-checkin — như POST /api/checkin nhưng danh tính lấy từ
// thẻ điểm danh thay vì JWT. Cùng lõi performSelfCheckin nên cùng mã lỗi.
async function checkinWithPass(req, res) {
  try {
    const { eventId, type, deviceId, pass, ticket, token, gps } = req.body || {};

    if (!eventId || !validType(type) || !deviceId || !pass || (!ticket && !token)) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAMS', message: 'Thiếu thông tin' });
    }

    const userId = validatePass(pass, eventId, deviceId);
    if (!userId) return res.status(400).json(PASS_INVALID);

    if (!scanProofValid({ ticket, token, eventId, type, deviceId })) {
      await logFraud(userId, eventId, ticket ? 'INVALID_SCAN_TICKET' : 'INVALID_QR_TOKEN', req, {
        token: ticket || token,
      });
      return res.status(400).json(qrExpiredBody(!!ticket));
    }

    const event = await loadOtpEvent(eventId, res);
    if (!event) return undefined;

    // Tài khoản bị khoá sau khi thẻ được cấp thì thẻ cũng hết tác dụng.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, mssv: true, isActive: true },
    });
    if (!user?.isActive) return res.status(400).json(PASS_INVALID);

    const { status, body } = await performSelfCheckin({
      event, user, type, gps, deviceId, req, requireDeviceBinding: false,
    });
    return res.status(status).json(body);
  } catch (err) {
    console.error('Pass check-in error:', err);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: 'Lỗi server. Vui lòng thử lại.' });
  }
}

// Middleware cho form đánh giá sau check-out bằng thẻ: đặt req.user như authenticate
// để dùng lại nguyên handler của feedback.controller. Trả 400 chứ không 401 — 401
// làm api.js ở frontend xoá phiên và đá về /login.
async function authenticateCheckinPass(req, res, next) {
  const userId = validatePass(req.headers['x-checkin-pass'], req.params.id, req.headers['x-device-id']);
  if (!userId) return res.status(400).json(PASS_INVALID);
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, mssv: true, role: true, isActive: true },
    });
    if (!user?.isActive) return res.status(400).json(PASS_INVALID);
    req.user = user;
    return next();
  } catch (err) {
    console.error('Check-in pass auth error:', err);
    return res.status(503).json({ success: false, error: 'SERVICE_UNAVAILABLE', message: 'Máy chủ đang bận. Vui lòng thử lại.' });
  }
}

module.exports = {
  requestCheckinOtp, verifyCheckinOtp, checkinWithPass, authenticateCheckinPass, maskEmail,
};
