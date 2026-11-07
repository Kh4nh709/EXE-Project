const crypto = require('crypto');

// "Vé quét mã": đổi một token QR CÒN HẠN lấy một vé sống lâu hơn, ngay tại thời
// điểm camera vừa đọc được mã.
//
// Lý do tồn tại: token QR chỉ sống ~90s tính từ lúc MÀN HÌNH sinh ra nó, trong
// khi giữa lúc quét và lúc thực sự điểm danh người dùng còn phải đăng nhập
// (đọc mã OTP trong hộp thư có thể mất vài phút) và bấm cho phép GPS. Hết 90s
// đó là bắt họ quay lại quét mã lần nữa. Đổi sang vé làm đồng hồ chạy từ lúc
// QUÉT chứ không phải lúc sinh mã, nên độ trễ đăng nhập không còn ăn vào hạn
// của mã QR — và quan trọng là mã QR vẫn giữ được hạn ngắn để ảnh chụp màn hình
// gửi cho bạn bè nửa tiếng sau vẫn vô dụng.
//
// Vé không lưu vào DB, tự chứa và ký HMAC giống token QR.
const TICKET_TTL_MS = 15 * 60 * 1000;

// Băm deviceId để phần ký có độ dài cố định và không có ký tự ':' của deviceId
// lọt vào giữa các trường làm lệch payload lúc ký.
function deviceFingerprint(deviceId) {
  return crypto.createHash('sha256').update(String(deviceId)).digest('hex').substring(0, 16);
}

function sign(eventId, type, deviceId, expiresAt) {
  const message = `${eventId}:${type}:${deviceFingerprint(deviceId)}:${expiresAt}`;
  return crypto
    .createHmac('sha256', process.env.QR_SECRET)
    .update(message)
    .digest('hex')
    .substring(0, 32);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function issueTicket(eventId, type, deviceId) {
  const expiresAt = Date.now() + TICKET_TTL_MS;
  return { ticket: `${expiresAt}.${sign(eventId, type, deviceId, expiresAt)}`, expiresAt };
}

// Vé chỉ hợp lệ với đúng sự kiện, đúng loại (checkin/checkout) và đúng thiết bị
// đã quét — chuyển vé cho máy khác không dùng được.
function validateTicket(ticket, eventId, type, deviceId) {
  if (typeof ticket !== 'string') return false;

  const [expiresRaw, signature] = ticket.split('.');
  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt) || !signature) return false;
  if (Date.now() > expiresAt) return false;

  return safeEqual(sign(eventId, type, deviceId, expiresAt), signature);
}

module.exports = { issueTicket, validateTicket, TICKET_TTL_MS, deviceFingerprint, safeEqual };
