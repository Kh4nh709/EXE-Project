const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const {
  listOpenEvents, getPublicEvent, registerPublic,
} = require('../controllers/registration.controller');
// Đổi token QR lấy vé quét phải gọi được khi chưa đăng nhập, nên đặt ở đây để
// giữ nguyên quy ước "/api/public/* là router duy nhất không cần auth".
const { issueScanTicket } = require('../controllers/checkin.controller');
// Báo cáo được BTC chia sẻ bằng link công khai: người xem không có tài khoản.
const { getSharedReport } = require('../controllers/report.controller');
const { getPublicCheckinPage, submitPublicCheckin } = require('../controllers/publicCheckin.controller');
// Check-in bằng email + OTP, không cần đăng nhập (spec 2026-11-07-otp-checkin-design.md).
const {
  requestCheckinOtp, verifyCheckinOtp, checkinWithPass, authenticateCheckinPass,
} = require('../controllers/checkinOtp.controller');
const { getMyResponse, submitResponse } = require('../controllers/feedback.controller');
// Sự kiện thiệp mời: khách xem thiệp của mình, tình nguyện viên quét qua link.
const {
  publicScannerSummary, publicScan, publicSearchGuests, publicCheckInGuest, publicWalkIn,
  getPublicInvitation, getPublicInvitationPdf,
} = require('../controllers/invitation.controller');

// Endpoint đăng ký công khai có thể tạo tài khoản mới → siết chặt hơn rate limit
// chung của /api để chặn spam tạo user hàng loạt từ một IP.
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PUBLIC_REGISTER_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Bạn đã gửi quá nhiều yêu cầu đăng ký. Vui lòng thử lại sau 15 phút.' },
});

// Quét mã là hành động một lần mỗi sự kiện nên trần đặt rộng tay: cả lớp dùng
// chung wifi trường sẽ ra cùng một IP. Khoá theo deviceId khi có (mỗi máy một
// UUID riêng), chỉ lùi về IP khi client không gửi.
const scanTicketLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.SCAN_TICKET_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.body?.deviceId || req.ip,
  message: { success: false, message: 'Bạn đã quét quá nhiều lần. Vui lòng thử lại sau.' },
});

router.post('/scan-ticket', scanTicketLimiter, issueScanTicket);

// Mỗi lần gửi mã là một email trong hạn mức Brevo → siết theo máy (cả lớp chung
// wifi nên không khoá theo IP). Dò mã 6 số được chặn chính ở bộ đếm sai của từng
// mã (OtpToken.attempts), trần ở đây chỉ là lớp ngoài.
const byDevice = (req) => req.body?.deviceId || req.headers['x-device-id'] || req.ip;
const limiter = (max, message) => rateLimit({
  windowMs: 15 * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byDevice,
  message: { success: false, message },
});
router.post('/checkin-otp/request',
  limiter(Number(process.env.CHECKIN_OTP_MAX) || 10, 'Bạn đã yêu cầu mã quá nhiều lần. Vui lòng thử lại sau 15 phút.'),
  requestCheckinOtp);
router.post('/checkin-otp/verify',
  limiter(Number(process.env.CHECKIN_OTP_VERIFY_MAX) || 20, 'Bạn đã nhập mã quá nhiều lần. Vui lòng thử lại sau 15 phút.'),
  verifyCheckinOtp);
router.post('/self-checkin',
  limiter(Number(process.env.SELF_CHECKIN_MAX) || 30, 'Bạn đã thử quá nhiều lần. Vui lòng thử lại sau ít phút.'),
  checkinWithPass);
// Form đánh giá sau check-out cho người check-in bằng thẻ (header X-Checkin-Pass).
router.get('/feedback/:id/response', authenticateCheckinPass, getMyResponse);
router.post('/feedback/:id/response', authenticateCheckinPass, submitResponse);

router.get('/events', listOpenEvents);
router.get('/events/:id', getPublicEvent);
router.post('/events/:id/register', registerLimiter, registerPublic);

router.get('/reports/:token', getSharedReport);

// Link quét là công khai (ai có link đều quét được) — trần theo token+IP đủ rộng
// cho một cửa đón vài trăm khách, nhưng chặn việc dò danh sách bằng tìm kiếm.
const scannerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PUBLIC_SCANNER_MAX) || 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.params.token}:${req.ip}`,
  message: { success: false, message: 'Thao tác quá nhanh. Vui lòng thử lại sau ít phút.' },
});
router.get('/scanner/:token', scannerLimiter, publicScannerSummary);
router.post('/scanner/:token/scan', scannerLimiter, publicScan);
router.get('/scanner/:token/guests', scannerLimiter, publicSearchGuests);
router.post('/scanner/:token/guests/:guestId/checkin', scannerLimiter, publicCheckInGuest);
router.post('/scanner/:token/walk-in', scannerLimiter, publicWalkIn);

router.get('/invitations/:code', getPublicInvitation);
router.get('/invitations/:code/pdf', getPublicInvitationPdf);

// Check-in công khai (QR cố định). Cả gian hàng dùng chung wifi sự kiện nên khoá
// theo deviceId (mỗi máy một UUID), chỉ lùi về IP khi client không gửi.
const publicCheckinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PUBLIC_CHECKIN_MAX) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-device-id'] || req.ip,
  message: { success: false, message: 'Bạn đã gửi quá nhiều lần. Vui lòng thử lại sau ít phút.' },
});
router.get('/checkin/:eventId', getPublicCheckinPage);
router.post('/checkin/:eventId', publicCheckinLimiter, submitPublicCheckin);

module.exports = router;
