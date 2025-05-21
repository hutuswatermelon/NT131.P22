# HỆ THỐNG BÃI ĐỖ XE TỰ ĐỘNG SỬ DỤNG ESP8266

## Thông tin môn học
- **Môn học:** Hệ thống nhúng mạng không dây
- **Mã lớp:** NT131.P22

## Thành viên nhóm
- Cáp Hữu Tú - 23521696
- Huỳnh Ngọc Ngân Tuyền - 23521753
- Nguyễn Tài Quang - 23521287

## Mô tả dự án
Dự án "Hệ thống bãi đỗ xe tự động" được xây dựng nhằm mô phỏng và triển khai một giải pháp quản lý bãi đỗ xe thông minh. Hệ thống sử dụng công nghệ RFID để xác thực xe vào/ra, kết hợp với nhận dạng biển số xe tự động qua camera. Trạng thái của bãi xe, thông tin xe, và các thao tác quản lý được hiển thị và điều khiển thông qua một giao diện web trực quan.

## Công nghệ sử dụng
- **Phần cứng:**
    - ESP8266 (NodeMCU 1.0 (ESP-12E Module)
    - Đầu đọc RFID MFRC522 và thẻ RFID
    - Động cơ Servo để điều khiển rào chắn (barrier)
    - Cảm biến hồng ngoại để phát hiện trạng thái đỗ xe (trong mô hình này, trạng thái chỗ đỗ được cập nhật từ ESP8266 dựa trên logic vào/ra kết hợp quét chỗ đỗ định kỳ).
    - Webcam để chụp ảnh biển số.
- **Phần mềm:**
    - **Arduino/C++:** Lập trình cho ESP8266 ([Arduino/car_parking/car_parking.ino](Arduino/car_parking/car_parking.ino)).
    - **Node.js & Express.js (Backend):** Xây dựng API, xử lý logic nghiệp vụ, giao tiếp với ESP8266, quản lý cơ sở dữ liệu, và phục vụ Server-Sent Events (SSE) ([back_end/server.js](back_end/server.js)).
    - **MongoDB:** Cơ sở dữ liệu NoSQL để lưu trữ thông tin xe, lịch sử vào ra.
    - **HTML, CSS, JavaScript (Frontend):** Giao diện người dùng tương tác với hệ thống ([front_end/index.html](front_end/index.html), [front_end/frontend.js](front_end/frontend.js), [front_end/style.css](front_end/style.css)).
    - **Python & FastAPI (License Plate Recognition Service):** Dịch vụ API riêng biệt để nhận dạng ký tự từ ảnh biển số xe ([back_end/License-Plate-Recognition/plate_recognition_service.py](back_end/License-Plate-Recognition/plate_recognition_service.py)).
- **Giao tiếp:**
    - HTTP requests (ESP8266 <-> Node.js, Frontend <-> Node.js, Node.js <-> Python LPR Service).
    - Server-Sent Events (Node.js -> Frontend) để cập nhật dữ liệu thời gian thực.

## Tính năng chính
- **Quản lý xe vào/ra:**
    - Xác thực xe qua thẻ RFID.
    - Tự động chụp ảnh và nhận dạng biển số xe khi xe vào/ra.
    - So sánh biển số xe vào và biển số đăng ký.
    - So sánh biển số xe ra với biển số đã ghi nhận lúc vào.
    - Điều khiển rào chắn tự động.
- **Quản lý bãi xe:**
    - Hiển thị số chỗ trống, số chỗ đã chiếm dụng.
    - Hiển thị danh sách xe đang có trong bãi.
    - Ghi nhận lịch sử các lượt gửi xe (thời gian vào, thời gian ra, biển số, RFID).
- **Giao diện người dùng (Web):**
    - Hiển thị hình ảnh camera (giả lập qua webcam client-side).
    - Hiển thị thông tin biển số xe vào/ra, hình ảnh biển số.
    - Cập nhật trạng thái bãi xe và danh sách xe theo thời gian thực.
    - Cho phép quản lý viên thao tác thủ công (ví dụ: mở cổng, chuyển chế độ RFID).
    - Chức năng xóa toàn bộ dữ liệu xe và lịch sử.
- **Tích hợp module nhận dạng biển số:**
    - Sử dụng một service Python riêng biệt để xử lý nhận dạng biển số.

## Trích dẫn phần Project được sử dụng cho nhận diện biển số
    https://github.com/buiquangmanhhp1999/License-Plate-Recognition

## Hướng phát triển tương lai
**Phần cứng:**
 - *Nâng cấp bộ xử lý trung tâm:*
    - Thay thế ESP8266 bằng ESP32 nhằm cải thiện hiệu suất điều khiển và khả năng xử lý dữ liệu.

- *Mở rộng hệ thống vào/ra:*
    - Thiết kế hệ thống có 2 cổng vào và 2 cổng ra để tăng lưu lượng xe và tối ưu hóa luồng giao thông.

- *Tích hợp camera AI:*
    - Nhận diện biển số: Sử dụng camera mini kết hợp với thuật toán học máy để nhận diện biển số xe tự động.
    - Giám sát toàn bãi xe: Camera giám sát toàn cảnh kết hợp AI nhằm phát hiện và nhận diện chính xác các xe đang đỗ, kể cả khi bị che khuất bởi vật thể khác.

- *Cảm biến môi trường:*
    - Cảm biến ánh sáng: Tự động bật/tắt hệ thống chiếu sáng theo điều kiện ánh sáng môi trường.
    - Cảm biến nhiệt: Kết hợp hệ thống cảnh báo và kích hoạt hệ thống phòng cháy chữa cháy khi phát hiện nhiệt độ bất thường.

- *Mở rộng mô hình bãi giữ xe phân tầng:*
    - Hỗ trợ quản lý bãi xe nhiều tầng, tích hợp bản đồ định vị ô đỗ xe và ghi nhớ vị trí xe đã đỗ.

**Phần mềm:**
- *Cho quản lý bãi xe:*
    - Quản lý đồng thời nhiều bãi đỗ xe.
    - Theo dõi tình trạng bãi xe theo thời gian thực.
    - Hỗ trợ điều khiển các chức năng của bãi xe từ xa thông qua phần mềm quản lý.

- *Cho người dùng (người cần đỗ xe):*
    - Ứng dụng di động thân thiện, tích hợp GPS.
    - Ứng dụng AI/học máy để gợi ý các bãi đỗ gần nhất còn trống, đồng thời cân nhắc chi phí đỗ xe phù hợp.
    - Cho phép người dùng đăng ký và giữ chỗ đỗ xe trực tuyến trước hoặc ngay khi đến bãi đỗ.
