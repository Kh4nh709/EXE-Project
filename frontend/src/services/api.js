import axios from 'axios';
import { getDeviceId, getDeviceInfo } from '../utils/device';

const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1500;

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '',
  // 25 s gives backend cold-starts (free-tier sleep) enough time to respond.
  timeout: 25000,
});

// Attach auth token + device ID to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  config.headers['X-Device-ID'] = getDeviceId();
  return config;
});

// Handle 401 → logout; retry on 503 / network timeout (backend cold start).
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const { config, response } = err;

    if (response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
      return Promise.reject(err);
    }

    // Retry transient failures: 503 Service Unavailable or network-level timeout.
    // This covers the backend waking from free-tier sleep mid-request.
    const isTransient =
      response?.status === 503 ||
      err.code === 'ECONNABORTED' || // axios timeout
      err.code === 'ERR_NETWORK';

    config._retryCount = config._retryCount ?? 0;

    if (isTransient && config._retryCount < MAX_RETRIES) {
      config._retryCount += 1;
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_BASE_DELAY_MS * config._retryCount)
      );
      return api(config);
    }

    return Promise.reject(err);
  }
);

// Auth
export const authApi = {
  login: (data) => api.post('/api/auth/login', { ...data, deviceId: getDeviceId(), deviceInfo: getDeviceInfo() }),
  verifyOtp: (data) => api.post('/api/auth/verify-otp', { ...data, deviceId: getDeviceId(), deviceInfo: getDeviceInfo() }),
  forgotPassword: (data) => api.post('/api/auth/forgot-password', { ...data, deviceId: getDeviceId() }),
  resetPassword: (data) => api.post('/api/auth/reset-password', data),
  changePassword: (data) => api.post('/api/auth/change-password', data),
  getMe: () => api.get('/api/auth/me'),
};

// Events
export const eventApi = {
  list: (params) => api.get('/api/events', { params }),
  create: (data) => api.post('/api/events', data),
  get: (id) => api.get(`/api/events/${id}`),
  update: (id, data) => api.put(`/api/events/${id}`, data),
  delete: (id) => api.delete(`/api/events/${id}`),
  getQR: (id) => api.get(`/api/events/${id}/qr`),
  // Màn hình trình chiếu: check-in mới nhất (chỉ tên) để hiện lời chào.
  getLive: (id) => api.get(`/api/events/${id}/live`),
  getAttendance: (id, params) => api.get(`/api/events/${id}/attendance`, { params }),
  manualCheckin: (id, data) => api.post(`/api/events/${id}/manual-checkin`, data),
  // Gỡ lượt check-in (kèm check-out) của một người — về lại "Đã đăng ký".
  undoCheckin: (id, userId) => api.delete(`/api/events/${id}/attendance/${userId}/checkin`),
  listMembers: (id, params) => api.get(`/api/events/${id}/members`, { params }),
  // Người tham gia không có tài khoản: nhập bằng email + họ tên (MSSV, SĐT tuỳ chọn).
  // participants: [{ email, name, mssv?, phone? }] → { added, alreadyIn, created, skipped[] }.
  addMembers: (id, participants) => api.post(`/api/events/${id}/members`, { participants }),
  importMembers: (id, file) => {
    const form = new FormData();
    form.append('file', file);
    return api.post(`/api/events/${id}/members/import`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  listClasses: (id) => api.get(`/api/events/${id}/classes`),
  addMembersByClass: (id, classIds) => api.post(`/api/events/${id}/members/by-class`, { classIds }),
  removeMember: (id, userId) => api.delete(`/api/events/${id}/members/${userId}`),
  // Ảnh khuôn mặt của một người trong danh sách (cho kiosk) — data: { embedding, thumbnail }.
  getMemberFace: (id, userId) => api.get(`/api/events/${id}/members/${userId}/face-profile`),
  setMemberFace: (id, userId, data) => api.put(`/api/events/${id}/members/${userId}/face-profile`, data),
  deleteMemberFace: (id, userId) => api.delete(`/api/events/${id}/members/${userId}/face-profile`),
  // Nhắc lịch qua email — BTC gửi thủ công (không có nhắc tự động).
  getReminders: (id) => api.get(`/api/events/${id}/reminders`),
  sendReminder: (id, note) => api.post(`/api/events/${id}/reminders/send`, { note }),
};

// Quản lý lớp học (ADMIN/BTC)
export const classApi = {
  list: (params) => api.get('/api/classes', { params }),
  create: (data) => api.post('/api/classes', data),
  get: (id) => api.get(`/api/classes/${id}`),
  update: (id, data) => api.put(`/api/classes/${id}`, data),
  remove: (id) => api.delete(`/api/classes/${id}`),
  listMembers: (id, params) => api.get(`/api/classes/${id}/members`, { params }),
  // Danh sách lớp: nhập bằng email + họ tên như danh sách sự kiện.
  addMembers: (id, participants) => api.post(`/api/classes/${id}/members`, { participants }),
  importMembers: (id, file) => {
    const form = new FormData();
    form.append('file', file);
    return api.post(`/api/classes/${id}/members/import`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  removeMembers: (id, userIds) => api.post(`/api/classes/${id}/members/remove`, { userIds }),
  listSessions: (id) => api.get(`/api/classes/${id}/sessions`),
  createSession: (id, data) => api.post(`/api/classes/${id}/sessions`, data),
};

// Đăng ký tham gia sự kiện — không cần đăng nhập.
export const publicApi = {
  listEvents: (params) => api.get('/api/public/events', { params }),
  getEvent: (id) => api.get(`/api/public/events/${id}`),
  register: (id, data) => api.post(`/api/public/events/${id}/register`, data),
};

// Checkin
export const checkinApi = {
  // Đổi token QR lấy vé quét NGAY khi vừa quét (chưa cần đăng nhập) — xem
  // lib/scanTicket.js ở backend.
  issueTicket: (data) => api.post('/api/public/scan-ticket', { ...data, deviceId: getDeviceId() }),
  process: (data) => api.post('/api/checkin', { ...data, deviceId: getDeviceId() }),
  getStatus: (eventId) => api.get(`/api/checkin/status/${eventId}`),

  // Check-in không cần đăng nhập: email/MSSV → OTP → thẻ điểm danh (lib/checkinPass.js).
  requestOtp: (data) => api.post('/api/public/checkin-otp/request', { ...data, deviceId: getDeviceId() }),
  verifyOtp: (data) => api.post('/api/public/checkin-otp/verify', { ...data, deviceId: getDeviceId() }),
  processWithPass: (data) => api.post('/api/public/self-checkin', { ...data, deviceId: getDeviceId() }),
};

// Check-in bằng khuôn mặt. Embedding luôn do trình duyệt tính (pages/face/faceEngine.js);
// server chỉ lưu/so vector.
export const faceApi = {
  // Admin import ảnh thẻ theo MSSV — items: [{ mssv, embedding, thumbnail }].
  // overwrite = đè cả ảnh sinh viên đã tự chụp (mặc định bỏ qua những người đó).
  importProfiles: (items, overwrite = false) => api.post('/api/admin/face-profiles/import', { items, overwrite }),
  // Admin xem / thay / xoá ảnh của từng người — data: { embedding, thumbnail }.
  getUserFace: (userId) => api.get(`/api/admin/users/${userId}/face-profile`),
  setUserFace: (userId, data) => api.put(`/api/admin/users/${userId}/face-profile`, data),
  deleteUserFace: (userId) => api.delete(`/api/admin/users/${userId}/face-profile`),
  // Kiosk BTC.
  gallery: (eventId) => api.get(`/api/events/${eventId}/face-gallery`),
  thumbnail: (eventId, userId) => api.get(`/api/events/${eventId}/face-gallery/${userId}/thumbnail`, { responseType: 'blob' }),
  checkIn: (eventId, userId) => api.post(`/api/events/${eventId}/face-checkin`, { userId }),
};

// Admin
export const adminApi = {
  getStats: () => api.get('/api/admin/stats'),
  listUsers: (params) => api.get('/api/admin/users', { params }),
  createUser: (data) => api.post('/api/admin/users', data),
  updateUser: (id, data) => api.put(`/api/admin/users/${id}`, data),
  deleteUser: (id) => api.delete(`/api/admin/users/${id}`),
  resetPassword: (id, data) => api.post(`/api/admin/users/${id}/reset-password`, data),
  resetDevice: (id) => api.post(`/api/admin/users/${id}/reset-device`),
  // Thao tác hàng loạt — payload luôn có userIds; response luôn { updated, skipped[] }.
  bulkUpdate: (userIds, patch) => api.post('/api/admin/users/bulk/update', { userIds, ...patch }),
  bulkResetPassword: (userIds) => api.post('/api/admin/users/bulk/reset-password', { userIds }),
  bulkResetDevice: (userIds) => api.post('/api/admin/users/bulk/reset-device', { userIds }),
  bulkDelete: (userIds) => api.post('/api/admin/users/bulk/delete', { userIds }),
};

// Reports
export const reportApi = {
  exportAttendance: (eventId) => api.get(`/api/reports/events/${eventId}/export`, { responseType: 'blob' }),
  exportAttendanceHtml: (eventId) => api.get(`/api/reports/events/${eventId}/export-html`, { responseType: 'blob' }),
  // Chế độ xem trên web: lấy HTML dưới dạng chuỗi để nhúng vào iframe srcDoc
  // (blob không dùng được cho srcDoc, và tab blob: bị popup blocker chặn).
  viewAttendanceHtml: (eventId) => api.get(`/api/reports/events/${eventId}/export-html`, { params: { view: 1 }, responseType: 'text' }),
  getFraudLogs: (params) => api.get('/api/reports/fraud-logs', { params }),

  // Link chia sẻ báo cáo công khai. POST tạo-hoặc-trả-lại link đang có;
  // rotate = cấp token mới khi link cũ bị lộ; DELETE thu hồi.
  getShare: (eventId) => api.get(`/api/reports/events/${eventId}/share`),
  createShare: (eventId, { rotate } = {}) =>
    api.post(`/api/reports/events/${eventId}/share`, null, { params: rotate ? { rotate: 1 } : {} }),
  revokeShare: (eventId) => api.delete(`/api/reports/events/${eventId}/share`),
  // Người xem link chia sẻ KHÔNG đăng nhập — endpoint nằm dưới /api/public.
  getSharedReport: (shareToken) =>
    api.get(`/api/public/reports/${shareToken}`, { responseType: 'text' }),
};

// Đánh giá sau sự kiện. Mẫu: ADMIN/BTC dùng chung. Form sự kiện: ADMIN hoặc
// người tạo sự kiện. response: người tham dự (chỉ gửi được khi đã check-out).
export const feedbackApi = {
  listTemplates: (params) => api.get('/api/feedback/templates', { params }),
  getTemplate: (id) => api.get(`/api/feedback/templates/${id}`),
  createTemplate: (data) => api.post('/api/feedback/templates', data),
  updateTemplate: (id, data) => api.put(`/api/feedback/templates/${id}`, data),
  deleteTemplate: (id) => api.delete(`/api/feedback/templates/${id}`),

  getEventForm: (eventId) => api.get(`/api/feedback/events/${eventId}/form`),
  // { templateId } hoặc { title, description, questions }, kèm isAnonymous.
  saveEventForm: (eventId, data) => api.put(`/api/feedback/events/${eventId}/form`, data),
  // { isOpen?, isAnonymous? }
  setEventFormState: (eventId, data) => api.patch(`/api/feedback/events/${eventId}/form`, data),
  removeEventForm: (eventId) => api.delete(`/api/feedback/events/${eventId}/form`),
  getResults: (eventId) => api.get(`/api/feedback/events/${eventId}/results`),

  getMyResponse: (eventId) => api.get(`/api/feedback/events/${eventId}/response`),
  submit: (eventId, answers) => api.post(`/api/feedback/events/${eventId}/response`, { answers }),
  // Người check-in bằng OTP không có JWT — form đánh giá xác minh bằng thẻ điểm danh.
  getMyResponseWithPass: (eventId, pass) =>
    api.get(`/api/public/feedback/${eventId}/response`, { headers: { 'X-Checkin-Pass': pass } }),
  submitWithPass: (eventId, answers, pass) =>
    api.post(`/api/public/feedback/${eventId}/response`, { answers }, { headers: { 'X-Checkin-Pass': pass } }),
};

// Chứng nhận tham gia. Ảnh/PDF đều cần header Authorization nên phải tải qua
// axios dạng blob (thẻ <img src> / <a href> không gửi được token).
export const certificateApi = {
  // BTC — mẫu và cấp chứng nhận của một sự kiện
  getSetup: (eventId) => api.get(`/api/events/${eventId}/certificate`),
  getTemplateImage: (eventId) => api.get(`/api/events/${eventId}/certificate/image`, { responseType: 'blob' }),
  uploadImage: (eventId, file) => {
    const form = new FormData();
    form.append('file', file);
    return api.put(`/api/events/${eventId}/certificate/image`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  saveFields: (eventId, fields) => api.put(`/api/events/${eventId}/certificate/fields`, { fields }),
  removeTemplate: (eventId) => api.delete(`/api/events/${eventId}/certificate`),
  previewPdf: (eventId, name) => api.get(`/api/events/${eventId}/certificate/preview`, { params: { name }, responseType: 'blob' }),
  issue: (eventId) => api.post(`/api/events/${eventId}/certificates/issue`),
  listIssued: (eventId) => api.get(`/api/events/${eventId}/certificates`),
  revoke: (eventId, certId) => api.delete(`/api/events/${eventId}/certificates/${certId}`),

  // BTC xem một chứng nhận đã cấp
  get: (id) => api.get(`/api/certificates/${id}`),
  background: (id) => api.get(`/api/certificates/${id}/background`, { responseType: 'blob' }),
  pdf: (id) => api.get(`/api/certificates/${id}/pdf`, { responseType: 'blob' }),

  // Người nhận: link riêng trong email, không cần đăng nhập (lib/certificateLink.js).
  getByLink: (token) => api.get(`/api/public/certificates/${token}`),
  backgroundByLink: (token) => api.get(`/api/public/certificates/${token}/background`, { responseType: 'blob' }),
  pdfByLink: (token) => api.get(`/api/public/certificates/${token}/pdf`, { responseType: 'blob' }),
};

// Sự kiện thiệp mời — BTC (ADMIN hoặc người tạo sự kiện). Khách mời là khách ngoài,
// không có tài khoản; BTC quét thiệp của khách để check-in.
export const guestApi = {
  list: (eventId, params) => api.get(`/api/events/${eventId}/guests`, { params }),
  add: (eventId, data) => api.post(`/api/events/${eventId}/guests`, data),
  update: (eventId, guestId, data) => api.put(`/api/events/${eventId}/guests/${guestId}`, data),
  remove: (eventId, guestId) => api.delete(`/api/events/${eventId}/guests/${guestId}`),
  importFile: (eventId, file) => {
    const form = new FormData();
    form.append('file', file);
    return api.post(`/api/events/${eventId}/guests/import`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  rotateCode: (eventId, guestId) => api.post(`/api/events/${eventId}/guests/${guestId}/rotate-code`),
  checkIn: (eventId, guestId) => api.post(`/api/events/${eventId}/guests/${guestId}/checkin`),
  undoCheckIn: (eventId, guestId) => api.delete(`/api/events/${eventId}/guests/${guestId}/checkin`),
  scan: (eventId, code) => api.post(`/api/events/${eventId}/guests/scan`, { code }),
  walkIn: (eventId, data) => api.post(`/api/events/${eventId}/guests/walk-in`, data),
  scannerSummary: (eventId) => api.get(`/api/events/${eventId}/scanner-summary`),
  // Sơ đồ ghế: { seatMap, assignments, guests }. seatMap null = xoá sơ đồ.
  seats: (eventId) => api.get(`/api/events/${eventId}/seats`),
  saveSeatMap: (eventId, seatMap) => api.put(`/api/events/${eventId}/seat-map`, { seatMap }),
  // Danh sách ghế MỚI của một khách (gán thêm, bỏ, đổi ghế đều gửi cả danh sách).
  setGuestSeats: (eventId, guestId, seats) => api.put(`/api/events/${eventId}/guests/${guestId}/seats`, { seats }),
  guestPdf: (eventId, guestId) => api.get(`/api/events/${eventId}/guests/${guestId}/invitation.pdf`, { responseType: 'blob' }),
  // Gộp mọi thiệp thành một PDF để in — danh sách dài cần lâu hơn timeout mặc định.
  allPdf: (eventId) => api.get(`/api/events/${eventId}/invitations/pdf`, { responseType: 'blob', timeout: 120000 }),
  // Mỗi khách một file PDF, gói ZIP — server vẽ từng file nên lâu hơn file gộp.
  allZip: (eventId) => api.get(`/api/events/${eventId}/invitations/zip`, { responseType: 'blob', timeout: 300000 }),
  // Chuỗi in + link QR + tên file từng khách để trình duyệt vẽ PNG (invitation/invitationExport.js).
  cards: (eventId, guestId) => api.get(`/api/events/${eventId}/invitations/cards`, { params: guestId ? { guestId } : {} }),
  // Không truyền guestIds = gửi cho mọi khách có email chưa nhận thiệp.
  send: (eventId, guestIds) => api.post(`/api/events/${eventId}/invitations/send`, guestIds ? { guestIds } : {}),

  getTemplate: (eventId) => api.get(`/api/events/${eventId}/invitation-template`),
  getTemplateImage: (eventId) => api.get(`/api/events/${eventId}/invitation-template/image`, { responseType: 'blob' }),
  uploadTemplateImage: (eventId, file) => {
    const form = new FormData();
    form.append('file', file);
    return api.put(`/api/events/${eventId}/invitation-template/image`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  saveTemplateFields: (eventId, fields) => api.put(`/api/events/${eventId}/invitation-template/fields`, { fields }),
  removeTemplate: (eventId) => api.delete(`/api/events/${eventId}/invitation-template`),
  previewPdf: (eventId, name) => api.get(`/api/events/${eventId}/invitation-template/preview`, { params: { name }, responseType: 'blob' }),

  // Link quét cho tình nguyện viên: POST tạo-hoặc-trả-lại link đang có, rotate = cấp mới.
  getScannerLink: (eventId) => api.get(`/api/events/${eventId}/scanner-link`),
  createScannerLink: (eventId, { rotate } = {}) =>
    api.post(`/api/events/${eventId}/scanner-link`, null, { params: rotate ? { rotate: 1 } : {} }),
  revokeScannerLink: (eventId) => api.delete(`/api/events/${eventId}/scanner-link`),
};

// Công khai, không đăng nhập: tình nguyện viên quét qua link, khách xem thiệp của mình.
export const publicInvitationApi = {
  scannerSummary: (token) => api.get(`/api/public/scanner/${token}`),
  scan: (token, code, scannerName) => api.post(`/api/public/scanner/${token}/scan`, { code, scannerName }),
  search: (token, q) => api.get(`/api/public/scanner/${token}/guests`, { params: { q } }),
  checkIn: (token, guestId, scannerName) => api.post(`/api/public/scanner/${token}/guests/${guestId}/checkin`, { scannerName }),
  walkIn: (token, data, scannerName) => api.post(`/api/public/scanner/${token}/walk-in`, { ...data, scannerName }),

  getInvitation: (code) => api.get(`/api/public/invitations/${code}`),
  invitationPdf: (code) => api.get(`/api/public/invitations/${code}/pdf`, { responseType: 'blob' }),
};

// Check-in công khai (QR cố định + form tự điền).
// BTC: form của sự kiện + thêm người thủ công (danh sách/xoá dùng guestApi).
export const publicCheckinAdminApi = {
  getForm: (eventId) => api.get(`/api/events/${eventId}/public-form`),
  saveForm: (eventId, data) => api.put(`/api/events/${eventId}/public-form`, data),
  addCheckin: (eventId, data) => api.post(`/api/events/${eventId}/public-checkins`, data),
};

// Người ghé thăm — không đăng nhập. deviceId để server giới hạn số lần gửi theo máy.
export const publicCheckinApi = {
  getPage: (eventId) => api.get(`/api/public/checkin/${eventId}`),
  submit: (eventId, data) => api.post(`/api/public/checkin/${eventId}`, data),
};

export default api;
