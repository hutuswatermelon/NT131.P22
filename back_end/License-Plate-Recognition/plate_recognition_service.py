from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse
import uvicorn
import cv2
import numpy as np
import io
import sys
import os
import time

# Thêm đường dẫn của thư mục gốc của 'src' vào sys.path
# Giả định plate_recognition_service.py nằm trong License-Plate-Recognition,
# và thư mục 'src' là con trực tiếp của License-Plate-Recognition.
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.lp_recognition import E2E # Đảm bảo E2E có thể được import từ src.lp_recognition

app = FastAPI(title="License Plate Recognition API")

# Biến toàn cục để giữ model, được tải một lần khi khởi động
plate_model = None

@app.on_event("startup")
async def load_model_on_startup():
    global plate_model
    try:
        print("Loading License Plate Recognition model...")
        start_time = time.time()
        plate_model = E2E() # Khởi tạo model E2E của bạn
        end_time = time.time()
        print(f"Model loaded successfully in {end_time - start_time:.2f} seconds.")
    except Exception as e:
        print(f"CRITICAL: Error loading model during startup: {e}")
        plate_model = None # Đảm bảo model là None nếu tải lỗi

@app.post("/recognize_plate/")
async def recognize_plate_endpoint(image_file: UploadFile = File(...)):
    if plate_model is None:
        raise HTTPException(status_code=503, detail="Model not loaded or failed to load. Service unavailable.")

    try:
        start_processing_time = time.time()

        contents = await image_file.read()
        nparr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img is None:
            raise HTTPException(status_code=400, detail="Invalid image file or unsupported image format.")

        # Sử dụng model đã tải để nhận dạng
        plate_text = plate_model.predict(img)

        end_processing_time = time.time()
        processing_duration = round(end_processing_time - start_processing_time, 2)
        
        print(f"Image processed. Plate: '{plate_text}', Time: {processing_duration:.2f}s")

        return JSONResponse(content={
            "license_plate": plate_text,
            "processing_time_seconds": processing_duration
        })
    except HTTPException as http_exc:
        # Ném lại các HTTPException đã được xử lý (ví dụ: 400, 503)
        raise http_exc
    except Exception as e:
        print(f"Error processing image: {e}")
        raise HTTPException(status_code=500, detail=f"Internal server error during plate recognition: {str(e)}")

if __name__ == "__main__":
    # Chạy service FastAPI với Uvicorn
    # host="0.0.0.0" để có thể truy cập từ các máy khác trong cùng mạng
    # port=8000 là port mặc định, bạn có thể thay đổi nếu cần
    print("Starting Uvicorn server for License Plate Recognition API...")
    uvicorn.run(app, host="0.0.0.0", port=8000)