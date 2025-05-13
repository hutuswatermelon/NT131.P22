#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Wire.h>
#include <Servo.h>
#include <PCF8574.h> 
#include <ArduinoJson.h>
#include <ESP8266WebServer.h> // Added for ESP to act as a server

// ====== CONFIGURATION ======
const char* WIFI_SSID     = "CPS";
const char* WIFI_PASSWORD = "2444nam678";
const char* SERVER_HOST   = "http://192.168.243.134:3000";

WiFiClient client;

// PCF8574 I/O Expander
PCF8574 pcf8574(0x20);

#define ir_open  D0 // OUT - GPIO16 (D0 trên NodeMCU)

// RFID
#define RST_PIN  D3 // RST MFRC522 - GPIO0 (D3 NodeMCU)
#define SS_PIN   D8// SS (SDA/CS) MFRC522 - GPIO15 (D8 NodeMCU - Hardware CS)
MFRC522 mfrc522(SS_PIN, RST_PIN);

// Servo
#define SERVO_OPEN_GATE_PIN  D4 //  GPIO2 (D4 NodeMCU)
Servo openGateServo;

// ESP Web Server
ESP8266WebServer espHttpServer(80); // ESP will listen on port 80 for commands

// Constants
#define MAX_SLOT 5
#define BARRIER_CLOSED  150
#define BARRIER_OPENED  0

// Represents occupied state for the string (sensor LOW means occupied)
#define SLOT_STATE_OCCUPIED '1'
#define SLOT_STATE_EMPTY    '0'

#define HTTP_TIMEOUT 15000
int slot = 0;
bool waitingToCloseOpen = false;
unsigned long openStartTime = 0;

String uidToString(MFRC522& reader) {
  String s = "";
  for (byte i = 0; i < reader.uid.size; i++) {
    if (reader.uid.uidByte[i] < 0x10) s += "0";
    s += String(reader.uid.uidByte[i], HEX);
  }
  s.toUpperCase();
  return s;
}

// Notify server and get slots
// Changed endpoint to /api/rfid-request
bool notifyServer(const char* path, const String& uid, int &updated_slots_from_server) { 
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi not connected. Cannot notify server.");
    return false;
  }

  HTTPClient http;
  WiFiClient client; 

  String url = String(SERVER_HOST) + path + "?uid=" + uid;
  Serial.println("Sending to server: " + url); 

  http.begin(client, url);
  http.setTimeout(HTTP_TIMEOUT); 
  int httpCode = http.GET();

  bool openGateStatus = false;
  String serverMessage = "No response or error";

  if (httpCode > 0) {
    Serial.printf("[HTTP] GET... code: %d\n", httpCode);
    String payload = http.getString(); // Get payload for debugging
    Serial.println("Raw server response: " + payload);

    if (httpCode == HTTP_CODE_OK) {
      DynamicJsonDocument doc(512);
      DeserializationError error = deserializeJson(doc, payload);

      if (error) {
        Serial.print(F("deserializeJson() failed: "));
        Serial.println(error.f_str());
        serverMessage = "JSON parsing error";
      } else {
        openGateStatus = doc["openGate"] | false;
        updated_slots_from_server = doc["slots"] | -1; // Default to -1 if not present
        serverMessage = doc["message"] | "No message from server";
        String plate = doc["licensePlate"] | "N/A";
        // Log more details from server if available (e.g., for exit)
        if (doc.containsKey("fee")) {
            int fee = doc["fee"];
            serverMessage += " Plate: " + plate + ". Fee: " + String(fee) + " VND.";
        } else {
            serverMessage += " Plate: " + plate + ".";
        }
      }
    } else { // Handle other HTTP codes e.g. 400, 404, 500
        serverMessage = "Server error: HTTP " + String(httpCode);
        DynamicJsonDocument errorDoc(256);
        DeserializationError error = deserializeJson(errorDoc, payload);
        if (!error && errorDoc.containsKey("message")) {
            serverMessage = errorDoc["message"].as<String>();
        }
    }
  } else {
    Serial.printf("[HTTP] GET... failed, error: %s\n", http.errorToString(httpCode).c_str());
    serverMessage = "HTTP request failed: " + String(http.errorToString(httpCode).c_str());
  }
  http.end();
  
  Serial.println("Server final message: " + serverMessage);
  Serial.print("Open gate status: "); Serial.println(openGateStatus ? "Yes" : "No");
  Serial.print("Slots from server: "); Serial.println(updated_slots_from_server);

  return openGateStatus;
}

// Servo control
void openGate(Servo& gate) {
  gate.attach(SERVO_OPEN_GATE_PIN);
  Serial.println("Command received: Opening gate."); // Log manual open
  for (int pos = BARRIER_CLOSED; pos >= BARRIER_OPENED; pos -= 2) { // Assuming BARRIER_CLOSED is higher angle
    gate.write(pos);
    delay(20);
  }
  // After opening, set flags as if RFID opened it, to allow auto-close logic
  gate.detach();
  waitingToCloseOpen = true;
  openStartTime = millis();
  Serial.println("Gate opened manually. Waiting for auto-close conditions.");
}

void closeGate(Servo& gate) {
  gate.attach(SERVO_OPEN_GATE_PIN);
  Serial.println("Closing gate.");
  for (int pos = BARRIER_OPENED; pos <= BARRIER_CLOSED; pos += 2) { // Assuming BARRIER_OPENED is lower angle
    gate.write(pos);
    delay(20); 
  }
  gate.detach();
}

// Returns a string representing the state of each slot
// '1' for occupied, '0' for empty
String getIndividualSlotStatesString() {
  String states = "";
  Serial.println("--- Checking Individual Slot Status (PCF8574) ---");
  for (int i = 0; i < MAX_SLOT; i++) {
    uint8_t pinState = pcf8574.read(i); // Assuming LOW means sensor detected (occupied)
    if (pinState == LOW) {
      states += SLOT_STATE_OCCUPIED;
      Serial.print("Slot P"); Serial.print(i); Serial.println(" -> Occupied (1)");
    } else {
      states += SLOT_STATE_EMPTY;
      Serial.print("Slot P"); Serial.print(i); Serial.println(" -> Empty (0)");
    }
  }
  Serial.print("Individual Slot States String: "); Serial.println(states);
  Serial.println("---------------------------------------------");
  return states;
}

void sendSlotInfoToServer() {
  String slotStatesString = getIndividualSlotStatesString();

  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    WiFiClient client; 
    // Send individual slot states AND ESP's IP address
    String espIP = WiFi.localIP().toString();
    String url = String(SERVER_HOST) + "/updateSlots?states=" + slotStatesString + "&total=" + String(MAX_SLOT) + "&ip=" + espIP;
    
    Serial.println("Sending individual slot states and IP to server: " + url);

    http.begin(client, url); 
    http.setTimeout(HTTP_TIMEOUT); 
    int code = http.GET();
    if (code > 0) {
        Serial.printf("[HTTP] Slot states update GET... code: %d\n", code);
        if (code == HTTP_CODE_OK) {
            String payload = http.getString();
            Serial.println("Slot states update server response: " + payload);
        }
    } else {
        Serial.printf("[HTTP] Slot states update GET... failed, error: %s\n", http.errorToString(code).c_str());
    }
    http.end();
    Serial.print("Individual slot states sent to server: ");
    Serial.println(slotStatesString);
  }
}

// Handler for manual gate control commands from Node.js server
void handleGateControl() {
  String action = espHttpServer.arg("action");
  Serial.print("ESP received /control-gate command. Action: ");
  Serial.println(action);

  if (action == "open") {
    openGate(openGateServo);
    espHttpServer.send(200, "text/plain", "Gate opening command received by ESP.");

  } else if (action == "close") {
    closeGate(openGateServo);
    waitingToCloseOpen = false;
    espHttpServer.send(200, "text/plain", "Gate closing command received by ESP.");
  }
  else {
    espHttpServer.send(400, "text/plain", "Invalid action. Use 'open' or 'close'.");
  }
}

void setup() {
  Serial.begin(115200);
  while (!Serial);
  Serial.println("\nBooting...");

  SPI.begin();
  mfrc522.PCD_Init();
  Serial.println("MFRC522 initialized.");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi ");
  Serial.print(WIFI_SSID);
  unsigned long wifiConnectStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiConnectStart < 15000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected!");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi connection FAILED. Check credentials or network.");
  }

  Wire.begin();

  if (pcf8574.begin()) {
    Serial.println("PCF8574 initialized successfully.");
  } else {
    Serial.println("PCF8574 initialization FAILED. Check wiring and I2C address (0x20).");
  }

  Serial.println("Configuring PCF8574 pins as inputs (writing HIGH)...");
    for (int i = 0; i < MAX_SLOT; i++) {
      pcf8574.write(i, HIGH); // Write HIGH to pin 'i' to set it as input with pull-up
      Serial.print("PCF8574 Pin P"); Serial.print(i); Serial.println(" set to input mode (HIGH written).");
    }

  openGateServo.attach(SERVO_OPEN_GATE_PIN);
  closeGate(openGateServo);
  Serial.println("Servo initialized and gate closed.");

  pinMode(ir_open, INPUT_PULLUP);
  int irOpen_state = digitalRead(ir_open);
  Serial.print("IR sensor pin initialized "); Serial.println(irOpen_state);

  Serial.println("System ready. Waiting for RFID card...");

  // Start ESP Web Server for commands
  espHttpServer.on("/control-gate", HTTP_GET, handleGateControl); // Listen for GET requests
  espHttpServer.begin();
  Serial.println("ESP HTTP server started for gate control commands on port 80.");
}

unsigned long lastUpdateTime = 0;
int server_reported_slots = 0;

void loop() {
  // Reconnect WiFi if needed
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi disconnected. Attempting to reconnect...");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    unsigned long wifiReconnectStart = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - wifiReconnectStart < 15000) { // Try for 15s
      delay(500);
      Serial.print('.');
    }
    if(WiFi.status() == WL_CONNECTED) {
        Serial.println("\nWiFi reconnected!");
        Serial.print("IP Address: "); Serial.println(WiFi.localIP());
    } else {
        Serial.println("\nWiFi reconnection failed.");
        delay(30000);
        return;
    }
  }

  espHttpServer.handleClient(); // Handle incoming HTTP requests for manual control

  // Check IR sensor for vehicle presence
  int irState = digitalRead(ir_open);

  if (!waitingToCloseOpen) { // Vehicle detected at gate, and gate is not already in an open-waiting-to-close cycle
    if (mfrc522.PICC_IsNewCardPresent() && mfrc522.PICC_ReadCardSerial()) {
      Serial.print("RFID Card detected. UID: ");
      String uid = uidToString(mfrc522);
      Serial.println(uid);

      // Call the updated server endpoint: /api/rfid-request
      if (notifyServer("/api/rfid-request", uid, server_reported_slots)) { 
        Serial.println("Access granted by server. Opening gate.");
        openGate(openGateServo);
        waitingToCloseOpen = true;
        openStartTime = millis();
      } else {
        Serial.println("Access denied by server or error occurred.");
      }

      mfrc522.PICC_HaltA();      // Halt PICC
      mfrc522.PCD_StopCrypto1(); // Stop encryption on PCD
      delay(1000); // Short delay to prevent immediate re-scan of the same card
    }
  }

  // Auto close gate after vehicle passes or timeout
  if (waitingToCloseOpen && 
      ( (millis() - openStartTime > 3000 && irState == HIGH) || (millis() - openStartTime > 10000) ) ) {
    Serial.println("Closing gate.");
    closeGate(openGateServo);
    waitingToCloseOpen = false;
    delay(500); // Delay after closing before being ready for new detection
  }
  
  // Send slot info to server periodically
  if (millis() - lastUpdateTime > 10000) { // Every 10 seconds
    sendSlotInfoToServer();
    lastUpdateTime = millis();
  }
  delay(100); // Small general delay in the loop
}
