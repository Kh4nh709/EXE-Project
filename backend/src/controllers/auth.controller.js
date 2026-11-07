const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');
const emailService = require('../services/email.service');

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    // 1 day → sessions auto-expire daily. The frontend reads this `exp` claim
    // to auto-logout an idle tab and to refuse a stale cached session on load.
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
  });
}

async function login(req, res) {
  try {
    const { identifier, password, deviceId, deviceInfo } = req.body;
    const now = new Date();

    if (!identifier || !password || !deviceId) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin đăng nhập' });
    }

    // Chỉ ADMIN/BTC/LECTURER có tài khoản; người tham gia (STUDENT) trả cùng lỗi như
    // sai mật khẩu và không bị đếm khoá — không lộ email nào là người tham gia.
    const user = await prisma.user.findFirst({
      where: {
        OR: [{ mssv: identifier }, { email: identifier }],
        isActive: true,
        role: { not: 'STUDENT' },
      },
    });

    if (!user) {
      return res.status(401).json({ success: false, message: 'Email hoặc mật khẩu không đúng' });
    }

    if (user.lockedUntil && user.lockedUntil > now) {
      const mins = Math.max(1, Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60000));
      return res.status(429).json({
        success: false,
        error: 'ACCOUNT_LOCKED',
        message: `Tài khoản tạm khoá do đăng nhập sai nhiều lần. Thử lại sau ${mins} phút.`,
      });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      const failed = (user.failedLoginAttempts || 0) + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: failed >= 5
          ? { failedLoginAttempts: 0, lockedUntil: new Date(now.getTime() + 15 * 60 * 1000) }
          : { failedLoginAttempts: failed },
      });
      return res.status(401).json({ success: false, message: 'Email hoặc mật khẩu không đúng' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });

    // Check device binding
    const existingBinding = await prisma.deviceBinding.findFirst({
      where: { userId: user.id, isTrusted: true },
    });

    if (existingBinding && existingBinding.deviceId !== deviceId) {
      // New device → send OTP
      await prisma.otpToken.deleteMany({
        where: { userId: user.id, purpose: 'DEVICE_BIND', used: false },
      });

      const otp = generateOtp();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

      await prisma.otpToken.create({
        data: { userId: user.id, token: otp, deviceId, purpose: 'DEVICE_BIND', expiresAt },
      });

      try {
        await emailService.sendOtpEmail(user.email, user.name, otp);
      } catch (emailErr) {
        console.error('Failed to send OTP email:', emailErr);
        await prisma.otpToken.deleteMany({
          where: { userId: user.id, token: otp, purpose: 'DEVICE_BIND' },
        });
        return res.status(500).json({
          success: false,
          message: 'Không gửi được email OTP. Vui lòng thử lại sau.',
        });
      }

      return res.json({
        success: false,
        requireOtp: true,
        userId: user.id,
        message: `Thiết bị mới được phát hiện. Mã OTP đã gửi đến ${user.email}`,
      });
    }

    // Bind device if first login or same device
    await prisma.deviceBinding.upsert({
      where: { userId_deviceId: { userId: user.id, deviceId } },
      create: { userId: user.id, deviceId, deviceInfo, isTrusted: true },
      update: { isTrusted: true, deviceInfo },
    });

    const token = signToken(user.id);

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        mssv: user.mssv,
        email: user.email,
        name: user.name,
        role: user.role,
        isFirstLogin: user.isFirstLogin,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function verifyOtp(req, res) {
  try {
    const { userId, otp, deviceId, deviceInfo } = req.body;

    const otpRecord = await prisma.otpToken.findFirst({
      where: {
        userId,
        token: otp,
        deviceId,
        purpose: 'DEVICE_BIND',
        used: false,
        expiresAt: { gt: new Date() },
      },
    });

    if (!otpRecord) {
      return res.status(400).json({ success: false, message: 'Mã OTP không đúng hoặc đã hết hạn' });
    }

    await prisma.otpToken.update({ where: { id: otpRecord.id }, data: { used: true } });

    await prisma.deviceBinding.upsert({
      where: { userId_deviceId: { userId, deviceId } },
      create: { userId, deviceId, deviceInfo, isTrusted: true },
      update: { isTrusted: true, deviceInfo },
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, mssv: true, email: true, name: true, role: true, isFirstLogin: true },
    });

    const token = signToken(userId);

    return res.json({ success: true, token, user });
  } catch (err) {
    console.error('OTP verify error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const isValid = await bcrypt.compare(currentPassword, user.passwordHash);

    if (!isValid) {
      return res.status(400).json({ success: false, message: 'Mật khẩu hiện tại không đúng' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Mật khẩu mới phải ít nhất 6 ký tự' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash, isFirstLogin: false },
    });

    return res.json({ success: true, message: 'Đổi mật khẩu thành công' });
  } catch (err) {
    console.error('Change password error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Quên mật khẩu: gửi OTP về email → người dùng tự đặt mật khẩu mới.
// Cố tình KHÔNG gửi mật khẩu thật qua email (khác admin reset) và luôn trả về
// cùng một thông điệp dù tài khoản có tồn tại hay không, để không lộ danh sách
// email/MSSV đang có trong hệ thống.
// ─────────────────────────────────────────────────────────────────────────────

const RESET_OTP_TTL_MS = 15 * 60 * 1000;
const GENERIC_FORGOT_MESSAGE =
  'Nếu tài khoản tồn tại, mã đặt lại mật khẩu đã được gửi tới email đăng ký. Hãy kiểm tra hộp thư đến và thư rác.';

// Không bao giờ trả người tham gia (STUDENT): đặt lại mật khẩu cho họ là mở đường
// đăng nhập cho một người vốn không được có tài khoản.
function findActiveUserByIdentifier(identifier) {
  return prisma.user.findFirst({
    where: {
      OR: [{ mssv: identifier }, { email: identifier }],
      isActive: true,
      role: { not: 'STUDENT' },
    },
  });
}

async function forgotPassword(req, res) {
  try {
    const { identifier, deviceId } = req.body || {};

    if (!identifier || typeof identifier !== 'string') {
      return res.status(400).json({ success: false, message: 'Vui lòng nhập MSSV hoặc email' });
    }

    const user = await findActiveUserByIdentifier(identifier.trim());

    // Không có tài khoản → vẫn trả 200 với đúng thông điệp như trường hợp có.
    if (!user) {
      return res.json({ success: true, message: GENERIC_FORGOT_MESSAGE });
    }

    await prisma.otpToken.deleteMany({
      where: { userId: user.id, purpose: 'PASSWORD_RESET', used: false },
    });

    const otp = generateOtp();
    await prisma.otpToken.create({
      data: {
        userId: user.id,
        token: otp,
        // deviceId chỉ để truy vết — mã reset KHÔNG buộc phải nhập lại đúng
        // thiết bị, vì người dùng có thể mở email trên máy khác.
        deviceId: deviceId || 'unknown',
        purpose: 'PASSWORD_RESET',
        expiresAt: new Date(Date.now() + RESET_OTP_TTL_MS),
      },
    });

    try {
      await emailService.sendPasswordResetOtpEmail(user.email, user.name, otp);
    } catch (emailErr) {
      console.error('Failed to send password reset OTP email:', emailErr);
      await prisma.otpToken.deleteMany({
        where: { userId: user.id, token: otp, purpose: 'PASSWORD_RESET' },
      });
      return res.status(500).json({
        success: false,
        error: 'EMAIL_FAILED',
        message: 'Không gửi được email. Vui lòng thử lại sau.',
      });
    }

    return res.json({ success: true, message: GENERIC_FORGOT_MESSAGE });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function resetPassword(req, res) {
  try {
    const { identifier, otp, newPassword } = req.body || {};

    if (!identifier || !otp || !newPassword) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin đặt lại mật khẩu' });
    }

    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Mật khẩu mới phải ít nhất 6 ký tự' });
    }

    const user = await findActiveUserByIdentifier(String(identifier).trim());

    // Sai identifier và sai OTP trả về cùng một lỗi — không phân biệt được
    // "không có tài khoản này" với "mã sai".
    const otpRecord = user
      ? await prisma.otpToken.findFirst({
          where: {
            userId: user.id,
            token: String(otp).trim(),
            purpose: 'PASSWORD_RESET',
            used: false,
            expiresAt: { gt: new Date() },
          },
        })
      : null;

    if (!otpRecord) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_RESET_OTP',
        message: 'Mã xác thực không đúng hoặc đã hết hạn',
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await prisma.otpToken.update({ where: { id: otpRecord.id }, data: { used: true } });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        // Người dùng vừa tự chọn mật khẩu nên không bắt đổi lại lần sau; đồng
        // thời gỡ luôn khoá 15 phút do đăng nhập sai — quên mật khẩu và bị khoá
        // thường đi cùng nhau.
        isFirstLogin: false,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    return res.json({ success: true, message: 'Đặt lại mật khẩu thành công. Hãy đăng nhập lại.' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

async function getMe(req, res) {
  return res.json({ success: true, user: req.user });
}

module.exports = {
  login,
  verifyOtp,
  changePassword,
  forgotPassword,
  resetPassword,
  getMe,
};
