const crypto = require('crypto');
const { deviceFingerprint, safeEqual } = require('./scanTicket');

// "Thẻ điểm danh": bằng chứng một người đã xác minh email bằng OTP trên đúng
// thiết bị này, cho đúng sự kiện này — dùng thay JWT ở luồng check-in không cần
// đăng nhập (spec 2026-11-07-otp-checkin-design.md).
//
// Tách khỏi bước ghi điểm danh để:
//   - đứng ngoài bán kính GPS thì lại gần rồi thử lại, không phải gửi OTP mới;
//   - check-out cuối buổi và form đánh giá dùng lại thẻ, không tốn email thứ hai
//     (gói Brevo có hạn mức email/ngày).
// Thẻ CHỈ chứng minh danh tính; mọi điều kiện khác (vé quét, danh sách, cổng, GPS)
// vẫn kiểm lại ở mỗi lần dùng. Không lưu DB, ký HMAC như vé quét — tiền tố "pass:"
// để chữ ký của thẻ không bao giờ trùng chữ ký của vé quét.
const PASS_TTL_MS = 24 * 60 * 60 * 1000;

function sign(userId, eventId, deviceId, expiresAt) {
  const message = `pass:${userId}:${eventId}:${deviceFingerprint(deviceId)}:${expiresAt}`;
  return crypto
    .createHmac('sha256', process.env.QR_SECRET)
    .update(message)
    .digest('hex')
    .substring(0, 32);
}

function issuePass(userId, eventId, deviceId) {
  const expiresAt = Date.now() + PASS_TTL_MS;
  return { pass: `${userId}.${expiresAt}.${sign(userId, eventId, deviceId, expiresAt)}`, expiresAt };
}

// Trả userId nếu thẻ hợp lệ với đúng sự kiện + thiết bị, ngược lại null.
function validatePass(pass, eventId, deviceId) {
  if (typeof pass !== 'string' || !eventId || !deviceId) return null;

  const [userId, expiresRaw, signature, extra] = pass.split('.');
  if (!userId || !signature || extra !== undefined) return null;
  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt) || Date.now() > expiresAt) return null;

  return safeEqual(sign(userId, eventId, deviceId, expiresAt), signature) ? userId : null;
}

module.exports = { issuePass, validatePass, PASS_TTL_MS };
