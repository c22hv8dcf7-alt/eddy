//! Vernier Go Direct (GDX) bridge — wired USB transport.
//!
//! Lets Eddy talk directly to Vernier Go Direct sensors (pH, optical DO,
//! conductivity, temperature, ...) plugged into the Mac over USB, so live
//! readings can be streamed into a sample's water-chemistry fields.
//!
//! The GDX wire protocol is a faithful Rust port of Vernier's official
//! open-source JavaScript library, godirect-js
//! (https://github.com/VernierST/godirect-js):
//!   * Command bytes, packet framing, rolling counter + checksum,
//!     command/response matching, and response parsers — src/Device.js
//!   * Command / measurement-type constants — src/constants.js
//!   * Sensor values arrive from the device already calibrated in sensor
//!     units (src/Sensor.js applies no scaling), so measurement floats are
//!     forwarded to the frontend as-is.
//!
//! USB transport facts, also from godirect-js:
//!   * Devices are selected by USB vendor id 0x08F7 (Vernier) and product
//!     id 0x0010 (src/godirect.js device filters). All Go Direct devices
//!     share this wired identity; the model is known from GET_INFO.
//!   * Over USB the device is a HID peripheral and the library's transport
//!     (src/WebUsbDeviceAdapter.js, which is WebHID despite the name)
//!     exchanges 64-byte HID reports. Each report carries a one-byte length
//!     prefix followed by that many bytes of the *same* framed GDX packet
//!     stream used on the Bluetooth transport; command packets are chunked
//!     to at most 63 bytes per report (`maxPacketLength`).
//!
//! Implementation notes for the rusb/libusb transport below:
//!   * The HID interface and its interrupt IN/OUT endpoints are discovered
//!     from the device's configuration descriptor at connect time, not
//!     hard-coded. If the interface has no interrupt OUT endpoint, output
//!     reports fall back to HID SET_REPORT control transfers.
//!   * Whether transfers begin with a HID report-id byte is detected from
//!     the HID report descriptor (GET_DESCRIPTOR / report), mirroring how
//!     WebHID exposes `collections[0].outputReports[0].reportId`.
//!   * KNOWN RISK for the first hardware test: on macOS the IOHID stack
//!     owns HID peripherals, and libusb may be refused when claiming the
//!     interface. If claiming fails on real hardware, the fallback design
//!     is an IOHIDManager-based transport behind this same session API.
//!
//! Frontend contract (events emitted via the app handle):
//!   * `gdx-device-found` `{ id, name, rssi }` — during scan, deduped by id;
//!     `rssi` is 0 over USB (the field exists for contract compatibility).
//!   * `gdx-status`       `{ state, message? }` — connected/disconnected/error
//!   * `gdx-reading`      `{ sensorId, value, unit }` — while measuring
//! Commands: `gdx_scan_start`, `gdx_scan_stop`, `gdx_connect`,
//! `gdx_disconnect`, `gdx_start`, `gdx_stop`. For USB, "scan" enumerates
//! plugged-in devices and (while active) polls for newly plugged ones.
//!
//! EXPERIMENTAL: not yet tested against physical hardware.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures::channel::oneshot;
use rusb::{Context, DeviceHandle, Direction, Recipient, RequestType, TransferType, UsbContext};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

// ---------------------------------------------------------------------------
// Protocol constants (godirect-js: src/constants.js, src/godirect.js)
// ---------------------------------------------------------------------------

/// Vernier USB vendor id (godirect-js device filter `vendorId: 0x08f7`).
const VERNIER_VENDOR_ID: u16 = 0x08f7;
/// Go Direct USB product id (godirect-js device filter `productId: 0x0010`).
const GDX_PRODUCT_ID: u16 = 0x0010;

/// First byte of every command packet (godirect-js `commands.HEADER[0]`).
const HEADER_BYTE: u8 = 0x58;
/// First byte of a measurement packet (godirect-js `responseType.MEASUREMENT`).
const RESPONSE_TYPE_MEASUREMENT: u8 = 0x20;
/// Max packet bytes per HID report (WebUsbDeviceAdapter `maxPacketLength`;
/// the 64-byte report reserves one byte for the length prefix).
const MAX_REPORT_PAYLOAD: usize = 63;
/// godirect-js rejects a command whose response has not arrived in 5 s.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

// Sub-commands (the byte at packet offset 4 identifies the command).
// From godirect-js src/constants.js.
const CMD_INIT: &[u8] = &[
    0x1a, 0xa5, 0x4a, 0x06, 0x49, 0x07, 0x48, 0x08, 0x47, 0x09, 0x46, 0x0a, 0x45, 0x0b, 0x44,
    0x0c, 0x43, 0x0d, 0x42, 0x0e, 0x41,
];
const CMD_GET_STATUS: &[u8] = &[0x10];
const CMD_GET_INFO: &[u8] = &[0x55];
const CMD_GET_SENSOR_IDS: &[u8] = &[0x51];
const CMD_GET_DEFAULT_SENSORS_MASK: &[u8] = &[0x56];
const CMD_GET_SENSOR_INFO: u8 = 0x50; // followed by the sensor number
const CMD_DISCONNECT: &[u8] = &[0x54];
const CMD_STOP_MEASUREMENTS: &[u8] = &[0x19, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff];

// Measurement packet types (packet byte 4), godirect-js `measurementType`.
const MT_NORMAL_REAL32: u8 = 0x06;
const MT_WIDE_REAL32: u8 = 0x07;
const MT_SINGLE_CHANNEL_REAL32: u8 = 0x08;
const MT_SINGLE_CHANNEL_INT32: u8 = 0x09;
const MT_APERIODIC_REAL32: u8 = 0x0a;
const MT_APERIODIC_INT32: u8 = 0x0b;
// 0x0c START_TIME, 0x0d DROPPED, 0x0e PERIOD are deliberately ignored,
// exactly as godirect-js ignores them.

// ---------------------------------------------------------------------------
// Frontend payloads
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct DeviceFoundPayload {
    id: String,
    name: String,
    /// Always 0 on USB; present because the frontend contract includes it.
    rssi: i16,
}

#[derive(Serialize, Clone)]
struct StatusPayload {
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Serialize, Clone)]
struct ReadingPayload {
    #[serde(rename = "sensorId")]
    sensor_id: u8,
    value: f64,
    unit: String,
}

/// One sensor channel of a connected device, as returned by `gdx_connect`.
#[derive(Serialize, Clone)]
pub struct GdxSensor {
    pub id: u8,
    pub name: String,
    pub unit: String,
}

/// Return value of `gdx_connect`.
#[derive(Serialize, Clone)]
pub struct GdxDeviceInfo {
    pub name: String,
    pub serial: String,
    pub sensors: Vec<GdxSensor>,
    /// Battery percentage from GET_STATUS (extra, informational).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battery: Option<u8>,
}

// ---------------------------------------------------------------------------
// Internal device model
// ---------------------------------------------------------------------------

/// Parsed GET_SENSOR_INFO record for one sensor channel.
#[derive(Clone, Debug)]
struct SensorInfo {
    number: u8,
    /// Vernier sensor id; godirect-js discards records whose id is 0.
    #[allow(dead_code)]
    sensor_id: u32,
    name: String,
    unit: String,
    /// Typical measurement period in milliseconds.
    typical_period_ms: u32,
}

/// Parse a measurement packet (byte 0 == 0x20), appending (sensor, value).
/// Layouts mirror godirect-js `_processMeasurements` exactly.
fn parse_measurements(packet: &[u8], out: &mut Vec<(u8, f64)>) {
    if packet.len() < 8 {
        return;
    }
    fn read_f32(packet: &[u8], idx: usize) -> Option<f32> {
        packet
            .get(idx..idx + 4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
    }
    fn read_i32(packet: &[u8], idx: usize) -> Option<i32> {
        packet
            .get(idx..idx + 4)
            .map(|b| i32::from_le_bytes(b.try_into().unwrap()))
    }
    match packet[4] {
        MT_NORMAL_REAL32 => {
            // sensor mask u16 LE @5, sample count u8 @7, f32 values @9,
            // interleaved sample-major across the masked sensors.
            let mask = u16::from_le_bytes([packet[5], packet[6]]) as u32;
            let count = packet[7] as usize;
            let mut idx = 9;
            for _ in 0..count {
                for num in mask_sensor_numbers(mask) {
                    if let Some(v) = read_f32(packet, idx) {
                        out.push((num, v as f64));
                    }
                    idx += 4;
                }
            }
        }
        MT_WIDE_REAL32 => {
            // sensor mask u32 LE @5, sample count u8 @9, f32 values @11.
            if packet.len() < 11 {
                return;
            }
            let mask = u32::from_le_bytes(packet[5..9].try_into().unwrap());
            let count = packet[9] as usize;
            let mut idx = 11;
            for _ in 0..count {
                for num in mask_sensor_numbers(mask) {
                    if let Some(v) = read_f32(packet, idx) {
                        out.push((num, v as f64));
                    }
                    idx += 4;
                }
            }
        }
        MT_SINGLE_CHANNEL_REAL32 | MT_APERIODIC_REAL32 => {
            // sensor number u8 @6, sample count u8 @7, f32 values @8.
            let num = packet[6];
            let count = packet[7] as usize;
            let mut idx = 8;
            for _ in 0..count {
                if let Some(v) = read_f32(packet, idx) {
                    out.push((num, v as f64));
                }
                idx += 4;
            }
        }
        MT_SINGLE_CHANNEL_INT32 | MT_APERIODIC_INT32 => {
            // sensor number u8 @6, sample count u8 @7, i32 values @8.
            let num = packet[6];
            let count = packet[7] as usize;
            let mut idx = 8;
            for _ in 0..count {
                if let Some(v) = read_i32(packet, idx) {
                    out.push((num, v as f64));
                }
                idx += 4;
            }
        }
        // START_TIME / DROPPED / PERIOD and unknown types: ignored,
        // as in godirect-js.
        _ => {}
    }
}

/// Sensor numbers present in a channel bitmask, ascending (godirect-js
/// `_getSensorsWithMask` order).
fn mask_sensor_numbers(mask: u32) -> Vec<u8> {
    (0..32).filter(|i| mask & (1u32 << i) != 0).collect()
}

/// NUL-trimmed UTF-8 string out of a fixed-width device field.
fn decode_field(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_string()
}

/// Parse a GET_SENSOR_INFO payload (packet bytes from offset 6).
/// Field offsets follow godirect-js `_getSensorInfo`, converting its
/// absolute `response.buffer` offsets (name @14, unit @74) to payload
/// offsets (name @8, unit @68).
fn parse_sensor_info(payload: &[u8]) -> Option<SensorInfo> {
    if payload.len() < 148 {
        return None;
    }
    let sensor_id = u32::from_le_bytes(payload[2..6].try_into().unwrap());
    if sensor_id == 0 {
        // godirect-js treats id 0 as a false-positive response.
        return None;
    }
    Some(SensorInfo {
        number: payload[0],
        sensor_id,
        name: decode_field(&payload[8..68]),
        unit: decode_field(&payload[68..100]),
        typical_period_ms: u32::from_le_bytes(payload[136..140].try_into().unwrap()) / 1000,
    })
}

fn payload_u32(payload: &[u8]) -> u32 {
    if payload.len() >= 4 {
        u32::from_le_bytes(payload[0..4].try_into().unwrap())
    } else {
        0
    }
}

// ---------------------------------------------------------------------------
// USB transport
// ---------------------------------------------------------------------------

/// An opened Go Direct device: claimed HID interface + its endpoints.
/// All transfers are short and serialized by the session, so the handle
/// lives behind a plain mutex shared with the blocking reader thread.
struct UsbTransport {
    handle: DeviceHandle<Context>,
    interface: u8,
    in_endpoint: u8,
    /// Interrupt OUT endpoint, if the interface exposes one.
    out_endpoint: Option<u8>,
    /// Transfer size for reports (endpoint max packet size; 64 for GDX).
    report_size: usize,
    /// True when the HID report descriptor declares report ids, in which
    /// case every transfer starts with the report-id byte (as WebHID does).
    uses_report_id: bool,
    report_id: u8,
}

impl UsbTransport {
    /// Write one command packet, chunked into length-prefixed HID reports
    /// (WebUsbDeviceAdapter semantics): each report is
    /// `[report id?] [length] [up to 63 packet bytes]`, so a report-id
    /// byte, when the device uses one, costs one payload byte.
    fn write_packet(&self, packet: &[u8]) -> Result<(), String> {
        let chunk_size = if self.uses_report_id {
            MAX_REPORT_PAYLOAD - 1
        } else {
            MAX_REPORT_PAYLOAD
        };
        for chunk in packet.chunks(chunk_size) {
            self.write_report(chunk)?;
        }
        Ok(())
    }

    fn write_report(&self, payload: &[u8]) -> Result<(), String> {
        let mut report = vec![0u8; self.report_size.max(payload.len() + 2)];
        let mut pos = 0;
        if self.uses_report_id {
            report[pos] = self.report_id;
            pos += 1;
        }
        report[pos] = payload.len() as u8;
        pos += 1;
        report[pos..pos + payload.len()].copy_from_slice(payload);
        let total = (pos + payload.len()).min(report.len());
        let data = &report[..total.max(self.report_size.min(report.len()))];

        match self.out_endpoint {
            Some(ep) => self
                .handle
                .write_interrupt(ep, data, Duration::from_millis(500))
                .map(|_| ())
                .map_err(|e| format!("USB write to Go Direct device failed: {e}")),
            None => {
                // HID SET_REPORT control transfer (output report type 0x02).
                let request_type = rusb::request_type(
                    Direction::Out,
                    RequestType::Class,
                    Recipient::Interface,
                );
                let value = (0x02u16 << 8) | self.report_id as u16;
                self.handle
                    .write_control(
                        request_type,
                        0x09, // SET_REPORT
                        value,
                        self.interface as u16,
                        data,
                        Duration::from_millis(500),
                    )
                    .map(|_| ())
                    .map_err(|e| format!("USB control write to Go Direct device failed: {e}"))
            }
        }
    }

    /// One interrupt read. Returns the packet-stream bytes carried by the
    /// report (length prefix applied), or `None` on a read timeout.
    /// Errors mean the device went away.
    fn read_stream_bytes(&self, buf: &mut [u8]) -> Result<Option<Vec<u8>>, String> {
        match self
            .handle
            .read_interrupt(self.in_endpoint, buf, Duration::from_millis(100))
        {
            Ok(n) => {
                let report = &buf[..n];
                let mut pos = 0;
                if self.uses_report_id {
                    // First byte is the report id; accept the report
                    // regardless of its value.
                    pos += 1;
                }
                if report.len() <= pos {
                    return Ok(Some(Vec::new()));
                }
                let declared = report[pos] as usize;
                pos += 1;
                let available = report.len() - pos;
                let take = declared.min(available);
                Ok(Some(report[pos..pos + take].to_vec()))
            }
            Err(rusb::Error::Timeout) => Ok(None),
            Err(e) => Err(format!("USB read from Go Direct device failed: {e}")),
        }
    }
}

/// Find the HID interface (class 0x03) and its interrupt endpoints from the
/// device's active configuration descriptor.
fn find_hid_endpoints(
    device: &rusb::Device<Context>,
) -> Result<(u8, u8, Option<u8>, usize), String> {
    let config = device
        .active_config_descriptor()
        .map_err(|e| format!("could not read USB configuration: {e}"))?;
    for interface in config.interfaces() {
        for descriptor in interface.descriptors() {
            if descriptor.class_code() != 0x03 {
                continue; // not the HID interface
            }
            let mut in_ep = None;
            let mut out_ep = None;
            let mut size = 64usize;
            for ep in descriptor.endpoint_descriptors() {
                if ep.transfer_type() != TransferType::Interrupt {
                    continue;
                }
                size = size.max(ep.max_packet_size() as usize);
                match ep.direction() {
                    Direction::In => in_ep = Some(ep.address()),
                    Direction::Out => out_ep = Some(ep.address()),
                }
            }
            if let Some(in_ep) = in_ep {
                return Ok((descriptor.interface_number(), in_ep, out_ep, size));
            }
        }
    }
    Err("no HID interface with an interrupt input endpoint found on the device".to_string())
}

/// Detect HID report-id usage from the report descriptor: scan for the
/// Report ID global item (0x85); the byte after it is the first report id.
/// Mirrors what WebHID surfaces as `outputReports[0].reportId`.
fn detect_report_id(handle: &DeviceHandle<Context>, interface: u8) -> (bool, u8) {
    let mut buf = [0u8; 256];
    let request_type =
        rusb::request_type(Direction::In, RequestType::Standard, Recipient::Interface);
    let read = handle.read_control(
        request_type,
        0x06, // GET_DESCRIPTOR
        0x2200, // descriptor type 0x22 (report), index 0
        interface as u16,
        &mut buf,
        Duration::from_millis(500),
    );
    match read {
        Ok(n) => {
            let descriptor = &buf[..n];
            for i in 0..descriptor.len().saturating_sub(1) {
                if descriptor[i] == 0x85 {
                    return (true, descriptor[i + 1]);
                }
            }
            (false, 0)
        }
        Err(_) => (false, 0),
    }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/// Serializes commands the way godirect-js's write queue does: exactly
/// one command is ever in flight. The value guarded by `send_lock` is
/// the rolling counter; holding the lock for a whole command (including
/// awaiting its response) is what enforces the invariant. The pending
/// response slot is a separate plain mutex because the packet pump must
/// fulfil it while `send_lock` is held.
struct Session {
    transport: Arc<StdMutex<UsbTransport>>,
    send_lock: Mutex<u8>,
    pending: StdMutex<Option<(u8, u8, oneshot::Sender<Vec<u8>>)>>,
    /// Filled in by the connect handshake; the reading pump consults it
    /// for units, `gdx_start` for periods and the enabled channel mask.
    sensors: StdMutex<Vec<SensorInfo>>,
    enabled: StdMutex<Vec<u8>>,
    collecting: Mutex<bool>,
    /// Set to stop the blocking reader thread.
    stop_reader: Arc<AtomicBool>,
    pump_task: StdMutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl Session {
    /// Build, frame and write one command, then await its response payload
    /// (packet bytes from offset 6, as in godirect-js `_resolveWriteCommand`).
    async fn send_command(&self, subcommand: &[u8]) -> Result<Vec<u8>, String> {
        // Held for the whole command: this is the write-queue invariant.
        let mut rolling = self.send_lock.lock().await;

        // godirect-js: rolling counter starts at 0xff on init and is
        // decremented before every command, so INIT itself uses 0xfe.
        *rolling = rolling.wrapping_sub(1);
        let counter = *rolling;

        // Frame: [0x58, length, counter, checksum, ...subcommand]
        let mut packet = Vec::with_capacity(4 + subcommand.len());
        packet.push(HEADER_BYTE);
        packet.push((4 + subcommand.len()) as u8);
        packet.push(counter);
        packet.push(0); // checksum placeholder (0 while summing, as in JS)
        packet.extend_from_slice(subcommand);
        packet[3] = packet.iter().fold(0u8, |acc, b| acc.wrapping_add(*b));

        let (tx, rx) = oneshot::channel();
        *self.pending.lock().unwrap() = Some((subcommand[0], counter, tx));

        let write_result = self.transport.lock().unwrap().write_packet(&packet);
        if let Err(e) = write_result {
            *self.pending.lock().unwrap() = None;
            return Err(e);
        }

        match tokio::time::timeout(COMMAND_TIMEOUT, rx).await {
            Ok(Ok(payload)) => Ok(payload),
            Ok(Err(_)) => Err("Go Direct device stopped responding".to_string()),
            Err(_) => {
                *self.pending.lock().unwrap() = None;
                Err("write command timed out after 5s".to_string())
            }
        }
    }

    /// Route one reassembled packet from the stream: measurements become
    /// readings; command responses fulfil the pending command when the
    /// (command, rolling counter) echo matches, and are dropped otherwise
    /// (godirect-js `_resolveWriteCommand` behaviour).
    async fn handle_packet(&self, packet: &[u8], readings: &mut Vec<(u8, f64)>) {
        if packet.first() == Some(&RESPONSE_TYPE_MEASUREMENT) {
            parse_measurements(packet, readings);
            return;
        }
        if packet.len() < 6 {
            return;
        }
        let (res_command, res_counter) = (packet[4], packet[5]);
        let payload = packet[6..].to_vec();
        let mut pending = self.pending.lock().unwrap();
        let matches = matches!(
            &*pending,
            Some((c, r, _)) if *c == res_command && *r == res_counter
        );
        if matches {
            if let Some((_, _, tx)) = pending.take() {
                let _ = tx.send(payload);
            }
        }
    }

    fn stop_tasks(&self) {
        self.stop_reader.store(true, Ordering::SeqCst);
        if let Some(h) = self.pump_task.lock().unwrap().take() {
            h.abort();
        }
    }
}

// ---------------------------------------------------------------------------
// Shared bridge state (managed by Tauri)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Inner {
    context: Option<Arc<Context>>,
    scan_task: Option<tauri::async_runtime::JoinHandle<()>>,
    found: HashMap<String, rusb::Device<Context>>,
    session: Option<Arc<Session>>,
}

/// Tauri-managed state for the GDX bridge.
#[derive(Clone, Default)]
pub struct GdxState {
    inner: Arc<StdMutex<Inner>>,
    scanning: Arc<AtomicBool>,
}

impl GdxState {
    fn context(&self) -> Result<Arc<Context>, String> {
        if let Some(c) = self.inner.lock().unwrap().context.clone() {
            return Ok(c);
        }
        let context = Context::new().map_err(|e| format!("USB unavailable: {e}"))?;
        let context = Arc::new(context);
        self.inner.lock().unwrap().context = Some(context.clone());
        Ok(context)
    }

    fn session(&self) -> Option<Arc<Session>> {
        self.inner.lock().unwrap().session.clone()
    }

    /// Remove the current session (if any) and tear it down: stop
    /// measurements, send DISCONNECT, release the interface. Emits
    /// nothing; callers decide which `gdx-status` to send.
    async fn take_session(&self) -> Option<Arc<Session>> {
        let session = self.inner.lock().unwrap().session.take()?;
        if *session.collecting.lock().await {
            let _ = session.send_command(CMD_STOP_MEASUREMENTS).await;
            *session.collecting.lock().await = false;
        }
        let _ = session.send_command(CMD_DISCONNECT).await;
        session.stop_tasks();
        {
            let transport = session.transport.lock().unwrap();
            let _ = transport.handle.release_interface(transport.interface);
        }
        Some(session)
    }
}

fn emit_status(app: &AppHandle, state: &str, message: Option<String>) {
    let _ = app.emit(
        "gdx-status",
        StatusPayload {
            state: state.to_string(),
            message,
        },
    );
}

// ---------------------------------------------------------------------------
// Scanning (USB enumeration)
// ---------------------------------------------------------------------------

/// Contract id for a USB device: stable for as long as it stays plugged
/// into the same port during a scan/connect flow.
fn usb_device_id(device: &rusb::Device<Context>) -> String {
    format!(
        "{:04x}:{:04x}@{}:{}",
        VERNIER_VENDOR_ID,
        GDX_PRODUCT_ID,
        device.bus_number(),
        device.address()
    )
}

/// Best-effort display name: the USB product string when the device lets
/// us read it, else a generic label. (The authoritative device name comes
/// from GET_INFO at connect time.)
fn usb_device_name(device: &rusb::Device<Context>) -> String {
    let fallback = "Go Direct sensor".to_string();
    let descriptor = match device.device_descriptor() {
        Ok(d) => d,
        Err(_) => return fallback,
    };
    let handle = match device.open() {
        Ok(h) => h,
        Err(_) => return fallback,
    };
    let languages = match handle.read_languages(Duration::from_millis(300)) {
        Ok(l) if !l.is_empty() => l,
        _ => return fallback,
    };
    handle
        .read_product_string(languages[0], &descriptor, Duration::from_millis(300))
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
}

/// Enumerate plugged-in Go Direct devices once, refreshing
/// `state.found`, and return (id, name) for the newly seen ones.
fn enumerate_once(state: &GdxState, seen: &mut HashSet<String>) -> Result<Vec<(String, String)>, String> {
    let context = state.context()?;
    let devices = context
        .devices()
        .map_err(|e| format!("could not enumerate USB devices: {e}"))?;
    let mut fresh = Vec::new();
    for device in devices.iter() {
        let descriptor = match device.device_descriptor() {
            Ok(d) => d,
            Err(_) => continue,
        };
        if descriptor.vendor_id() != VERNIER_VENDOR_ID
            || descriptor.product_id() != GDX_PRODUCT_ID
        {
            continue;
        }
        let id = usb_device_id(&device);
        let name = usb_device_name(&device);
        state
            .inner
            .lock()
            .unwrap()
            .found
            .insert(id.clone(), device);
        if seen.insert(id.clone()) {
            fresh.push((id, name));
        }
    }
    Ok(fresh)
}

#[tauri::command]
pub async fn gdx_scan_start(app: AppHandle, state: State<'_, GdxState>) -> Result<(), String> {
    stop_scan_inner(&state);
    state.inner.lock().unwrap().found.clear();
    state.scanning.store(true, Ordering::SeqCst);

    let mut seen = HashSet::new();
    for (id, name) in enumerate_once(&state, &mut seen)? {
        let _ = app.emit(
            "gdx-device-found",
            DeviceFoundPayload {
                id,
                name,
                rssi: 0,
            },
        );
    }

    // While scanning stays active, poll for devices plugged in later.
    // (Clone the managed state itself — its Arcs — not the State wrapper,
    // so the task owns a 'static handle.)
    let state_clone = (*state).clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut seen = seen;
        while state_clone.scanning.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if !state_clone.scanning.load(Ordering::SeqCst) {
                break;
            }
            if let Ok(fresh) = enumerate_once(&state_clone, &mut seen) {
                for (id, name) in fresh {
                    let _ = app.emit(
                        "gdx-device-found",
                        DeviceFoundPayload {
                            id,
                            name,
                            rssi: 0,
                        },
                    );
                }
            }
        }
    });
    state.inner.lock().unwrap().scan_task = Some(handle);
    Ok(())
}

fn stop_scan_inner(state: &GdxState) {
    state.scanning.store(false, Ordering::SeqCst);
    if let Some(h) = state.inner.lock().unwrap().scan_task.take() {
        h.abort();
    }
}

#[tauri::command]
pub async fn gdx_scan_stop(state: State<'_, GdxState>) -> Result<(), String> {
    stop_scan_inner(&state);
    Ok(())
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn gdx_connect(
    app: AppHandle,
    state: State<'_, GdxState>,
    id: String,
) -> Result<GdxDeviceInfo, String> {
    stop_scan_inner(&state);

    // Replace any previous session.
    let _ = state.take_session().await;

    let device = {
        let found = state.inner.lock().unwrap().found.get(&id).cloned();
        match found {
            Some(d) => d,
            None => {
                // Not in the scan cache: re-enumerate once and retry.
                let mut seen = HashSet::new();
                let _ = enumerate_once(&state, &mut seen);
                state
                    .inner
                    .lock()
                    .unwrap()
                    .found
                    .get(&id)
                    .cloned()
                    .ok_or_else(|| {
                        format!("device {id} not found — plug it in and run a scan first")
                    })?
            }
        }
    };

    match connect_and_handshake(&app, &state, device).await {
        Ok(info) => {
            emit_status(&app, "connected", None);
            Ok(info)
        }
        Err(e) => {
            emit_status(&app, "error", Some(e.clone()));
            Err(e)
        }
    }
}

async fn connect_and_handshake(
    app: &AppHandle,
    state: &GdxState,
    device: rusb::Device<Context>,
) -> Result<GdxDeviceInfo, String> {
    let (interface, in_endpoint, out_endpoint, report_size) = find_hid_endpoints(&device)?;

    let handle = device
        .open()
        .map_err(|e| format!("could not open Go Direct device: {e}"))?;
    // Detach a kernel driver if one holds the interface (Linux); a no-op
    // on macOS. NOTE: macOS may still refuse the claim below because the
    // IOHID stack owns HID peripherals — see the module doc comment.
    let _ = handle.set_auto_detach_kernel_driver(true);
    handle
        .claim_interface(interface)
        .map_err(|e| format!("could not claim the Go Direct USB interface: {e}"))?;

    let (uses_report_id, report_id) = detect_report_id(&handle, interface);

    let transport = Arc::new(StdMutex::new(UsbTransport {
        handle,
        interface,
        in_endpoint,
        out_endpoint,
        report_size,
        uses_report_id,
        report_id,
    }));

    let session = Arc::new(Session {
        transport: transport.clone(),
        // godirect-js sets the counter to 0xff at init; the first
        // send_command decrements it, so INIT goes out with 0xfe.
        send_lock: Mutex::new(0xff),
        pending: StdMutex::new(None),
        sensors: StdMutex::new(Vec::new()),
        enabled: StdMutex::new(Vec::new()),
        collecting: Mutex::new(false),
        stop_reader: Arc::new(AtomicBool::new(false)),
        pump_task: StdMutex::new(None),
    });

    spawn_reader(app.clone(), state.clone(), session.clone());

    // Brief settle after claiming before the first command.
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Handshake, in godirect-js `open()` order:
    // INIT -> GET_STATUS -> GET_INFO -> GET_DEFAULT_SENSORS_MASK ->
    // GET_SENSOR_IDS -> GET_SENSOR_INFO (per available sensor).
    let handshake = run_handshake(&session).await;
    let info = match handshake {
        Ok(info) => info,
        Err(e) => {
            session.stop_tasks();
            let transport = session.transport.lock().unwrap();
            let _ = transport.handle.release_interface(transport.interface);
            return Err(e);
        }
    };

    state.inner.lock().unwrap().session = Some(session);
    Ok(info)
}

async fn run_handshake(session: &Arc<Session>) -> Result<GdxDeviceInfo, String> {
    session.send_command(CMD_INIT).await?;

    let status = session.send_command(CMD_GET_STATUS).await?;
    // GET_STATUS payload (godirect-js `_getStatus`): battery @10.
    let battery = status.get(10).copied();

    let info = session.send_command(CMD_GET_INFO).await?;
    // GET_INFO payload: order code [0..16], serial [16..32], name [32..64].
    let serial = if info.len() >= 32 {
        decode_field(&info[16..32])
    } else {
        String::new()
    };
    let device_name = if info.len() >= 64 {
        decode_field(&info[32..64])
    } else {
        String::new()
    };

    let default_mask = payload_u32(&session.send_command(CMD_GET_DEFAULT_SENSORS_MASK).await?);
    let available_mask = payload_u32(&session.send_command(CMD_GET_SENSOR_IDS).await?);

    let mut sensors: Vec<SensorInfo> = Vec::new();
    for i in 0..31u8 {
        if available_mask & (1u32 << i) != 0 {
            let payload = session.send_command(&[CMD_GET_SENSOR_INFO, i]).await?;
            if let Some(info) = parse_sensor_info(&payload) {
                sensors.push(info);
            }
        }
    }

    // Enabled = the device's default sensors; fall back to the first
    // channel if the device reports no defaults (godirect-js enables
    // defaults in `start()`; Eddy enables them once, here).
    let mut enabled: Vec<u8> = sensors
        .iter()
        .filter(|s| default_mask & (1u32 << s.number) != 0)
        .map(|s| s.number)
        .collect();
    if enabled.is_empty() {
        if let Some(first) = sensors.first() {
            enabled.push(first.number);
        }
    }

    let out_sensors = sensors
        .iter()
        .map(|s| GdxSensor {
            id: s.number,
            name: s.name.clone(),
            unit: s.unit.clone(),
        })
        .collect();
    *session.sensors.lock().unwrap() = sensors;
    *session.enabled.lock().unwrap() = enabled;

    Ok(GdxDeviceInfo {
        name: device_name,
        serial,
        sensors: out_sensors,
        battery,
    })
}

/// Spawn the blocking USB reader thread and the async packet pump.
///
/// The reader thread owns interrupt reads; it de-frames HID reports into
/// raw packet-stream bytes and forwards them over a channel. The pump
/// reassembles length-prefixed GDX packets (packet byte 1 = total
/// length; packets may span several reports), routes them through the
/// session, and emits `gdx-reading` events. If the reader dies (device
/// unplugged), the channel closes, the pump ends, and the session is
/// cleared with a `disconnected` status — the USB analogue of a BLE
/// disconnect event.
fn spawn_reader(app: AppHandle, state: GdxState, session: Arc<Session>) {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(128);

    {
        let transport = session.transport.clone();
        let stop = session.stop_reader.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 1024];
            loop {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let chunk = {
                    let transport = transport.lock().unwrap();
                    transport.read_stream_bytes(&mut buf)
                };
                match chunk {
                    Ok(Some(bytes)) => {
                        if !bytes.is_empty() && tx.blocking_send(bytes).is_err() {
                            break; // pump is gone
                        }
                    }
                    Ok(None) => {} // read timeout: loop and re-check stop flag
                    Err(_) => break, // device went away
                }
            }
        });
    }

    let pump_session = session.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut buffer: Vec<u8> = Vec::new();
        while let Some(chunk) = rx.recv().await {
            buffer.extend_from_slice(&chunk);
            loop {
                if buffer.len() < 2 {
                    break;
                }
                let len = buffer[1] as usize;
                if len < 5 {
                    // Not a plausible packet start; resync by one byte.
                    buffer.drain(..1);
                    continue;
                }
                if buffer.len() < len {
                    break; // wait for the rest of the packet
                }
                let packet: Vec<u8> = buffer.drain(..len).collect();
                let mut readings = Vec::new();
                pump_session.handle_packet(&packet, &mut readings).await;
                if !readings.is_empty() {
                    let sensors = pump_session.sensors.lock().unwrap().clone();
                    for (num, value) in readings {
                        let unit = sensors
                            .iter()
                            .find(|s| s.number == num)
                            .map(|s| s.unit.clone())
                            .unwrap_or_default();
                        let _ = app.emit(
                            "gdx-reading",
                            ReadingPayload {
                                sensor_id: num,
                                value,
                                unit,
                            },
                        );
                    }
                }
            }
        }
        // Channel closed: the reader thread exited. If this session is
        // still the active one, the device disappeared unexpectedly.
        let is_current = state
            .inner
            .lock()
            .unwrap()
            .session
            .as_ref()
            .map(|s| Arc::ptr_eq(s, &pump_session))
            .unwrap_or(false);
        if is_current {
            state.inner.lock().unwrap().session = None;
            pump_session.stop_reader.store(true, Ordering::SeqCst);
            emit_status(&app, "disconnected", None);
        }
    });
    *session.pump_task.lock().unwrap() = Some(handle);
}

#[tauri::command]
pub async fn gdx_disconnect(app: AppHandle, state: State<'_, GdxState>) -> Result<(), String> {
    if state.take_session().await.is_some() {
        emit_status(&app, "disconnected", None);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn gdx_start(state: State<'_, GdxState>) -> Result<(), String> {
    let session = state
        .session()
        .ok_or_else(|| "no Go Direct device connected".to_string())?;
    if *session.collecting.lock().await {
        return Ok(());
    }
    let sensors = session.sensors.lock().unwrap().clone();
    let enabled = session.enabled.lock().unwrap().clone();

    // Period: godirect-js uses the largest typical period across enabled
    // sensors. Contract default is ~1000 ms when nothing reports one;
    // godirect-js also enforces a 10 ms floor.
    let mut period_ms: u32 = enabled
        .iter()
        .filter_map(|n| sensors.iter().find(|s| &s.number == n))
        .map(|s| s.typical_period_ms)
        .max()
        .unwrap_or(0);
    if period_ms == 0 {
        period_ms = 1000;
    }
    if period_ms < 10 {
        period_ms = 10;
    }
    // SET_MEASUREMENT_PERIOD: [0x1b, 0xff, 0x00, period_us LE u32, 0,0,0,0]
    let period_us = period_ms.saturating_mul(1000);
    let mut set_period = vec![0x1b, 0xff, 0x00];
    set_period.extend_from_slice(&period_us.to_le_bytes());
    set_period.extend_from_slice(&[0, 0, 0, 0]);
    session.send_command(&set_period).await?;

    // START_MEASUREMENTS: [0x18, 0xff, 0x01, channel mask LE u32, 0 x8]
    let mut channel_mask: u32 = 0;
    for n in &enabled {
        channel_mask |= 1u32 << n;
    }
    let mut start = vec![0x18, 0xff, 0x01];
    start.extend_from_slice(&channel_mask.to_le_bytes());
    start.extend_from_slice(&[0; 8]);
    let response = session.send_command(&start).await?;
    // godirect-js only marks the device collecting when payload[0] == 0.
    if response.first() != Some(&0) {
        return Err("Go Direct device refused to start measurements".to_string());
    }
    *session.collecting.lock().await = true;
    Ok(())
}

#[tauri::command]
pub async fn gdx_stop(state: State<'_, GdxState>) -> Result<(), String> {
    let session = state
        .session()
        .ok_or_else(|| "no Go Direct device connected".to_string())?;
    let response = session.send_command(CMD_STOP_MEASUREMENTS).await?;
    if response.first() == Some(&0) {
        *session.collecting.lock().await = false;
    }
    Ok(())
}
