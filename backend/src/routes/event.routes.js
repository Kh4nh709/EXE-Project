const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  listEvents, createEvent, getEvent, updateEvent, deleteEvent,
  getQRToken, getLiveCheckins, getAttendance, manualCheckin, undoCheckin,
  listMembers, addMembers, removeMember, searchUsersForEvent,
  listClasses, addMembersByClass,
} = require('../controllers/event.controller');
const { registerSelf } = require('../controllers/registration.controller');
const { getReminders, sendReminderNow } = require('../controllers/reminder.controller');
const { getFaceGallery, getFaceThumbnail, faceCheckin } = require('../controllers/face.controller');
const multer = require('multer');
const { getPublicFormSetup, savePublicForm, addCheckinByStaff } = require('../controllers/publicCheckin.controller');
const {
  getCertificateSetup, getTemplateImage, uploadTemplateImage, saveTemplateFields, deleteTemplate,
  previewPdf, issueCertificates, listEventCertificates, revokeCertificate,
} = require('../controllers/certificate.controller');

const {
  listGuests, addGuest, importGuests, updateGuest, deleteGuest, rotateGuestCode,
  scanGuest, checkInGuestManually, undoGuestCheckIn, addWalkInGuest, getScannerSummary,
  downloadGuestInvitation, downloadAllInvitations, downloadInvitationsZip, getInvitationCards, sendInvitations,
  getSeats, saveSeatMap, setGuestSeats,
} = require('../controllers/guest.controller');
const {
  getInvitationTemplate, getInvitationTemplateImage, uploadInvitationTemplateImage,
  saveInvitationTemplateFields, deleteInvitationTemplate, previewInvitation,
  getScannerLink, createScannerLink, revokeScannerLink,
} = require('../controllers/invitation.controller');

// File upload giữ trong RAM rồi ghi thẳng vào DB / đọc ngay (Render không có ổ đĩa bền).
function memoryUpload(tooLargeMessage, failMessage) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single('file');
  return (req, res, next) => upload(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? tooLargeMessage : failMessage;
    return res.status(400).json({ success: false, message });
  });
}
const uploadCertificateImage = memoryUpload('Ảnh mẫu tối đa 5MB', 'Upload ảnh thất bại');
const uploadGuestFile = memoryUpload('File danh sách tối đa 5MB', 'Upload file thất bại');

router.use(authenticate);

router.get('/', listEvents);
router.post('/', authorize('ADMIN', 'BTC'), createEvent);
router.get('/:id', getEvent);
router.put('/:id', authorize('ADMIN', 'BTC'), updateEvent);
router.delete('/:id', authorize('ADMIN', 'BTC'), deleteEvent);
router.get('/:id/qr', authorize('ADMIN', 'BTC'), getQRToken);
// Màn hình trình chiếu: người vừa check-in (chỉ tên) để hiện lời chào.
router.get('/:id/live', authorize('ADMIN', 'BTC'), getLiveCheckins);
router.get('/:id/attendance', authorize('ADMIN', 'BTC', 'LECTURER'), getAttendance);
router.post('/:id/manual-checkin', authorize('ADMIN', 'BTC'), manualCheckin);
// Gỡ lượt check-in của một người — đưa về REGISTERED, không xoá khỏi danh sách.
router.delete('/:id/attendance/:userId/checkin', authorize('ADMIN', 'BTC'), undoCheckin);
// Kiosk check-in bằng khuôn mặt: vector do trình duyệt so khớp, xem lib/faceProfile.js.
router.get('/:id/face-gallery', authorize('ADMIN', 'BTC'), getFaceGallery);
router.get('/:id/face-gallery/:userId/thumbnail', authorize('ADMIN', 'BTC'), getFaceThumbnail);
router.post('/:id/face-checkin', authorize('ADMIN', 'BTC'), faceCheckin);

// Người dùng đã đăng nhập tự ghi tên vào danh sách tham gia.
router.post('/:id/register', registerSelf);

router.get('/:id/members', authorize('ADMIN', 'BTC', 'LECTURER'), listMembers);
router.get('/:id/members/search', authorize('ADMIN', 'BTC'), searchUsersForEvent);
router.get('/:id/classes', authorize('ADMIN', 'BTC'), listClasses);
router.post('/:id/members', authorize('ADMIN', 'BTC'), addMembers);
router.post('/:id/members/by-class', authorize('ADMIN', 'BTC'), addMembersByClass);
router.delete('/:id/members/:userId', authorize('ADMIN', 'BTC'), removeMember);

// Nhắc lịch qua email — BTC gửi thủ công, không có nhắc tự động.
router.get('/:id/reminders', authorize('ADMIN', 'BTC'), getReminders);
router.post('/:id/reminders/send', authorize('ADMIN', 'BTC'), sendReminderNow);

// Chứng nhận tham gia — tuỳ chọn: sự kiện không upload mẫu thì không có chứng nhận.
const certManager = authorize('ADMIN', 'BTC');
router.get('/:id/certificate', certManager, getCertificateSetup);
router.get('/:id/certificate/image', certManager, getTemplateImage);
router.put('/:id/certificate/image', certManager, uploadCertificateImage, uploadTemplateImage);
router.put('/:id/certificate/fields', certManager, saveTemplateFields);
router.delete('/:id/certificate', certManager, deleteTemplate);
router.get('/:id/certificate/preview', certManager, previewPdf);
router.post('/:id/certificates/issue', certManager, issueCertificates);
router.get('/:id/certificates', certManager, listEventCertificates);
router.delete('/:id/certificates/:certId', certManager, revokeCertificate);

// Sự kiện thiệp mời: khách ngoài + thiệp QR, BTC quét thiệp để check-in.
// Mọi handler tự kiểm ADMIN-hoặc-người-tạo và kind = INVITATION (loadInvitationEvent).
// Các đường /guests/<chữ> phải đăng ký TRƯỚC /guests/:guestId.
const guestManager = authorize('ADMIN', 'BTC');
router.get('/:id/guests', guestManager, listGuests);
router.post('/:id/guests', guestManager, addGuest);
router.post('/:id/guests/import', guestManager, uploadGuestFile, importGuests);
router.post('/:id/guests/scan', guestManager, scanGuest);
router.post('/:id/guests/walk-in', guestManager, addWalkInGuest);
router.put('/:id/guests/:guestId', guestManager, updateGuest);
router.delete('/:id/guests/:guestId', guestManager, deleteGuest);
router.put('/:id/guests/:guestId/seats', guestManager, setGuestSeats);
router.post('/:id/guests/:guestId/rotate-code', guestManager, rotateGuestCode);
router.post('/:id/guests/:guestId/checkin', guestManager, checkInGuestManually);
router.delete('/:id/guests/:guestId/checkin', guestManager, undoGuestCheckIn);
router.get('/:id/guests/:guestId/invitation.pdf', guestManager, downloadGuestInvitation);
router.get('/:id/scanner-summary', guestManager, getScannerSummary);
router.get('/:id/seats', guestManager, getSeats);
router.put('/:id/seat-map', guestManager, saveSeatMap);
router.get('/:id/invitations/pdf', guestManager, downloadAllInvitations);
router.get('/:id/invitations/zip', guestManager, downloadInvitationsZip);
router.get('/:id/invitations/cards', guestManager, getInvitationCards);
router.post('/:id/invitations/send', guestManager, sendInvitations);
router.get('/:id/invitation-template', guestManager, getInvitationTemplate);
router.get('/:id/invitation-template/image', guestManager, getInvitationTemplateImage);
router.put('/:id/invitation-template/image', guestManager, uploadCertificateImage, uploadInvitationTemplateImage);
router.put('/:id/invitation-template/fields', guestManager, saveInvitationTemplateFields);
router.delete('/:id/invitation-template', guestManager, deleteInvitationTemplate);
router.get('/:id/invitation-template/preview', guestManager, previewInvitation);
router.get('/:id/scanner-link', guestManager, getScannerLink);
router.post('/:id/scanner-link', guestManager, createScannerLink);
router.delete('/:id/scanner-link', guestManager, revokeScannerLink);

// Check-in công khai: form BTC dựng + BTC thêm tay. Danh sách/xoá dùng lại /guests.
router.get('/:id/public-form', guestManager, getPublicFormSetup);
router.put('/:id/public-form', guestManager, savePublicForm);
router.post('/:id/public-checkins', guestManager, addCheckinByStaff);

module.exports = router;
