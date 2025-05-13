const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const moment = require('moment-timezone'); // Using moment-timezone for robust timezone handling
const app = express();
const port = 3000;

let rfidReaderMode = 'entry'; // 'entry' or 'exit'. Default to 'entry'.
const MIN_PARK_DURATION_MS = 30 * 1000; // 30 seconds

const sseClients = []; // Store connected SSE clients

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Hỗ trợ parse URL-encoded bodies
app.use(express.static(path.join(__dirname, '..', 'front_end')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*'); // For local development
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept'
  );
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200); // Pre-flight
  next();
});

// SSE Endpoint
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // flush the headers to establish SSE connection

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);
  console.log(`SSE client connected: ${clientId}`);

  res.write(`data: ${JSON.stringify({ type: 'sse_connected' })}\n\n`);

  req.on('close', () => {
    console.log(`SSE client disconnected: ${clientId}`);
    sseClients.splice(sseClients.findIndex(client => client.id === clientId), 1);
  });
});

function sendSseEvent(data) {
  sseClients.forEach(client => client.res.write(`data: ${JSON.stringify(data)}\n\n`));
}

// Multer config
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`);
  }
});
const upload = multer({ storage: storage });

// MongoDB
mongoose.connect('mongodb://localhost:27017/Car_parking', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 10000
})
.then(() => console.log('✅ Kết nối MongoDB thành công'))
.catch(err => {
  console.error('❌ Lỗi kết nối MongoDB:', err);
  process.exit(1);
});

// --- Schema for Vehicle Authorization Data (from 'cars' collection) ---
const vehicleAuthSchema = new mongoose.Schema({
  UID: { type: String, required: true, unique: true, trim: true },
  "Biển số xe": { type: String, required: true, trim: true }
}, { collection: 'cars' });
const VehicleAuth = mongoose.model('VehicleAuth', vehicleAuthSchema);

// --- Schema for Parking History Records (to be stored in 'histories' collection) ---
const parkingHistorySchema = new mongoose.Schema({
  rfidTag: { type: String, trim: true },
  licensePlate: { type: String, required: true, trim: true },
  entryTime: { type: Date, required: true, default: Date.now }, // Stored in UTC
  exitTime: { type: Date, default: null }, // Stored in UTC
  fee: { type: Number, default: 0 },
  status: { type: String, enum: ['in', 'out'], default: 'in' },
  durationMinutes: Number,
  images: { entry: String, exit: String }
}, { 
  collection: 'histories',
  timestamps: false // Disable default Mongoose timestamps if not needed or handled manually
});

parkingHistorySchema.methods.calculateFee = function () {
  if (!this.durationMinutes) return 0;
  const hours = Math.ceil(this.durationMinutes / 60);
  return hours * 1000; 
};

parkingHistorySchema.methods.formatDuration = function () {
  if (this.durationMinutes === undefined || this.durationMinutes === null) return '--:--:--';
  const totalSeconds = this.durationMinutes * 60;
  const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
};

const ParkingHistory = mongoose.model('ParkingHistory', parkingHistorySchema);

// In-memory cache
let latestEntryPlateData = { plate: null, timestamp: 0, imagePath: null };
let latestExitPlateData = { plate: null, timestamp: 0, imagePath: null };
let lastKnownIndividualSlotStates = Array(5).fill(false); // e.g., [true, false, true, true, false] (true=occupied)
const TOTAL_PARKING_SLOTS = 5;
let lastKnownEspIp = null; // Variable to store ESP's IP address

// URL của Python service
const PYTHON_SERVICE_URL = 'http://localhost:8000/recognize_plate/';

// Hàm mới để gọi Python service
async function recognizePlateWithService(imagePath) {
  const formData = new FormData();
  if (!fs.existsSync(imagePath)) {
    console.error(`[NodeJS] Image file not found at: ${imagePath}`);
    return "Error";
  }
  formData.append('image_file', fs.createReadStream(imagePath));

  try {
    console.log(`[NodeJS] Sending image to Python service: ${imagePath}`);
    const response = await axios.post(PYTHON_SERVICE_URL, formData, {
      headers: {
        ...formData.getHeaders()
      },
      timeout: 30000
    });
    console.log('[NodeJS] Python service response:', response.data);
    return response.data.license_plate || "NoPlate";
  } catch (error) {
    console.error('[NodeJS] Error calling Python plate recognition service:');
    if (error.response) {
      console.error('Service Error Data:', error.response.data);
      console.error('Service Error Status:', error.response.status);
    } else if (error.request) {
      console.error('No response received from Python service. Is the service running?');
    } else {
      console.error('Error setting up request to Python service:', error.message);
    }
    return "Error";
  }
}

// API to set RFID reader mode
app.post('/api/set-rfid-mode', (req, res) => {
  const { mode } = req.body;
  if (mode === 'entry' || mode === 'exit') {
    rfidReaderMode = mode;
    console.log(`RFID Reader Operation Mode set to: ${rfidReaderMode}`);
    sendSseEvent({ type: 'RFID_MODE_CHANGED', mode: rfidReaderMode });
    res.json({ success: true, message: `Chế độ đầu đọc RFID đã được đặt thành công thành ${rfidReaderMode === 'entry' ? 'VÀO' : 'RA'}.` });
  } else {
    res.status(400).json({ success: false, message: 'Chế độ không hợp lệ. Phải là "entry" hoặc "exit".' });
  }
});

// Upload API
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Không có tệp ảnh nào được tải lên.' });

    const imagePath = path.resolve(req.file.path);
    const imageType = req.body.type || 'entry'; 

    console.log(`[NodeJS] Image uploaded: ${imagePath}, type: ${imageType}`); 

    const recognizedPlate = await recognizePlateWithService(imagePath);

    if (recognizedPlate === "Error") {
      console.error(`[NodeJS] Plate recognition service returned an error for ${imageType}.`); 
      return res.status(500).json({ licensePlate: "Error", message: 'Lỗi xử lý ảnh từ dịch vụ Python.' });
    }
    if (recognizedPlate === "NoPlate") {
      console.log(`[NodeJS] No plate found by service for ${imageType}.`); 
      return res.json({ licensePlate: "NoPlate", message: 'Không nhận diện được biển số.' });
    }

    console.log(`[NodeJS] Recognized Plate by Service (${imageType}): ${recognizedPlate}`); 
    const normalizedPlate = recognizedPlate.replace(/[\s.-]/g, '').toUpperCase();

    if (imageType === 'entry') {
      latestEntryPlateData = { plate: normalizedPlate, timestamp: Date.now(), imagePath: path.basename(imagePath) };
      sendSseEvent({
        type: 'PLATE_ENTRY_CAPTURED',
        plate: normalizedPlate,
        imageFile: `/uploads/${path.basename(imagePath)}`
      });
      return res.json({ licensePlate: normalizedPlate, message: 'Ảnh xe vào đã được xử lý.', imageFile: `/uploads/${path.basename(imagePath)}` });
    }

    if (imageType === 'exit') {
      latestExitPlateData = { plate: normalizedPlate, timestamp: Date.now(), imagePath: path.basename(imagePath) };
      sendSseEvent({
        type: 'PLATE_EXIT_IMAGE_PROCESSED',
        plate: normalizedPlate,
        imageFile: `/uploads/${path.basename(imagePath)}`
      });
      return res.json({ 
        licensePlate: normalizedPlate, 
        message: 'Ảnh xe ra đã được xử lý, chờ xác nhận RFID và biển số.', 
        imageFile: `/uploads/${path.basename(imagePath)}` 
      });
    }

    return res.status(400).send('Loại ảnh không hợp lệ.');

  } catch (err) {
    console.error('❌ Lỗi server trong /api/upload:', err);
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({ error: 'Lỗi server', licensePlate: 'Error' });
  }
});

// --- API for RFID Request (called by ESP8266) ---
app.get('/api/rfid-request', async (req, res) => { 
  let currentSlots = -1;
  try {
    currentSlots = await countAvailableSlots();
    let { uid: rfidUidFromESP } = req.query;

    if (!rfidUidFromESP) {
      return res.status(400).json({ openGate: false, message: 'Thiếu UID RFID.', slots: currentSlots });
    }
    const normalizedRfidUid = rfidUidFromESP.replace(/:|\s/g, '').toUpperCase();
    console.log(`RFID request received. UID: ${normalizedRfidUid}, Mode: ${rfidReaderMode}`); 

    // ENTRY LOGIC
    if (rfidReaderMode === 'entry') {
      console.log('Processing RFID for ENTRY.'); 
      if (currentSlots <= 0) {
        return res.json({ openGate: false, message: 'Bãi xe đã đầy.', slots: 0 });
      }

      const authorizedEntry = await VehicleAuth.findOne({ UID: normalizedRfidUid });
      if (!authorizedEntry) {
        return res.json({ openGate: false, message: 'Thẻ RFID không được phép vào.', slots: currentSlots });
      }

      const latestRecordByRfid = await ParkingHistory.findOne({ rfidTag: normalizedRfidUid })
                                                     .sort({ entryTime: -1 }); // Get the latest entry

      if (latestRecordByRfid && latestRecordByRfid.status === 'in') {
        console.log(`Vehicle with RFID ${normalizedRfidUid} is ALREADY marked as 'in' based on its latest record. Entry Time (UTC): ${latestRecordByRfid.entryTime.toISOString()}`);
        return res.json({ 
            openGate: false, 
            message: `Xe (RFID: ${normalizedRfidUid}) hiện đang ở trong bãi. Vào lúc: ${moment(latestRecordByRfid.entryTime).tz('Asia/Ho_Chi_Minh').format('HH:mm:ss DD/MM/YYYY')}`, 
            slots: currentSlots 
        });
      }

      const rfidRequestInitiatedTime = Date.now(); // Ghi nhận thời điểm bắt đầu xử lý RFID này
      sendSseEvent({ type: 'TRIGGER_CAPTURE', cameraType: 'entry' });
      console.log('Sent TRIGGER_CAPTURE event for entry camera. Waiting for plate data...'); 

      let plateDataForThisRequest = null;
      const maxWaitDurationMs = 8000; // Chờ tối đa 8 giây cho dữ liệu biển số
      const pollingIntervalMs = 200;  // Kiểm tra mỗi 200ms
      let timeWaitedMs = 0;

      while (timeWaitedMs < maxWaitDurationMs) {
        // Kiểm tra xem latestEntryPlateData có được cập nhật kể từ khi yêu cầu RFID này bắt đầu không
        if (latestEntryPlateData.plate && latestEntryPlateData.timestamp >= rfidRequestInitiatedTime) {
          plateDataForThisRequest = { ...latestEntryPlateData }; // Tạo bản sao dữ liệu biển số cho yêu cầu này
          console.log(`Plate data received after ${timeWaitedMs}ms: ${plateDataForThisRequest.plate}`);
          break; // Thoát vòng lặp khi có dữ liệu
        }
        await new Promise(resolve => setTimeout(resolve, pollingIntervalMs));
        timeWaitedMs += pollingIntervalMs;
      }

      if (!plateDataForThisRequest) {
        console.log(`Timeout (${maxWaitDurationMs}ms) waiting for plate data or no plate recognized for this entry attempt.`);
        return res.json({ openGate: false, message: 'Hết giờ chờ nhận diện BS hoặc không nhận diện được BS.', slots: currentSlots });
      }

      const currentPlateData = plateDataForThisRequest; // Sử dụng dữ liệu biển số đã chụp cho yêu cầu này

      // Kiểm tra xem có biển số hợp lệ không (không phải null, không phải "NoPlate")
      if (!currentPlateData.plate || currentPlateData.plate === 'NoPlate') { 
        console.log('No valid plate string found even after waiting for this request.'); 
        return res.json({ openGate: false, message: 'Không nhận diện được biển số xe vào.', slots: currentSlots });
      }

      const recognizedPlate = currentPlateData.plate; 
      const normalizedExpectedPlate = authorizedEntry["Biển số xe"].replace(/[\s.-]/g, '').toUpperCase();

      if (recognizedPlate !== normalizedExpectedPlate) {
        console.log(`Plate mismatch. Recognized: ${recognizedPlate}, Expected: ${normalizedExpectedPlate}`); 
        return res.json({
          openGate: false,
          message: `Sai biển số. Nhận diện: ${recognizedPlate}, Mong đợi: ${authorizedEntry["Biển số xe"]}.`,
          slots: currentSlots
        });
      }

      const latestRecordByPlate = await ParkingHistory.findOne({ licensePlate: recognizedPlate })
                                                      .sort({ entryTime: -1 }); 

      if (latestRecordByPlate && latestRecordByPlate.status === 'in') {
        // This condition implies that even if the RFID was different (or new),
        // the recognized plate is associated with a vehicle currently 'in'.
        console.log(`Vehicle with Plate ${recognizedPlate} is ALREADY marked as 'in' based on its latest record. Entry Time (UTC): ${latestRecordByPlate.entryTime.toISOString()}`);
        return res.json({ 
            openGate: false, 
            message: `Xe (Biển số: ${recognizedPlate}) hiện đang ở trong bãi. Vào lúc: ${moment(latestRecordByPlate.entryTime).tz('Asia/Ho_Chi_Minh').format('HH:mm:ss DD/MM/YYYY')}`, 
            slots: currentSlots 
        });
      }
      // If latestRecordByPlate is null, or its status is 'out', proceed.
      
      const newParkingRecord = new ParkingHistory({
        rfidTag: normalizedRfidUid,
        licensePlate: recognizedPlate, 
        entryTime: new Date(), 
        images: { entry: currentPlateData.imagePath }, 
        status: 'in'
      });
      await newParkingRecord.save();
      console.log(`New vehicle entry recorded: ${recognizedPlate}, RFID: ${normalizedRfidUid}. Entry Time (UTC): ${newParkingRecord.entryTime.toISOString()}`); 

      latestEntryPlateData = { plate: null, timestamp: 0, imagePath: null }; // Xóa dữ liệu biển số tạm thời sau khi sử dụng

      return res.json({
        openGate: true,
        message: `Cho phép vào. Đang mở cổng. Xe: ${recognizedPlate}`,
        licensePlate: recognizedPlate,
        slots: await countAvailableSlots() 
      });
    }
    // EXIT LOGIC
    else if (rfidReaderMode === 'exit') {
      console.log('Processing RFID for EXIT with camera verification.');
      const parkingRecordToExit = await ParkingHistory.findOne({
        rfidTag: normalizedRfidUid,
        status: 'in'
      }).sort({ entryTime: -1 });

      if (!parkingRecordToExit) {
        console.log(`[NodeJS] Exit RFID: No active 'in' parking record found for RFID: ${normalizedRfidUid} to exit.`);
        return res.json({ openGate: false, message: 'Không tìm thấy xe với RFID này trong bãi (trạng thái "in") hoặc xe đã ra.', slots: currentSlots });
      }

      const entryTime = new Date(parkingRecordToExit.entryTime).getTime();
      if (Date.now() - entryTime < MIN_PARK_DURATION_MS) {
        const timeLeftS = Math.ceil((MIN_PARK_DURATION_MS - (Date.now() - entryTime)) / 1000);
        console.log(`[NodeJS] Exit RFID: Attempt too soon for RFID ${normalizedRfidUid}.`);
        return res.json({ openGate: false, message: `Xe mới vào. Vui lòng đợi ${timeLeftS} giây trước khi ra.`, slots: currentSlots });
      }

      // Trigger exit camera and wait for plate data
      const rfidExitRequestInitiatedTime = Date.now();
      sendSseEvent({ type: 'TRIGGER_CAPTURE', cameraType: 'exit' });
      console.log('Sent TRIGGER_CAPTURE event for exit camera. Waiting for exit plate data...');

      let exitPlateDataForThisRequest = null;
      const maxWaitDurationMs = 8000; // Chờ tối đa 8 giây
      const pollingIntervalMs = 200;
      let timeWaitedMs = 0;

      while (timeWaitedMs < maxWaitDurationMs) {
        if (latestExitPlateData.plate && latestExitPlateData.timestamp >= rfidExitRequestInitiatedTime) {
          exitPlateDataForThisRequest = { ...latestExitPlateData };
          console.log(`Exit plate data received after ${timeWaitedMs}ms: ${exitPlateDataForThisRequest.plate}`);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, pollingIntervalMs));
        timeWaitedMs += pollingIntervalMs;
      }

      latestExitPlateData = { plate: null, timestamp: 0, imagePath: null }; // Clear after attempting to use

      if (!exitPlateDataForThisRequest) {
        console.log(`Timeout (${maxWaitDurationMs}ms) waiting for exit plate data or no plate recognized.`);
        sendSseEvent({ 
            type: 'PLATE_EXIT_NO_PLATE_DATA_RFID', 
            rfidTag: normalizedRfidUid,
            expectedPlate: parkingRecordToExit.licensePlate
        });
        return res.json({ openGate: false, message: 'Hết giờ chờ nhận diện BS xe ra hoặc không nhận diện được.', slots: currentSlots });
      }

      const recognizedExitPlate = exitPlateDataForThisRequest.plate;
      const exitImagePath = exitPlateDataForThisRequest.imagePath;

      if (!recognizedExitPlate || recognizedExitPlate === 'NoPlate') {
        console.log('No valid exit plate string found from camera.');
         sendSseEvent({ 
            type: 'PLATE_EXIT_NO_PLATE_DATA_RFID', 
            rfidTag: normalizedRfidUid,
            expectedPlate: parkingRecordToExit.licensePlate,
            message: 'Không nhận diện được biển số xe ra từ camera.'
        });
        return res.json({ openGate: false, message: 'Không nhận diện được biển số xe ra.', slots: currentSlots });
      }

      const expectedPlateNormalized = parkingRecordToExit.licensePlate.replace(/[\s.-]/g, '').toUpperCase();

      if (recognizedExitPlate !== expectedPlateNormalized) {
        console.log(`[NodeJS] Exit Plate Mismatch! RFID: ${normalizedRfidUid}, Expected: ${expectedPlateNormalized}, Recognized: ${recognizedExitPlate}`);
        sendSseEvent({
          type: 'PLATE_EXIT_MISMATCH_RFID',
          rfidTag: normalizedRfidUid,
          expectedPlate: parkingRecordToExit.licensePlate, // Gửi biển số gốc (chưa chuẩn hóa) cho dễ đọc
          recognizedPlate: recognizedExitPlate, // Gửi biển số nhận diện được
          imageFile: exitImagePath ? `/uploads/${exitImagePath}` : null
        });
        return res.json({
          openGate: false,
          message: `Biển số xe ra không khớp. Mong đợi: ${parkingRecordToExit.licensePlate}, Nhận diện: ${recognizedExitPlate}.`,
          slots: currentSlots
        });
      }

      // Plates match, proceed with exit
      console.log(`[NodeJS] Exit Plate Matched for RFID: ${normalizedRfidUid}. Plate: ${recognizedExitPlate}. Processing exit.`);
      parkingRecordToExit.exitTime = new Date();
      parkingRecordToExit.status = 'out';
      const durationMs = parkingRecordToExit.exitTime.getTime() - parkingRecordToExit.entryTime.getTime();
      parkingRecordToExit.durationMinutes = Math.round(durationMs / (1000 * 60));
      parkingRecordToExit.fee = parkingRecordToExit.calculateFee();
      if (exitImagePath) {
        parkingRecordToExit.images.exit = exitImagePath;
      }
      await parkingRecordToExit.save();

      console.log(`[NodeJS] Vehicle exited (RFID+Camera): ${parkingRecordToExit.licensePlate} (RFID: ${normalizedRfidUid}). Fee: ${parkingRecordToExit.fee}. Exit Time (UTC): ${parkingRecordToExit.exitTime.toISOString()}`);
      
      sendSseEvent({ // Sử dụng lại PLATE_EXIT_CAPTURED vì frontend đã xử lý nó tốt
        type: 'PLATE_EXIT_CAPTURED',
        plate: parkingRecordToExit.licensePlate,
        rfidTag: parkingRecordToExit.rfidTag,
        imageFile: parkingRecordToExit.images.exit ? `/uploads/${parkingRecordToExit.images.exit}` : null,
        duration: parkingRecordToExit.formatDuration(),
        fee: parkingRecordToExit.fee,
        exitTime: parkingRecordToExit.exitTime.toISOString()
      });

      return res.json({
        openGate: true,
        message: `Xe ${parkingRecordToExit.licensePlate} khớp biển số. Cho phép ra. Phí: ${parkingRecordToExit.fee.toLocaleString('vi-VN')} VND.`,
        licensePlate: parkingRecordToExit.licensePlate,
        fee: parkingRecordToExit.fee,
        duration: parkingRecordToExit.formatDuration(),
        slots: await countAvailableSlots()
      });

    }
    else {
      console.error('Invalid rfidReaderMode on server:', rfidReaderMode); 
      return res.status(500).json({ openGate: false, message: 'Lỗi cấu hình server cho chế độ RFID.', slots: currentSlots });
    }

  } catch (err) {
    console.error('❌ Error processing RFID request:', err); 
    try {
      if (currentSlots === -1) currentSlots = await countAvailableSlots();
    } catch (slotErr) { console.error('❌ Error fetching slot count during RFID error handling:', slotErr); } 
    res.status(500).json({ openGate: false, message: 'Lỗi server nội bộ khi xử lý RFID.', slots: currentSlots });
  }
});

// API: ESP8266 reports its sensor-based free slot count and individual states
app.get('/updateSlots', async (req, res) => {
  try {
    const { states, total, ip } = req.query; // Capture IP address from ESP

    if (ip) {
      lastKnownEspIp = ip;
      console.log(`ESP IP Address updated: ${lastKnownEspIp}`);
    }

    if (!states || total === undefined || isNaN(parseInt(total, 10))) {
      return res.status(400).json({ error: 'Thiếu hoặc sai định dạng tham số states hoặc total' });
    }

    const totalSlotsFromESP = parseInt(total, 10);
    if (states.length !== totalSlotsFromESP) {
      return res.status(400).json({ error: 'Độ dài chuỗi states không khớp với total' });
    }

    lastKnownIndividualSlotStates = states.split('').map(state => state === '1');

    let occupiedCountFromSensors = 0;
    lastKnownIndividualSlotStates.forEach(isOccupied => {
      if (isOccupied) occupiedCountFromSensors++;
    });
    const availableCountFromSensors = totalSlotsFromESP - occupiedCountFromSensors;

    console.log(`ESP reported individual slot states: ${states}. Occupied: ${occupiedCountFromSensors}, Available: ${availableCountFromSensors} at ${moment().tz('Asia/Ho_Chi_Minh').format()}`); // Log with GMT+7
    
    sendSseEvent({ 
      type: 'SENSOR_SLOT_UPDATE', 
      individualStates: lastKnownIndividualSlotStates,
      total: totalSlotsFromESP,
      occupied: occupiedCountFromSensors,
      available: availableCountFromSensors
    });

    res.json({ message: 'Thông tin trạng thái từng ô đỗ từ ESP đã được ghi nhận và gửi tới frontend.', individualStates: lastKnownIndividualSlotStates });
  } catch (err) {
    console.error('❌ Lỗi cập nhật trạng thái ô đỗ từ ESP:', err);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

// --- API for Manual Gate Open (called by Frontend) ---
app.post('/api/manual-open-gate', async (req, res) => {
  console.log('Manual open gate request received from frontend.');
  // Always set content type to JSON for responses from this API endpoint
  res.setHeader('Content-Type', 'application/json');

  if (!lastKnownEspIp) {
    console.warn('Cannot manually open gate: ESP IP address is unknown.');
    return res.status(503).json({ success: false, message: 'Không thể mở cổng: Địa chỉ IP của ESP không xác định. ESP cần gửi trạng thái ít nhất một lần.' });
  }

  try {
    const espCommandUrl = `http://${lastKnownEspIp}/control-gate?action=open`;
    console.log(`Sending command to ESP: ${espCommandUrl}`);
    
    const espResponse = await axios.get(espCommandUrl, { timeout: 10000 }); // Increased timeout slightly
    
    // The ESP sends text/plain, so espResponse.data will be a string
    console.log('Response from ESP for manual open:', espResponse.data);
    const espMessage = String(espResponse.data).trim(); // Ensure it's a clean string

    sendSseEvent({ type: 'MANUAL_GATE_OPERATION', status: 'success', action: 'open', message: espMessage });
    res.json({ success: true, message: `Lệnh mở cổng đã được gửi tới ESP. Phản hồi ESP: ${espMessage}` });

  } catch (error) {
    console.error('Error sending manual open command to ESP or processing its response:', error);
    let errorMessageToClient = 'Lỗi khi gửi lệnh mở cổng tới ESP.';

    if (error.code === 'ECONNABORTED' || error.message.toLowerCase().includes('timeout')) {
        errorMessageToClient = `Lệnh mở cổng tới ESP bị timeout (IP: ${lastKnownEspIp}). Kiểm tra kết nối và trạng thái ESP.`;
    } else if (error.response) { 
        // Error from ESP HTTP response (e.g., ESP returned 4xx, 5xx)
        errorMessageToClient = `ESP (IP: ${lastKnownEspIp}) phản hồi lỗi: ${error.response.status} - ${String(error.response.data || error.message).trim()}`;
    } else if (error.request) { 
        // Request was made to ESP but no response received (network error, ESP down, wrong IP/port)
        errorMessageToClient = `Không nhận được phản hồi từ ESP (IP: ${lastKnownEspIp}). Kiểm tra mạng, địa chỉ IP và cổng của ESP.`;
    } else { 
        // Other errors (e.g., setup error for axios, programming error)
        errorMessageToClient = `Lỗi không xác định khi cố gắng giao tiếp với ESP: ${error.message}`;
    }
    
    sendSseEvent({ type: 'MANUAL_GATE_OPERATION', status: 'error', action: 'open', message: errorMessageToClient });
    res.status(500).json({ success: false, message: errorMessageToClient });
  }
});

// --- API for Frontend to get parking status and car list (from 'histories' collection) ---
app.get('/api/parking-data', async (req, res) => {
  try {
    const occupiedParkingRecords = await ParkingHistory.find({ status: 'in' }).sort({ entryTime: -1 }); 
    const occupiedCountFromDB = occupiedParkingRecords.length; 
    const availableSlotsFromDB = TOTAL_PARKING_SLOTS - occupiedCountFromDB;

    const parkingStatusPayload = {
      total: TOTAL_PARKING_SLOTS,
      occupied: occupiedCountFromDB,
      available: availableSlotsFromDB < 0 ? 0 : availableSlotsFromDB,
    };

    if (lastKnownIndividualSlotStates && lastKnownIndividualSlotStates.length === TOTAL_PARKING_SLOTS) {
      parkingStatusPayload.individualStates = lastKnownIndividualSlotStates;
    }

    res.json({
      parkingStatus: parkingStatusPayload,
      cars: occupiedParkingRecords 
    });
  } catch (err) {
    console.error('❌ Lỗi lấy dữ liệu bãi xe:', err);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

// API to clear all parking records from 'histories' collection
app.delete('/api/parking-clear', async (req, res) => {
  try {
    const result = await ParkingHistory.deleteMany({}); 
    latestEntryPlateData = { plate: null, timestamp: 0, imagePath: null };
    latestExitPlateData = { plate: null, timestamp: 0, imagePath: null };
    lastKnownIndividualSlotStates = Array(TOTAL_PARKING_SLOTS).fill(false); 

    console.log(`Cleared ${result.deletedCount} parking history records.`); 
    sendSseEvent({ 
      type: 'PARKING_STATE_CHANGED', 
      reason: 'parking_cleared',
      message: `Đã xóa tất cả ${result.deletedCount} bản ghi xe.`
    });

    sendSseEvent({
      type: 'SENSOR_SLOT_UPDATE', 
      individualStates: Array(TOTAL_PARKING_SLOTS).fill(false),
      total: TOTAL_PARKING_SLOTS,
      occupied: 0,
      available: TOTAL_PARKING_SLOTS
    });

    res.json({ message: `Đã xóa thành công ${result.deletedCount} bản ghi xe khỏi lịch sử.`, deletedCount: result.deletedCount });
  } catch (err) {
    console.error('❌ Error clearing parking history:', err); 
    res.status(500).json({ error: 'Lỗi server khi xóa lịch sử.' });
  }
});

// Helper function to count available slots based on 'histories' collection
async function countAvailableSlots() {
  const totalSlots = 5;
  const occupiedCount = await ParkingHistory.countDocuments({ status: 'in' });
  const available = totalSlots - occupiedCount;
  return available < 0 ? 0 : available;
}

// Serve uploaded images
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server Node.js chạy tại http://localhost:${port} và trên IP mạng của máy.`);
  console.log(`💡 Đảm bảo Python service (FastAPI) cũng đang chạy (thường ở port 8000).`);
});

