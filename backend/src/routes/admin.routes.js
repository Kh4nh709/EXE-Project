const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  listUsers, createUser, updateUser, deleteUser, resetPassword, resetDeviceBinding, getStats,
  bulkUpdateUsers, bulkResetPasswords, bulkResetDevices, bulkDeleteUsers,
} = require('../controllers/admin.controller');
const {
  importFaceProfiles, getUserFaceProfile, setUserFaceProfile, deleteUserFaceProfile,
} = require('../controllers/face.controller');
// Giám sát server không cần SSH — chỉ đọc chỉ số cố định, không chạy lệnh system.
const { getServerStats } = require('../controllers/serverStats.controller');

router.use(authenticate, authorize('ADMIN'));

router.get('/server-stats', getServerStats);
router.get('/stats', getStats);
router.get('/users', listUsers);
router.post('/users', createUser);
// Ảnh thẻ theo MSSV: trình duyệt admin tính embedding, chỉ gửi vector + thumbnail lên.
router.post('/face-profiles/import', importFaceProfiles);

// PHẢI đứng trước các route '/users/:id/...': '/users/bulk/reset-password' khớp
// với '/users/:id/reset-password' (id = "bulk") nếu đăng ký sau.
router.post('/users/bulk/update', bulkUpdateUsers);
router.post('/users/bulk/reset-password', bulkResetPasswords);
router.post('/users/bulk/reset-device', bulkResetDevices);
router.post('/users/bulk/delete', bulkDeleteUsers);

router.put('/users/:id', updateUser);
router.delete('/users/:id', deleteUser);
router.post('/users/:id/reset-password', resetPassword);
router.post('/users/:id/reset-device', resetDeviceBinding);
// Ảnh khuôn mặt từng người: PUT nhận vector + thumbnail do trình duyệt admin tính, như import.
router.get('/users/:id/face-profile', getUserFaceProfile);
router.put('/users/:id/face-profile', setUserFaceProfile);
router.delete('/users/:id/face-profile', deleteUserFaceProfile);

module.exports = router;
