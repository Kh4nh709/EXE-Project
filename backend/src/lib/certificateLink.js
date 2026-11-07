const crypto = require('crypto');
const { safeEqual } = require('./scanTicket');

// Link xem chứng nhận gửi trong email: người tham gia không có tài khoản nên không
// vào được /my-certificates — link tự mang quyền xem đúng MỘT chứng nhận.
// Ký HMAC theo id chứng nhận, không lưu gì: thu hồi chứng nhận (xoá bản ghi) là link
// chết theo, nên không cần cột token thu hồi được như reportShareToken.
// Tiền tố "cert:" để chữ ký không bao giờ trùng vé quét / thẻ điểm danh.
function sign(certId) {
  return crypto
    .createHmac('sha256', process.env.QR_SECRET)
    .update(`cert:${certId}`)
    .digest('hex')
    .substring(0, 32);
}

function certificateToken(certId) {
  return `${certId}.${sign(certId)}`;
}

// Trả id chứng nhận nếu token hợp lệ, ngược lại null.
function certificateIdFromToken(token) {
  if (typeof token !== 'string') return null;
  const [certId, signature, extra] = token.split('.');
  if (!certId || !signature || extra !== undefined) return null;
  return safeEqual(sign(certId), signature) ? certId : null;
}

function certificateViewUrl(certId) {
  const base = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.replace(/\/$/, '') : null;
  return base ? `${base}/chung-nhan/${certificateToken(certId)}` : null;
}

module.exports = { certificateToken, certificateIdFromToken, certificateViewUrl };
