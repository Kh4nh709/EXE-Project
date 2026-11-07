# Check-in bằng email + OTP, không cần đăng nhập

Ngày: 2026-11-07 · Trạng thái: đã triển khai

## Vấn đề

Trước đây sinh viên chưa đăng nhập quét QR thì bị đẩy sang `/login`, đăng nhập (mật khẩu hoặc OTP)
rồi mới quay lại `/scan`. Product owner muốn bỏ hẳn bước đăng nhập:
**quét QR → nhập email → nhận OTP → xác minh → check-in**, vẫn theo danh sách tham gia của sự kiện.

## Quyết định của product owner

1. Công tắc `Event.otpCheckinEnabled` theo từng sự kiện, **mặc định bật**.
2. Áp luật **một điện thoại chỉ check-in cho một người mỗi sự kiện**, cho **cả** luồng đăng nhập.
   Máy hỏng phải mượn máy bạn thì BTC điểm danh tay.
3. Form đánh giá sau check-out dùng được bằng thẻ điểm danh, làm luôn trong đợt này.
4. Chấp nhận rủi ro hết hạn mức email Brevo (gói miễn phí khoảng 300 email/ngày).

## Luồng

```
/scan?e&t&type ─► POST /api/public/scan-ticket              (như cũ: đổi token QR lấy vé 15 phút)
   đã đăng nhập ─► POST /api/checkin                         (như cũ)
   có thẻ của sự kiện trong localStorage ─► POST /api/public/self-checkin
   chưa có ─► form email/MSSV
             ─► POST /api/public/checkin-otp/request  {eventId,type,ticket|token,deviceId,identifier}
             ─► POST /api/public/checkin-otp/verify   {eventId,deviceId,identifier,otp} → { pass }
             ─► POST /api/public/self-checkin         {eventId,type,ticket|token,deviceId,pass,gps}
```

- **Thẻ điểm danh** (`lib/checkinPass.js`) là HMAC của `pass:userId:eventId:hash(deviceId):expiresAt`,
  sống 24 giờ và không lưu DB. Thẻ chỉ chứng minh danh tính; vé quét, danh sách, cổng và GPS vẫn kiểm
  lại ở mỗi lần dùng. Nhờ thẻ, thử lại khi bị lỗi GPS, check-out cuối buổi và form đánh giá không
  tốn thêm email nào.
- **Không cấp JWT.** Chiếm được hộp thư chỉ cho quyền điểm danh, không chiếm được tài khoản, nên luồng
  này mở cho mọi vai trò có trong danh sách (khác `login-otp` vốn chỉ dành cho STUDENT). Mượn máy bạn
  để check-in cũng không để lại phiên đăng nhập trên máy đó.
- `request` kiểm **trước khi gửi email**: vé quét → sự kiện (STANDARD, đang bật công tắc) → cổng →
  tài khoản → danh sách → đã check-in/out chưa → luật một máy một người → cooldown 60 giây. Người không
  đủ điều kiện không tốn email nào.
- Mã OTP có `purpose: 'CHECKIN'`, gắn với `deviceId` và sống 10 phút. `OtpToken.attempts` đếm số lần
  nhập sai, sai 5 lần thì huỷ mã. Bộ đếm này đặt theo từng mã chứ không theo IP (cả lớp dùng chung
  wifi) hay theo deviceId (tự đổi được).
- Lõi check-in nằm ở `lib/selfCheckin.js#performSelfCheckin`, dùng chung cho cả hai luồng nên mã lỗi
  giống hệt nhau. Bước kiểm tra liên kết thiết bị chỉ áp dụng cho luồng JWT.
- Form đánh giá: `GET/POST /api/public/feedback/:id/response` với header `X-Checkin-Pass`.
  Middleware `authenticateCheckinPass` đặt `req.user` rồi dùng lại nguyên handler của
  `feedback.controller`. Thẻ sai trả **400 `PASS_INVALID`**, không phải 401, vì 401 làm `api.js`
  đăng xuất và đá về `/login`.

## Mã lỗi mới

| Mã | Khi nào |
|---|---|
| `OTP_CHECKIN_DISABLED` (403) | BTC đã tắt công tắc. Frontend chuyển sang `/login`. |
| `ACCOUNT_NOT_FOUND` (404) | Sự kiện không giới hạn danh sách, nhưng email/MSSV không có tài khoản. |
| `OTP_COOLDOWN` (429) | Mã vừa gửi trong vòng 60 giây. Frontend vẫn sang bước nhập mã. |
| `INVALID_CHECKIN_OTP`, `OTP_TOO_MANY_ATTEMPTS` (400) | Nhập sai mã / sai đủ 5 lần. |
| `PASS_INVALID` (400) | Thẻ hết hạn, sai máy, sai sự kiện hoặc tài khoản bị khoá. Frontend quay về bước nhập email. |
| `DEVICE_USED_BY_OTHER` (403) | Máy này đã check-in cho người khác ở sự kiện này (ghi `FraudLog` `SHARED_DEVICE`). |

## Rủi ro đã chấp nhận

- **Hạn mức email:** tốn 1 email cho mỗi người mỗi sự kiện. Người đang có phiên đăng nhập vẫn đi luồng
  cũ, không tốn email.
- **Điểm danh hộ có thông đồng:** người vắng mặt đọc OTP rồi nhắn mã cho bạn. Kiểu này vẫn bị chặn bởi
  việc mã gắn với máy đã quét, luật một máy một người, GPS và vé quét. Email OTP cũng ghi tên sự kiện
  và cảnh báo người nhận. Người cố tình xoá localStorage để đổi deviceId thì vẫn lách được luật một
  máy một người. Mức này ngang luồng `login-otp` hiện có, vốn cũng tự tin cậy máy mới.
