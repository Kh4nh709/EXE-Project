const router = require('express').Router();
const multer = require('multer');
const { authenticate, authorize } = require('../middleware/auth');
const {
  listClasses, createClass, getClass, updateClass, deleteClass,
  listMembers, addMembers, importMembers, removeMembers,
  createSession, listSessions,
} = require('../controllers/class.controller');

// Quản lý lớp là nghiệp vụ của BTC/Admin, giống hệt phạm vi quyền của
// /api/events — người tham gia không có tài khoản nên không vào được đây.
router.use(authenticate, authorize('ADMIN', 'BTC'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single('file');
const uploadMemberFile = (req, res, next) => upload(req, res, (err) => {
  if (!err) return next();
  const message = err.code === 'LIMIT_FILE_SIZE' ? 'File danh sách tối đa 5MB' : 'Upload file thất bại';
  return res.status(400).json({ success: false, message });
});

router.get('/', listClasses);
router.post('/', createClass);
router.get('/:id', getClass);
router.put('/:id', updateClass);
router.delete('/:id', deleteClass);

// Danh sách lớp: nhập bằng email + họ tên (lib/participants.js).
router.get('/:id/members', listMembers);
router.post('/:id/members', addMembers);
router.post('/:id/members/import', uploadMemberFile, importMembers);
router.post('/:id/members/remove', removeMembers);

router.get('/:id/sessions', listSessions);
router.post('/:id/sessions', createSession);

module.exports = router;
