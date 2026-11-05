# Check-in bằng khuôn mặt tại cửa — thiết kế

## Mục tiêu
Một laptop của BTC đặt ở cửa (kiosk) nhìn khuôn mặt, nhận ra thành viên đã đăng ký sự kiện (1:N)
và chấm CHECKED_IN mà không cần quét QR. Áp dụng cho sự kiện STANDARD và buổi học. Không áp dụng
cho khách mời (INVITATION/PUBLIC), vì khách không có tài khoản.

## Quyết định chính
- **Mô hình chạy trong trình duyệt** (`@vladmandic/human@3.3.6`, mô-đun `faceres` cho descriptor
  1024 chiều, cùng blazeface + facemesh + antispoof + liveness).
  - Không dùng Ollama: LLM/VLM không trả vector khuôn mặt và không nhận diện ổn định 1:N.
  - Không chạy trên server: Render free tier không đủ RAM.
  - Mô hình phục vụ từ `/models/human/`. `vite.config.js` copy các file này từ `node_modules`,
    nên không commit file nhị phân.
- **Mọi embedding đều do trình duyệt tính**, ở cả ba chỗ (sinh viên tự chụp, admin import, kiosk),
  qua `frontend/src/pages/face/faceEngine.js` với cùng một cấu hình. Server chỉ lưu và so vector.
- **Công thức so khớp** giống `human.match.similarity` (order 2, multiplier 20, cho ra 0..1).
  Công thức có ở cả hai phía (`backend/src/lib/faceProfile.js` và `frontend/src/pages/face/faceMatch.js`)
  và phải giữ trùng nhau.
- **`FACE_MODEL`** được ghi trên mỗi profile. Đổi mô hình hoặc cấu hình thì đổi chuỗi này; profile cũ
  tự bị bỏ qua và người dùng phải đăng ký lại.

## Dữ liệu (`FaceProfile`, bảng `attendance_face_profiles`)
- Mỗi user có tối đa 1 profile, gồm:
  - `embedding`: Float32 LE, 4096 byte.
  - `thumbnail`: JPEG 128px, ≤ 20KB.
  - `source`: SELF hoặc IMPORT.
  - `importEmbedding`, `consentAt`.
- Không lưu ảnh gốc. Thumbnail chỉ để người đứng cửa nhìn đối chiếu.
- `onDelete: Cascade` theo User.

## Đồng ý và quyền riêng tư
Dữ liệu sinh trắc học là dữ liệu cá nhân nhạy cảm (NĐ 13/2023, Luật BVDLCN 2025).
- Kiosk chỉ dùng profile có `consentAt` và cùng `FACE_MODEL`.
- Sinh viên tự chụp: phải tick đồng ý; server từ chối nếu thiếu `consent: true` (`FACE_CONSENT_REQUIRED`).
- ~~Admin import ảnh thẻ: `consentAt = null`, sinh viên bấm đồng ý ở `/khuon-mat`.~~ Đổi ngày 2026-11-05 theo
  quyết định chủ sản phẩm: **ảnh admin đặt có hiệu lực ngay** (`consentAt` = lúc admin đặt) — nhà trường chịu
  trách nhiệm cơ sở pháp lý cho ảnh mình cung cấp. Ảnh import trước ngày đó có thể vẫn chờ đồng ý; banner và
  `POST /api/me/face-profile/consent` giữ lại cho chúng.
- Import theo lô mặc định bỏ qua sinh viên đã tự chụp và đang dùng; admin tick `overwrite` thì đè luôn.
- Trang Quản lý người dùng (cập nhật 2026-11-05): admin xem / thay / xoá ảnh của từng người qua
  `GET|PUT|DELETE /api/admin/users/:id/face-profile`. PUT chỉ cho tài khoản STUDENT (`FACE_STUDENT_ONLY`),
  được đè cả ảnh tự chụp, vẫn chặn `FACE_DUPLICATE`. Mọi ảnh admin đặt (lô hay từng người) đi qua
  `adminProfileData`: `source = IMPORT`, `consentAt = now`, `importEmbedding` = ảnh mới.
- Sinh viên xoá được toàn bộ dữ liệu khuôn mặt, kể cả ảnh nhà trường import.

## Chống điểm danh hộ
Rủi ro: A đăng ký mặt của B, rồi B đi qua cửa là A được tính có mặt.
1. Khi lưu (tự chụp hoặc import), server so với mọi profile khác. Nếu similarity ≥ `DUPLICATE_THRESHOLD`
   thì trả `FACE_DUPLICATE`, kể cả với ảnh import chưa được đồng ý.
2. Nếu đã có `importEmbedding`, ảnh tự chụp phải đạt similarity ≥ `SELF_VS_IMPORT_THRESHOLD` so với ảnh
   import, không thì trả `FACE_MISMATCH`.
3. Ở kiosk, `faceProblem` kiểm tra antispoof (`real`) và liveness (`live`) ≥ 0.5. Lời chào hiện tên kèm
   thumbnail đã đăng ký thật to.

## Kiosk (`/events/:id/face-checkin`, ADMIN hoặc người tạo sự kiện)
- `GET /api/events/:id/face-gallery` trả vector của các thành viên có profile active, kèm
  `totalMembers/withFace` và `gate`. Kiosk tải lại sau mỗi 60 s.
- Mỗi khung hình: lấy khuôn mặt lớn nhất, chạy `faceProblem`, `rankMatches` (top 2), rồi `decide`:
  - `AUTO`: best ≥ `AUTO_THRESHOLD`, cách người thứ hai ≥ `MARGIN`, và cùng một người trong
    `STREAK_FRAMES` khung liên tiếp. Kiosk tự check-in.
  - `CONFIRM`: best ≥ `CONFIRM_THRESHOLD` nhưng chưa chắc. Kiosk dừng quét và hiện tối đa 2 ứng viên
    kèm ảnh cho BTC chọn.
  - `UNKNOWN`: gợi ý check-in tay bằng MSSV, ngay trên kiosk (dùng `manual-checkin`).
- `POST /api/events/:id/face-checkin { userId }` xử lý theo thứ tự:
  1. Kiểm tra EventMember; không có thì `NOT_REGISTERED`.
  2. Kiểm tra profile còn active; không thì `FACE_NOT_FOUND`.
  3. Áp `gateRejection` (khác check-in tay vì kiosk chạy tự động).
  4. Ghi bằng `updateMany(checkinTime: null)` với `deviceId 'FACE'`. Nếu không ghi được dòng nào thì
     trả `ALREADY_CHECKED_IN`.
- Server tin kết quả khớp mà kiosk gửi lên. Kiosk chạy dưới tài khoản BTC, mà BTC vốn đã check-in tay
  được bất kỳ ai, nên không mở thêm quyền mới.

## Ngưỡng và hiệu chỉnh
Đo bằng ảnh mẫu của Human lúc triển khai (2026-10-22), không phải người thật:
- Cùng một người, ảnh khác góc/khoảng cách: 0.54–0.57.
- Cùng ảnh lật gương: 0.76.
- Người khác: 0.41–0.44, nhưng **0.596** với hai người khác nhau trong cùng một ảnh nhóm (cùng ánh sáng
  và camera, đúng như tình huống ở kiosk). Thử đầu–cuối trên DB thật ngày 2026-10-22.

Mặc định đang đặt:
- `CONFIRM_THRESHOLD = 0.5` và `SELF_VS_IMPORT_THRESHOLD = 0.5`.
- `AUTO_THRESHOLD = 0.7`: ban đầu là 0.6, nâng lên vì ca 0.596 ở trên. Cùng một người với ảnh lật gương
  đạt 0.756 / 0.774 nên vẫn tự check-in.
- `DUPLICATE_THRESHOLD = 0.6`.

Khoảng cách giữa hai nhóm hẹp, nên **phải đo lại với ~10 người thật** (đăng ký bằng camera, đi qua
kiosk) trước sự kiện lớn. Nếu phần lớn rơi vào CONFIRM thì hạ `AUTO_THRESHOLD`, đồng thời tăng `MARGIN`
hoặc `STREAK_FRAMES` để bù.

Hiệu năng trên webgl: tải mô hình khoảng 2.4 s, mỗi khung hình 180–330 ms. Kiosk lấy khung hình
liên tục nhưng tuần tự, không chồng việc lên nhau.

## Chạy mô hình trong Web Worker (2026-10-27)
Bản đầu chạy Human trên luồng chính và bị gỡ sau khi deploy vì trang lag (commit f06e1d7): mỗi khung
chiếm luồng giao diện, nên bấm nút, gõ MSSV, cuộn đều giật. Bây giờ:
- `pages/face/faceWorker.js` (module worker) chạy Human. `faceEngine.js` gửi `ImageBitmap` cắt từ
  video/ảnh sang worker (transfer, không copy) và nhận kết quả đã rút gọn (`slimFace`: box, score,
  embedding, rotation.angle, real, live).
- Cấu hình nằm ở `pages/face/faceConfig.js`, dùng chung cho worker và đường dự phòng.
- Trình duyệt thiếu `OffscreenCanvas`/module worker, hoặc worker không khởi động được (không có WebGL
  trong worker), thì `faceEngine` chạy Human trên luồng chính như cũ.
- Đo trên Chrome ngày 2026-10-27 với ảnh mẫu của Human: cùng khuôn mặt qua worker và qua luồng chính
  cho similarity 0.9926 (cách đọc ảnh khác nhau chút ít), cao hơn mọi ngưỡng rất xa nên **không** đổi
  `FACE_MODEL`. Luồng chính bị chặn tối đa 22 ms (khi chạy trên luồng chính là 66 ms trên cùng máy; máy
  GPU tích hợp còn tệ hơn). Mỗi khung trong worker chậm hơn khoảng 1.5 lần, nhưng giao diện vẫn mượt.
- Khi khung không có ai, `useFaceCamera` giãn nhịp từ 150 ms lên 400 ms. Kiosk tải lại danh sách mỗi
  60 s và chỉ giải mã vector của người mới hoặc vừa đổi ảnh.
