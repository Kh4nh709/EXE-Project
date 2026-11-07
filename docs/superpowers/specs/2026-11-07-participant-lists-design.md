# Người tham gia không có tài khoản — danh sách theo từng sự kiện

Ngày: 2026-11-07 · Trạng thái: đã triển khai code, chờ áp DB (xem "Triển khai")

## Quyết định của product owner

- Xoá **toàn bộ tài khoản sinh viên** (39 tài khoản + 197 dòng điểm danh, 3 khuôn mặt), **không sao lưu**.
  Chỉ còn ADMIN và BTC có tài khoản.
- Mỗi sự kiện tự quản lý người tham gia: BTC tạo sự kiện rồi nhập danh sách (email + họ tên, MSSV tuỳ chọn).
- Người tham gia **dùng chung theo email**: một email là một người ẩn phía sau cho mọi sự kiện. Ảnh khuôn mặt
  đặt một lần dùng được ở sự kiện khác; nhập lại email đã có thì **giữ tên/MSSV cũ** (chỉ bổ sung chỗ trống),
  để BTC này không âm thầm sửa dữ liệu mà sự kiện của BTC khác đang dùng.
- Lớp học có danh sách riêng; tạo buổi học thì chép danh sách lớp vào buổi.
- `/dang-ky` vẫn giữ: người đăng ký được thêm thẳng vào danh sách, không tạo mật khẩu.
- BTC đặt ảnh khuôn mặt cho từng người trong danh sách để dùng kiosk.
- Chứng nhận gửi theo danh sách (người đã check-out — quy tắc cũ giữ nguyên) kèm link xem không cần đăng nhập.

## Mô hình

Người tham gia vẫn là một dòng `User` với `role = 'STUDENT'` (giữ tên enum để khỏi đụng dữ liệu, báo cáo,
điểm danh, chứng nhận, đánh giá, khuôn mặt — tất cả vẫn trỏ `userId`). Khác biệt:

- `passwordHash = '!'` (không phải chuỗi bcrypt → không bao giờ khớp mật khẩu).
- Không đường đăng nhập nào trả về STUDENT: `login` và `forgot/reset-password` lọc `role: { not: 'STUDENT' }`;
  `middleware/auth.js` trả 401 cho JWT của STUDENT (kể cả token cũ còn hạn). Đăng nhập bằng mã email
  (`/api/auth/login-otp/*`) bị gỡ hẳn vì chỉ dành cho sinh viên.
- Admin không tạo, không đặt mật khẩu, không đổi ai thành STUDENT (`NOT_STAFF`); danh sách người dùng mặc định
  chỉ hiện nhân sự, lọc `role=STUDENT` để xem người tham gia.
- `ClassMember (classId, userId)` thay cho ghép theo chuỗi `User.class` — một người học nhiều lớp môn.

Mọi đường nhập người tham gia đi qua `lib/participants.js`:
`validateRows` (email hợp lệ, họ tên ≥ 2 ký tự, bỏ trùng trong lô, báo số dòng) → `upsertParticipants`
(tìm theo email không phân biệt hoa thường; MSSV đã thuộc email khác → bỏ qua kèm lý do; tạo bằng
`createMany skipDuplicates`) → `addUsersToEvent` / `classMember.createMany`. Kết quả luôn là
`{ added, alreadyIn, created, skipped: [{ line, email, name, reason }] }` — thành công một phần là 200.

## API

| Đường | Ghi chú |
|---|---|
| `POST /api/events/:id/members` `{ participants }` | thay cho `{ userIds }` |
| `POST /api/events/:id/members/import` (file) | Excel/CSV, cột Email + Họ tên bắt buộc |
| `POST /api/events/:id/members/by-class` `{ classIds }` | theo `ClassMember`; vẫn nhận `classes` (tên) |
| `GET/PUT/DELETE /api/events/:id/members/:userId/face-profile` | BTC của sự kiện; chỉ người trong danh sách |
| `POST /api/classes/:id/members` `{ participants }`, `/members/import` | danh sách lớp |
| `GET /api/public/certificates/:token[/background\|/pdf]` | link chứng nhận ký HMAC (`lib/certificateLink.js`) |
| Bỏ | `/members/search` (sự kiện + lớp — lộ danh sách của BTC khác), `/events/:id/register`, `/api/me/face-profile`, `/api/auth/login-otp/*`, `/api/admin/users/import`, `/api/certificates/mine` |

## Frontend

- Bỏ trang sinh viên: `/dashboard` (phần sinh viên), `/my-attendance`, `/my-certificates`, `/khuon-mat`,
  `/feedback/:eventId`. `/dashboard` chỉ còn tổng quan nhân sự (`pages/Dashboard.jsx`).
- `components/participants/ParticipantsAdder.jsx`: dán danh sách (mỗi dòng email, họ tên, MSSV — dán cột Excel
  được; `utils/participants.js`) hoặc chọn file; hiện các dòng bị bỏ qua. Dùng ở `EventMembersModal` và
  `ClassDetail`.
- `EventMembersModal`: nút khuôn mặt cạnh từng người mở `UserFaceModal` với API theo sự kiện.
- `/chung-nhan/:token` (`pages/public/CertificateView.jsx`): xem canvas + tải PDF/PNG.
- `ScanLanding` bỏ nút "Đăng nhập bằng mật khẩu"; sự kiện tắt check-in bằng email → báo gặp BTC.
- Đánh giá: người tham gia trả lời ngay sau check-out bằng thẻ điểm danh; bỏ nút "Sao chép link đánh giá".

## Triển khai

1. Áp bảng `attendance_class_members` (khối tương ứng trong `prisma/supabase-setup.sql`) **trước** khi deploy
   backend — code mới đọc bảng này ở trang lớp học và "Thêm cả lớp".
2. Deploy backend + frontend.
3. Xoá dữ liệu sinh viên cũ (theo quyết định của product owner, không sao lưu): xoá các dòng phụ thuộc của user
   `role = 'STUDENT'` (attendance, event_members, certificates, feedback_responses → SetNull, face_profiles,
   device_bindings, otp_tokens, fraud_logs) rồi xoá user. Không đụng ADMIN/BTC.

## Rủi ro đã chấp nhận

- Dùng chung theo email: gõ nhầm email = một người khác; tên do người nhập đầu tiên quyết định.
- Mọi lượt check-in bằng QR cần một email OTP (hạn mức Brevo); kiosk khuôn mặt không tốn email.
