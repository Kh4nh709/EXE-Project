const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const {
  getCertificate, getCertificateBackground, downloadCertificatePdf,
} = require('../controllers/certificate.controller');

// ADMIN / người tạo sự kiện xem chứng nhận (quyền kiểm tra trong controller).
// Người nhận xem qua link trong email: /api/public/certificates/:token.
router.use(authenticate);

router.get('/:id', getCertificate);
router.get('/:id/background', getCertificateBackground);
router.get('/:id/pdf', downloadCertificatePdf);

module.exports = router;
