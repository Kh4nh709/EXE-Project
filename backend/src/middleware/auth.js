const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Chưa đăng nhập' });
  }

  const token = authHeader.split(' ')[1];

  // Verify JWT trước — lỗi JWT trả 401 (token sai/hết hạn)
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (jwtErr) {
    return res.status(401).json({ success: false, message: 'Token không hợp lệ hoặc đã hết hạn' });
  }

  // Tra cứu DB — lỗi DB trả 503 (không logout người dùng)
  try {
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, mssv: true, email: true, name: true, role: true, isActive: true, isFirstLogin: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'Tài khoản không hợp lệ hoặc đã bị khoá' });
    }
    // Người tham gia (role STUDENT) không có tài khoản đăng nhập từ 2026-11-07 — chặn cả
    // JWT cũ còn hạn được cấp trước thay đổi (lib/participants.js).
    if (user.role === 'STUDENT') {
      return res.status(401).json({ success: false, message: 'Người tham gia không cần đăng nhập. Hãy quét mã QR tại sự kiện.' });
    }

    req.user = user;
    next();
  } catch (dbErr) {
    console.error('DB error in authenticate:', dbErr);
    return res.status(503).json({ success: false, message: 'Lỗi kết nối cơ sở dữ liệu, thử lại sau' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Không có quyền truy cập' });
    }
    next();
  };
}

module.exports = { authenticate, authorize };
