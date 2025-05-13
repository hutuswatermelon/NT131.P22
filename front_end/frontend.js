// front_end/car_parking.js

let streams = {};
const DATA_REFRESH_INTERVAL = 5000; // Interval for fetching parking data
const API_BASE = 'http://localhost:3000';
let eventSource = null; // For SSE
let currentRfidOpMode = 'entry'; // 'entry' or 'exit'

document.addEventListener('DOMContentLoaded', () => {
  // Dark mode
  const darkToggle = document.getElementById('darkModeToggle');
  if (localStorage.getItem('theme') === 'dark') {
    document.body.classList.add('dark-mode');
    if (darkToggle) darkToggle.textContent = '☀️ Chế độ sáng';
  }
  if (darkToggle) darkToggle.addEventListener('click', toggleDarkMode);

  const manualOpenBtn = document.getElementById('manualOpenGateBtn');
  if (manualOpenBtn) manualOpenBtn.addEventListener('click', manualOpenGate);

  const cam1Btn = document.getElementById('toggleCamera1');
  const cam2Btn = document.getElementById('toggleCamera2');
  if (cam1Btn) cam1Btn.addEventListener('click', () => toggleCamera('liveCamera_1', 'entry', 'toggleCamera1'));
  if (cam2Btn) cam2Btn.addEventListener('click', () => toggleCamera('liveCamera_2', 'exit', 'toggleCamera2'));

  const rfidModeToggleBtn = document.getElementById('rfidModeToggleBtn');
  if (rfidModeToggleBtn) rfidModeToggleBtn.addEventListener('click', toggleRfidOperationMode);
  updateRfidModeUI(); // Initialize UI based on default mode

  initializeEventSource(); // Initialize SSE connection

  updateClock();
  fetchParkingData(); // Initial fetch
  setInterval(updateClock, 1000);
  setInterval(fetchParkingData, DATA_REFRESH_INTERVAL); // Periodic fetch

  const clearBtn = document.getElementById('clearListBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!confirm('Bạn có chắc chắn muốn xóa tất cả xe trong bãi và lịch sử không? Hành động này không thể hoàn tác.')) return;
      try {
        const res = await fetch(`${API_BASE}/api/parking-clear`, { method: 'DELETE' });
        if (!res.ok) {
            const errData = await res.json().catch(() => ({message: "Lỗi không xác định"}));
            throw new Error(errData.message || `Lỗi HTTP ${res.status}`);
        }
        const data = await res.json();
        alert(data.message || `Đã xóa ${data.deletedCount || 0} bản ghi.`);
        fetchParkingData(); // Refresh data after clearing
        // Clear displayed images and plates
        document.getElementById('plateInText').textContent = '--';
        document.getElementById('plateOutText').textContent = '--';
        document.getElementById('plateInImg').src = "#";
        document.getElementById('plateOutImg').src = "#";
        document.getElementById('duration').textContent = `Thời Gian Gửi: --`;
        document.getElementById('fee').textContent = `Phí Gửi Xe: --`;
        checkPlateMatch();


      } catch (e) {
        console.error('Clear failed:', e);
        alert(`Xóa thất bại: ${e.message}`);
      }
    });
  }
});

function initializeEventSource() {
  if (eventSource) {
    eventSource.close();
  }
  eventSource = new EventSource(`${API_BASE}/api/events`);

  eventSource.onmessage = function(event) {
    try {
      const eventData = JSON.parse(event.data);
      console.log('SSE event received:', eventData);
      if (eventData.type === 'TRIGGER_CAPTURE') {
        if (eventData.cameraType === 'entry') {
          console.log('Triggering entry camera capture via SSE');
          triggerCapture('liveCamera_1', 'entry');
        } else if (eventData.cameraType === 'exit') {
          console.log('Triggering exit camera capture via SSE');
          triggerCapture('liveCamera_2', 'exit');
        }
      } else if (eventData.type === 'RFID_MODE_CHANGED') {
        console.log('RFID mode changed via SSE:', eventData.mode);
        currentRfidOpMode = eventData.mode;
        updateRfidModeUI();
      } else if (eventData.type === 'MANUAL_GATE_OPERATION') {
        console.log('Manual gate operation SSE:', eventData);
        alert(`Thao tác cổng thủ công: ${eventData.action} - Trạng thái: ${eventData.status}. ${eventData.message || ''}`);
      } else if (eventData.type === 'PLATE_ENTRY_CAPTURED') { // Xử lý ảnh xe vào từ /api/upload
        console.log('Entry plate data from SSE (/api/upload):', eventData);
        const plateInTextEl = document.getElementById('plateInText');
        if (plateInTextEl) plateInTextEl.textContent = eventData.plate || '--';
        const plateInImgEl = document.getElementById('plateInImg');
        const vehicleImgInEl = document.getElementById('imgIn');
        if (eventData.imageFile) {
            const imageUrl = `${API_BASE}${eventData.imageFile}`;
            if (plateInImgEl) plateInImgEl.src = imageUrl;
            if (vehicleImgInEl) vehicleImgInEl.src = imageUrl;
        } else {
            if (plateInImgEl) plateInImgEl.src = "#";
            if (vehicleImgInEl) vehicleImgInEl.src = "#";
        }
        // Clear exit info on new entry
        document.getElementById('plateOutText').textContent = '--';
        document.getElementById('plateOutImg').src = "#";
        document.getElementById('imgOut').src = "#";
        document.getElementById('duration').textContent = `Thời Gian Gửi: --`;
        document.getElementById('fee').textContent = `Phí Gửi Xe: -- VND`;
        checkPlateMatch();
        fetchParkingData(); // Refresh list
      } else if (eventData.type === 'PLATE_EXIT_IMAGE_PROCESSED') { // Ảnh xe ra vừa được upload (chưa xác nhận)
        console.log('Exit plate image processed (from /api/upload, pre-RFID check):', eventData);
        const plateOutTextEl = document.getElementById('plateOutText');
        if (plateOutTextEl) plateOutTextEl.textContent = eventData.plate || '--';
        
        const plateOutImgEl = document.getElementById('plateOutImg');
        const vehicleImgOutEl = document.getElementById('imgOut');

        if (eventData.imageFile) {
            const imageUrl = `${API_BASE}${eventData.imageFile}`;
            if (plateOutImgEl) plateOutImgEl.src = imageUrl;
            if (vehicleImgOutEl) vehicleImgOutEl.src = imageUrl;
        } else {
            if (plateOutImgEl) plateOutImgEl.src = "#";
            if (vehicleImgOutEl) vehicleImgOutEl.src = "#";
        }
        checkPlateMatch();
      } else if (eventData.type === 'PLATE_EXIT_CAPTURED' || eventData.type === 'RFID_VEHICLE_EXITED') { 
        console.log('Vehicle exit CONFIRMED (RFID + Camera Match or RFID only):', eventData);
        
        const plateOutTextEl = document.getElementById('plateOutText');
        if(plateOutTextEl) plateOutTextEl.textContent = eventData.plate || '--';
        
        const plateOutImgEl = document.getElementById('plateOutImg');
        const vehicleImgOutEl = document.getElementById('imgOut');

        if (eventData.imageFile) {
            const imageUrl = `${API_BASE}${eventData.imageFile}`;
            if (plateOutImgEl) plateOutImgEl.src = imageUrl;
            if (vehicleImgOutEl) vehicleImgOutEl.src = imageUrl;
        } else { // Nếu là RFID_VEHICLE_EXITED (không có ảnh) hoặc không có imageFile
            if (plateOutImgEl) plateOutImgEl.src = "#"; 
            if (vehicleImgOutEl) vehicleImgOutEl.src = "#"; 
        }

        const durationEl = document.getElementById('duration');
        if(durationEl) durationEl.textContent = `Thời Gian Gửi: ${eventData.duration || '--:--:--'}`;
        
        const feeEl = document.getElementById('fee');
        if(feeEl) feeEl.textContent = `Phí Gửi Xe: ${eventData.fee !== undefined ? eventData.fee.toLocaleString('vi-VN') + ' VND' : '-- VND'}`;
        
        checkPlateMatch(); 
        fetchParkingData(); 
      } else if (eventData.type === 'PLATE_EXIT_MISMATCH_RFID') {
        console.log('Exit Plate Mismatch (RFID check):', eventData);
        const matchStatusEl = document.getElementById('matchStatus');
        if (matchStatusEl) {
            matchStatusEl.textContent = `✘ BIỂN SỐ RA KHÔNG KHỚP! Mong đợi: ${eventData.expectedPlate}, Nhận diện: ${eventData.recognizedPlate}`;
            matchStatusEl.style.color = 'red';
        }
        // Ảnh xe ra (recognized) đã được cập nhật bởi PLATE_EXIT_IMAGE_PROCESSED
        // Có thể thêm thông báo alert
        alert(`Lỗi Xe Ra: Biển số không khớp.\nMong đợi: ${eventData.expectedPlate}\nNhận diện: ${eventData.recognizedPlate}`);
      } else if (eventData.type === 'PLATE_EXIT_NO_PLATE_DATA_RFID') {
        console.log('No Plate Data for Exit (RFID check):', eventData);
        const matchStatusEl = document.getElementById('matchStatus');
        if (matchStatusEl) {
            matchStatusEl.textContent = `✘ KHÔNG NHẬN DIỆN ĐƯỢC BIỂN SỐ XE RA (RFID: ${eventData.rfidTag})`;
            matchStatusEl.style.color = 'red';
        }
        // Ảnh xe ra có thể trống hoặc là ảnh cuối cùng chụp được
        alert(`Lỗi Xe Ra: Không nhận diện được biển số xe ra cho thẻ RFID ${eventData.rfidTag}. ${eventData.message || ''}`);
      } else if (eventData.type === 'SENSOR_SLOT_UPDATE') {
        console.log('SENSOR_SLOT_UPDATE received:', eventData);
        // eventData from server is: { type: 'SENSOR_SLOT_UPDATE', total, occupied, available, individualStates }
        // Update parking status UI (including the statusText line and visual slots) directly with sensor data.
        updateUIParkingStatus({
          total: eventData.total,
          occupied: eventData.occupied,
          available: eventData.available,
          individualStates: eventData.individualStates
        });
        // The car list (table) is not updated by this event directly here.
        // It's updated by fetchParkingData, which is called periodically or by other specific events.
      } else if (eventData.type === 'PARKING_STATE_CHANGED') { // e.g., after clearing data
        fetchParkingData(); // Refresh all parking data, including status, slots, and car list from DB
      }


    } catch (e) {
      console.error('Error parsing SSE event data:', e);
    }
  };

  eventSource.onerror = function(err) {
    console.error('EventSource failed:', err);
    // Optionally, try to reconnect after a delay
    eventSource.close();
    setTimeout(initializeEventSource, 5000); // Reconnect after 5 seconds
  };
}

async function manualOpenGate() {
  if (!confirm('Bạn có chắc chắn muốn mở cổng thủ công không?')) {
    return;
  }
  console.log('Attempting to manually open gate...');
  try {
    const response = await fetch(`${API_BASE}/api/manual-open-gate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
      // No body needed for this simple command
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.message || 'Không thể gửi lệnh mở cổng thủ công.');
    }
    alert(`Server: ${data.message}`); // Display success message from server
  } catch (error) {
    console.error('Error manually opening gate:', error);
    alert(`Lỗi mở cổng thủ công: ${error.message}`);
  }
}

async function toggleRfidOperationMode() {
    currentRfidOpMode = (currentRfidOpMode === 'entry') ? 'exit' : 'entry';
    try {
        const response = await fetch(`${API_BASE}/api/set-rfid-mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: currentRfidOpMode })
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.message || 'Không thể đặt chế độ RFID trên server.');
        }
        console.log(`RFID operation mode set to: ${currentRfidOpMode}`);
        updateRfidModeUI();
    } catch (error) {
        console.error('Error setting RFID mode:', error);
        alert(`Lỗi: ${error.message}`);
        // Revert mode on error
        currentRfidOpMode = (currentRfidOpMode === 'entry') ? 'exit' : 'entry';
    }
}

function updateRfidModeUI() {
    const btn = document.getElementById('rfidModeToggleBtn');
    const statusText = document.getElementById('rfidModeStatus');
    if (btn && statusText) {
        if (currentRfidOpMode === 'entry') {
            btn.textContent = 'CHẾ ĐỘ: VÀO';
            btn.classList.remove('exit-mode');
            statusText.textContent = 'Chế độ hiện tại: Ghi nhận xe VÀO. Quét thẻ RFID để ghi nhận xe mới.';
        } else {
            btn.textContent = 'CHẾ ĐỘ: RA';
            btn.classList.add('exit-mode');
            statusText.textContent = 'Chế độ hiện tại: Ghi nhận xe RA. Quét thẻ RFID để xử lý xe rời bãi.';
        }
    }
}

async function triggerCapture(videoId, cameraType) {
  const videoElement = document.getElementById(videoId);
  if (!videoElement) {
    console.error(`Video element ${videoId} not found for triggered capture.`);
    return;
  }

  const cameraIsActive = streams[videoId] && streams[videoId].stream.active;

  if (cameraIsActive) {
    console.log(`Camera ${videoId} is active. Capturing frame.`);
    captureFrame(videoElement, cameraType);
  } else {
    // If camera is not active, temporarily start it, capture, then stop.
    console.log(`Camera ${videoId} is not active. Temporarily starting for capture.`);
    try {
      await startCamera(videoId, cameraType, true); // Pass a flag for temporary start
      // Wait a bit for camera to initialize fully
      await new Promise(resolve => setTimeout(resolve, 500)); 
      captureFrame(videoElement, cameraType);
      // Stop the camera after a short delay to allow upload to complete
      setTimeout(() => {
        if (streams[videoId] && streams[videoId].isTemporary) { // Check if it's still in a temporary state
            stopCamera(videoId);
            const btn = document.getElementById(cameraType === 'entry' ? 'toggleCamera1' : 'toggleCamera2');
            if(btn) btn.textContent = cameraType === 'entry' ? 'Bật/Tắt Camera Vào' : 'Bật/Tắt Camera Ra';
        }
      }, 2000); // Adjust delay as needed
    } catch (error) {
      console.error(`Failed to temporarily start/capture camera ${videoId}:`, error);
    }
  }
}

async function startCamera(videoId, cameraType, isTemporary = false) {
  try {
    const video = document.getElementById(videoId);
    if (!video) {
        console.error(`Video element ${videoId} not found.`);
        return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    await video.play();
    streams[videoId] = { video, stream, cameraType, isTemporary }; // Store temporary state
    console.log(`Camera ${videoId} (${cameraType}) started.`);
  } catch (e) {
    console.error(`Error starting camera ${videoId} (${cameraType}):`, e);
    alert(`Không thể khởi động camera ${videoId}. Kiểm tra quyền và thiết bị.`);
  }
}

function stopCamera(videoId) {
  const info = streams[videoId];
  if (!info) return;
  const { video, stream, cameraType } = info;
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
  }
  if (video) {
    video.pause();
    video.srcObject = null;
  }
  delete streams[videoId];
  console.log(`Camera ${videoId} (${cameraType}) stopped.`);
}

function toggleCamera(videoId, cameraType, btnId) {
  const btn = document.getElementById(btnId);
  if (!btn) {
      console.error(`Button ${btnId} not found.`);
      return;
  }
  if (streams[videoId]) {
    stopCamera(videoId);
    btn.textContent = cameraType === 'entry' ? 'Bật/Tắt Camera Vào' : 'Bật/Tắt Camera Ra';
  } else {
    startCamera(videoId, cameraType, false); // Not a temporary start from button click
    btn.textContent = cameraType === 'entry' ? 'Dừng Camera Vào' : 'Dừng Camera Ra';
  }
}

function captureFrame(video, type) {
  if (!video.srcObject || video.readyState < 4 || video.paused || video.ended) {
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob(blob => {
    if (blob) uploadImage(blob, type);
  }, 'image/jpeg', 0.7);
}

async function uploadImage(blob, type) {
  const form = new FormData();
  form.append('image', blob, `${type}-${Date.now()}.jpg`);
  form.append('type', type);
  try {
    const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: form });
    const data = await res.json(); // Try to parse JSON even if not res.ok for error messages
    if (!res.ok) {
        throw new Error(data.error || data.licensePlate || `Lỗi HTTP: ${res.status}`);
    }
    handleResult(data, type, blob);
  } catch (e) {
    console.error(`Error uploading image (${type}):`, e);
    const textId = type === 'entry' ? 'plateInText' : 'plateOutText';
    document.getElementById(textId).textContent = 'Lỗi Tải Lên';
    // Optionally display e.message or a generic error to the user
  }
}

function handleResult(data, type, blob) {
  const isEntry = type === 'entry';
  const textId = isEntry ? 'plateInText' : 'plateOutText';
  const imgId = isEntry ? 'plateInImg' : 'plateOutImg';
  const vehicleImgId = isEntry ? 'imgIn' : 'imgOut';
  const plateTextEl = document.getElementById(textId);
  const plateImgEl = document.getElementById(imgId);
  const vehicleImgEl = document.getElementById(vehicleImgId);

  if (plateTextEl) plateTextEl.textContent = data.licensePlate || '--';
  
  // URL.createObjectURL nên được gọi ở đây vì blob chỉ tồn tại trong scope này
  // và sẽ được SSE PLATE_ENTRY_CAPTURED hoặc PLATE_EXIT_IMAGE_PROCESSED ghi đè nếu có imageFile từ server
  let localBlobUrl = null;
  if (blob) {
    localBlobUrl = URL.createObjectURL(blob);
  }

  // Ưu tiên imageFile từ server (nếu có), nếu không thì dùng localBlobUrl
  const imageUrlToDisplay = data.imageFile ? `${API_BASE}${data.imageFile}` : localBlobUrl;

  if (imageUrlToDisplay) {
    if (plateImgEl) {
        if (plateImgEl.src && plateImgEl.src.startsWith('blob:')) URL.revokeObjectURL(plateImgEl.src);
        plateImgEl.src = imageUrlToDisplay;
    }
    if (vehicleImgEl) {
        if (vehicleImgEl.src && vehicleImgEl.src.startsWith('blob:')) URL.revokeObjectURL(vehicleImgEl.src);
        vehicleImgEl.src = imageUrlToDisplay;
    }
  } else if (data.licensePlate === "NoPlate" || data.licensePlate === "Error") {
    if (plateImgEl) {
        if (plateImgEl.src && plateImgEl.src.startsWith('blob:')) URL.revokeObjectURL(plateImgEl.src);
        plateImgEl.src = "#";
    }
    if (vehicleImgEl) {
        if (vehicleImgEl.src && vehicleImgEl.src.startsWith('blob:')) URL.revokeObjectURL(vehicleImgEl.src);
        vehicleImgEl.src = "#";
    }
  }


  if (isEntry) {
    // Clear exit info if it's a new entry (đã được xử lý bởi PLATE_ENTRY_CAPTURED SSE)
  } else { // type === 'exit'
    // Với logic mới, /api/upload cho xe ra không trả về duration/fee.
    // Thông tin này sẽ được cập nhật bởi PLATE_EXIT_CAPTURED SSE.
    // Do đó, không cần cập nhật duration/fee ở đây.
  }

  checkPlateMatch();

  if (data.licensePlate && data.licensePlate !== 'NoPlate' && data.licensePlate !== 'Error' && data.licensePlate !== 'Upload Error') {
    const videoId = isEntry ? 'liveCamera_1' : 'liveCamera_2';
    const btnId = isEntry ? 'toggleCamera1' : 'toggleCamera2';
    
    const streamInfo = streams[videoId];
    if (streamInfo && !streamInfo.isTemporary) {
        stopCamera(videoId); 
        const button = document.getElementById(btnId);
        if (button) button.textContent = isEntry ? 'Bật/Tắt Camera Vào' : 'Bật/Tắt Camera Ra';
    } else if (streamInfo && streamInfo.isTemporary) {
        const button = document.getElementById(btnId);
        if (button) button.textContent = isEntry ? 'Bật/Tắt Camera Vào' : 'Bật/Tắt Camera Ra';
    }
  }
}

function checkPlateMatch() {
  const inP = document.getElementById('plateInText').textContent;
  const outP = document.getElementById('plateOutText').textContent;
  const stat = document.getElementById('matchStatus');
  if (!stat) return;

  if (inP && outP && inP !== '--' && outP !== '--' && !inP.includes('Error') && !outP.includes('Error') && !inP.includes('Lỗi') && !outP.includes('Lỗi')) {
    stat.textContent = inP === outP ? '✔ BIỂN SỐ KHỚP' : '✘ BIỂN SỐ KHÔNG KHỚP';
    stat.style.color = inP === outP ? 'green' : 'red';
  } else {
    stat.textContent = 'TRẠNG THÁI KHỚP BIỂN SỐ';
    stat.style.color = 'inherit'; // Or your default text color
  }
}

function toggleDarkMode() {
  const dm = document.body.classList.toggle('dark-mode');
  document.getElementById('darkModeToggle').textContent = dm?'☀️ Chế độ sáng':'🌙 Chế độ tối';
  localStorage.setItem('theme', dm?'dark':'light');
}

async function fetchParkingData() {
  try {
    const res = await fetch(`${API_BASE}/api/parking-data`);
    if (!res.ok) {
        const errData = await res.json().catch(() => ({message: "Lỗi không xác định"}));
        throw new Error(errData.message || `Lỗi HTTP ${res.status}`);
    }
    const data = await res.json();
    updateUIParkingStatus(data.parkingStatus);
    updateUICarTable(data.cars);
  } catch (e) {
    console.error('Error fetching parking data:', e);
    const parkingStatusEl = document.getElementById('parkingStatus');
    if (parkingStatusEl) parkingStatusEl.innerHTML = '<p>Lỗi tải dữ liệu ô đỗ.</p>';
    const tableBodyEl = document.getElementById('tableBody');
    if (tableBodyEl) tableBodyEl.innerHTML = '<tr><td colspan="4" style="text-align:center;">Lỗi tải danh sách xe.</td></tr>';
  }
}

function updateUIParkingStatus(parkingStatus) {
  const cont = document.getElementById('parkingStatus');
  if (!cont || !parkingStatus) return;
  cont.innerHTML = ''; // Clear previous content

  const statusText = document.createElement('p');
  statusText.textContent = `Trạng thái: ${parkingStatus.occupied} / ${parkingStatus.total} đã có xe. Còn trống: ${parkingStatus.available}`;
  cont.appendChild(statusText);
  statusText.style.marginTop = '15px';
  statusText.style.fontWeight = 'bold';


  const slotsContainer = document.createElement('div');
  slotsContainer.className = 'slots-container';
  // Add styles for horizontal layout using flexbox
  slotsContainer.style.marginTop = '15px';
  slotsContainer.style.display = 'flex';
  slotsContainer.style.flexDirection = 'row';
  slotsContainer.style.flexWrap = 'wrap'; // Allows wrapping if too many slots for one line
  slotsContainer.style.justifyContent = 'center'; // Center the slots
  slotsContainer.style.gap = '10px'; // Adds a small gap between slots

  // Use individualStates if available and matches total, otherwise fallback to occupied count
  const useIndividualStates = parkingStatus.individualStates && parkingStatus.individualStates.length === parkingStatus.total;

  for (let i = 1; i <= parkingStatus.total; i++) {
    const d = document.createElement('div');
    let isOccupied;
    if (useIndividualStates) {
        isOccupied = parkingStatus.individualStates[i-1]; // Assuming individualStates is 0-indexed array of booleans
    } else {
        isOccupied = i <= parkingStatus.occupied;
    }
    d.className = 'slot ' + (isOccupied ? 'occupied' : 'available');
    d.textContent = `Ô ${i}`;
    slotsContainer.appendChild(d);
  }
  cont.appendChild(slotsContainer);
}

function updateUICarTable(carsInLot) {
  const tBody = document.getElementById('tableBody');
  if (!tBody) return;
  tBody.innerHTML = '';

  if (!carsInLot || carsInLot.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4; // Adjust if you change columns
    td.textContent = 'Hiện không có xe nào trong bãi.';
    td.style.textAlign = 'center';
    tr.appendChild(td);
    tBody.appendChild(tr);
    return;
  }

  carsInLot.forEach((car, index) => {
    const tr = document.createElement('tr');

    // STT (Row number)
    let td = document.createElement('td');
    td.textContent = index + 1;
    tr.appendChild(td);

    // License Plate
    td = document.createElement('td');
    td.textContent = car.licensePlate || '--';
    tr.appendChild(td);

    // Entry Time
    td = document.createElement('td');
    // Ensure car.entryTime is a valid date string (ISO format from server is good)
    td.textContent = car.entryTime ? new Date(car.entryTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--';
    tr.appendChild(td);

    // RFID Tag
    td = document.createElement('td');
    td.textContent = car.rfidTag || '--';
    tr.appendChild(td);

    tBody.appendChild(tr);
  });
}

function updateClock() {
  const n = new Date();
  const clockEl = document.getElementById('clock');
  if (clockEl) {
    clockEl.textContent = n.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  }

  const dateInfoEl = document.getElementById('dateInfo');
  if (dateInfoEl) {
    // Using toLocaleDateString for better localization and timezone handling
    dateInfoEl.textContent = n.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
}

