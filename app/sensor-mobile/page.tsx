"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIMU } from "../hooks/useIMU";

interface AccelerometerData {
  x: number;
  y: number;
  z: number;
}

type DevicePermissionApi = {
  requestPermission?: () => Promise<string>;
};

const FILTER_ALPHA = 0.98;
const COMMAND_DEAD_ZONE = 5;
const SMOOTH_PREV = 0.7;
const SMOOTH_NEW = 0.3;
const RAD_TO_DEG = 180 / Math.PI;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export default function SensorMobile() {
  const imu = useIMU();
  const [accel, setAccel] = useState<AccelerometerData>({ x: 0, y: 0, z: 0 });
  const [espHost, setEspHost] = useState("192.168.4.1");
  const [isStreaming, setIsStreaming] = useState(false);
  const [txCount, setTxCount] = useState(0);
  const [lastTxError, setLastTxError] = useState("");
  const [lastTxAt, setLastTxAt] = useState("");
  const [invertForward, setInvertForward] = useState(false);
  const [invertTurn, setInvertTurn] = useState(false);
  const [isMobileDevice, setIsMobileDevice] = useState(false);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [needsMotionPermission, setNeedsMotionPermission] = useState(false);
  const [motionSupported, setMotionSupported] = useState(true);
  const [isSecureOrigin, setIsSecureOrigin] = useState(true);
  const [motionActive, setMotionActive] = useState(false);
  const [filteredPitch, setFilteredPitch] = useState(0);
  const [filteredRoll, setFilteredRoll] = useState(0);
  const [forwardValue, setForwardValue] = useState(0);
  const [turnValue, setTurnValue] = useState(0);
  const accelRef = useRef<AccelerometerData>({ x: 0, y: 0, z: 0 });
  const txInFlightRef = useRef(false);
  const lastMotionTsRef = useRef<number | null>(null);
  const pitchEstimateRef = useRef(0);
  const rollEstimateRef = useRef(0);
  const pitchBiasRef = useRef(0);
  const rollBiasRef = useRef(0);
  const smoothForwardRef = useRef(0);
  const smoothTurnRef = useRef(0);
  const forwardRef = useRef(0);
  const turnRef = useRef(0);

  // Detect if mobile device
  useEffect(() => {
    const isMobile = () => {
      const ua = navigator.userAgent;
      const mobileUa =
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
      const ipadDesktopUa = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
      return mobileUa || ipadDesktopUa;
    };
    setIsMobileDevice(isMobile());
  }, []);

  // Detect support, permission model, and secure context.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const hasMotionApi = "DeviceMotionEvent" in window;
    setMotionSupported(hasMotionApi);

    const motionApi = window.DeviceMotionEvent as unknown as DevicePermissionApi;
    if (hasMotionApi && typeof motionApi.requestPermission === "function") {
      setNeedsMotionPermission(true);
    }

    const isLocalhost =
      window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    setIsSecureOrigin(window.isSecureContext || isLocalhost);
  }, []);

  // Non-iOS browsers often do not require a permission prompt.
  useEffect(() => {
    if (!imu.needsPermission && !needsMotionPermission) {
      setPermissionGranted(true);
    }
  }, [imu.needsPermission, needsMotionPermission]);

  // Setup accelerometer listener
  useEffect(() => {
    if (!isMobileDevice || !motionSupported) return;

    const permissionRequired = imu.needsPermission || needsMotionPermission;
    if (permissionRequired && !permissionGranted) return;

    const handleMotion = (event: DeviceMotionEvent) => {
      const source = event.acceleration ?? event.accelerationIncludingGravity;
      if (!source) return;

      const data: AccelerometerData = {
        x: source.x ?? 0,
        y: source.y ?? 0,
        z: source.z ?? 0,
      };
      accelRef.current = data;
      setAccel(data);
      setMotionActive(true);

      const ax = data.x;
      const ay = data.y;
      const az = data.z;
      const gyroPitchRate = event.rotationRate?.beta ?? 0;
      const gyroRollRate = event.rotationRate?.gamma ?? 0;

      const eventTs = event.timeStamp > 0 ? event.timeStamp : performance.now();
      const lastTs = lastMotionTsRef.current;
      const dt = lastTs ? clamp((eventTs - lastTs) / 1000, 0.005, 0.05) : 0.016;
      lastMotionTsRef.current = eventTs;

      const accelPitch = Math.atan2(-ax, Math.sqrt(ay * ay + az * az)) * RAD_TO_DEG;
      const accelRoll = Math.atan2(ay, az === 0 ? 0.0001 : az) * RAD_TO_DEG;

      const pitch =
        FILTER_ALPHA * (pitchEstimateRef.current + gyroPitchRate * dt) +
        (1 - FILTER_ALPHA) * accelPitch;
      const roll =
        FILTER_ALPHA * (rollEstimateRef.current + gyroRollRate * dt) +
        (1 - FILTER_ALPHA) * accelRoll;

      pitchEstimateRef.current = pitch;
      rollEstimateRef.current = roll;
      setFilteredPitch(pitch);
      setFilteredRoll(roll);

      const correctedPitch = pitch - pitchBiasRef.current;
      const correctedRoll = roll - rollBiasRef.current;

      let nextForward = clamp(correctedPitch, -100, 100);
      let nextTurn = clamp(correctedRoll, -100, 100);

      if (Math.abs(nextForward) < COMMAND_DEAD_ZONE) nextForward = 0;
      if (Math.abs(nextTurn) < COMMAND_DEAD_ZONE) nextTurn = 0;

      if (invertForward) nextForward *= -1;
      if (invertTurn) nextTurn *= -1;

      smoothForwardRef.current = smoothForwardRef.current * SMOOTH_PREV + nextForward * SMOOTH_NEW;
      smoothTurnRef.current = smoothTurnRef.current * SMOOTH_PREV + nextTurn * SMOOTH_NEW;

      forwardRef.current = smoothForwardRef.current;
      turnRef.current = smoothTurnRef.current;
      setForwardValue(Math.round(smoothForwardRef.current));
      setTurnValue(Math.round(smoothTurnRef.current));
    };

    window.addEventListener("devicemotion", handleMotion, true);
    return () => window.removeEventListener("devicemotion", handleMotion, true);
  }, [
    invertForward,
    invertTurn,
    imu.needsPermission,
    isMobileDevice,
    motionSupported,
    needsMotionPermission,
    permissionGranted,
  ]);

  // Handle permission request
  const handleRequestPermission = useCallback(async () => {
    if (!isSecureOrigin) {
      setPermissionGranted(false);
      return;
    }

    let orientationGranted = true;
    if (imu.needsPermission) {
      orientationGranted = await imu.requestPermission();
    }

    let motionGranted = true;
    if (typeof window !== "undefined" && "DeviceMotionEvent" in window) {
      const motionApi = window.DeviceMotionEvent as unknown as DevicePermissionApi;
      if (typeof motionApi.requestPermission === "function") {
        try {
          const result = await motionApi.requestPermission();
          motionGranted = result === "granted";
          if (motionGranted) setNeedsMotionPermission(false);
        } catch {
          motionGranted = false;
        }
      }
    }

    setPermissionGranted(orientationGranted && motionGranted);
  }, [imu, isSecureOrigin]);

  const toggleStreaming = useCallback(() => {
    if ((imu.needsPermission || needsMotionPermission) && !permissionGranted) {
      setLastTxError("Grant motion permission first.");
      return;
    }

    setIsStreaming((prev) => !prev);
  }, [imu.needsPermission, needsMotionPermission, permissionGranted]);

  useEffect(() => {
    if (!isStreaming) return;

    const sendSample = async () => {
      if (txInFlightRef.current) return;
      txInFlightRef.current = true;

      const nextForward = Math.round(forwardRef.current);
      const nextTurn = Math.round(turnRef.current);
      const params = new URLSearchParams({
        host: espHost.trim(),
        forward: nextForward.toString(),
        turn: nextTurn.toString(),
      });

      try {
        const response = await fetch(`/api/esp/control?${params.toString()}`, {
          method: "GET",
          cache: "no-store",
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Proxy request failed (${response.status})`);
        }

        setTxCount((count) => count + 1);
        setLastTxError("");
        setLastTxAt(new Date().toLocaleTimeString());
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to send sample";
        setLastTxError(message);
      } finally {
        txInFlightRef.current = false;
      }
    };

    void sendSample();
    const timer = window.setInterval(() => {
      void sendSample();
    }, 100);

    return () => {
      window.clearInterval(timer);
    };
  }, [espHost, isStreaming]);

  const gaugeCircle = (value: number, max: number, label: string) => {
    const percentage = Math.min(Math.abs(value) / max, 1) * 100;
    const rotation = (percentage / 100) * 180 - 90;

    return (
      <div className="flex flex-col items-center gap-4">
        <div className="w-32 h-32 rounded-full border-4 border-gray-700 bg-gray-900 flex items-center justify-center relative">
          <div
            className="absolute w-1 h-12 bg-cyan-400 origin-bottom transition-transform"
            style={{
              transform: `rotate(${rotation}deg)`,
              bottom: "50%",
              left: "50%",
              marginLeft: "-2px",
            }}
          />
          <span className="text-center">
            <div className="text-xl font-bold text-white">{value.toFixed(1)}°</div>
            <div className="text-xs text-gray-400">{label}</div>
          </span>
        </div>
      </div>
    );
  };

  if (!isMobileDevice) {
    return (
      <div className="w-screen h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-white mb-4">Mobile Sensor Page</h1>
          <p className="text-xl text-gray-400">
            This page is designed for mobile devices. Please open this URL on your phone to use the gyro and accelerometer sensors.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-screen h-screen bg-linear-to-br from-gray-950 to-black overflow-hidden flex flex-col">
      {/* Header */}
      <div className="bg-linear-to-r from-cyan-900 to-blue-900 p-4 border-b border-cyan-700">
        <h1 className="text-2xl font-bold text-white">Sensor Data</h1>
        <p className="text-sm text-gray-300">Gyroscope & Accelerometer</p>
      </div>

      {!isSecureOrigin && (
        <div className="bg-red-900 p-4 text-white border-b border-red-700">
          <p className="font-semibold">Secure context required for sensors.</p>
          <p className="text-sm text-red-100 mt-1">
            Open this page with HTTPS. On plain HTTP (for example LAN IP), mobile browsers often
            block gyroscope and accelerometer APIs.
          </p>
        </div>
      )}

      {!motionSupported && (
        <div className="bg-red-900 p-4 text-white border-b border-red-700">
          <p>This browser does not support DeviceMotionEvent.</p>
        </div>
      )}

      {/* Permission Request */}
      {(imu.needsPermission || needsMotionPermission) && !permissionGranted && (
        <div className="bg-amber-900 p-4 text-white border-b border-amber-700">
          <p className="mb-2">Tap to grant gyroscope and accelerometer access</p>
          <button
            onClick={handleRequestPermission}
            className="bg-amber-500 hover:bg-amber-600 text-black font-bold py-2 px-4 rounded"
          >
            Grant Permission
          </button>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-8">
          {/* ESP32 Stream Section */}
          <div className="bg-gray-900 rounded-lg p-6 border border-orange-700">
            <h2 className="text-2xl font-bold text-orange-400 mb-4">ESP32 Stream</h2>
            <p className="text-sm text-gray-300 mb-4">
              Sends filtered motion commands continuously as forward/turn to your Arduino endpoint
              <span className="font-mono text-orange-300"> /control?forward=...&amp;turn=...</span>
            </p>

            <div className="flex gap-3 mb-4">
              <input
                value={espHost}
                onChange={(e) => setEspHost(e.target.value)}
                placeholder="192.168.4.1"
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white"
                inputMode="url"
              />
              <button
                onClick={toggleStreaming}
                className={`px-4 py-2 rounded font-bold transition-colors ${
                  isStreaming
                    ? "bg-red-600 hover:bg-red-700 text-white"
                    : "bg-orange-500 hover:bg-orange-600 text-black"
                }`}
              >
                {isStreaming ? "Stop" : "Start"}
              </button>
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-gray-300">
                <span>Forward Cmd:</span>
                <span className="text-orange-300 font-mono">{forwardValue}</span>
              </div>
              <div className="flex justify-between text-gray-300">
                <span>Turn Cmd:</span>
                <span className="text-orange-300 font-mono">{turnValue}</span>
              </div>
              <div className="flex justify-between text-gray-300">
                <span>Invert:</span>
                <span className="text-gray-200" style={{ display: "flex", gap: 10 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={invertForward}
                      onChange={(e) => setInvertForward(e.target.checked)}
                    />
                    FWD
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={invertTurn}
                      onChange={(e) => setInvertTurn(e.target.checked)}
                    />
                    TURN
                  </label>
                </span>
              </div>
              <div className="flex justify-between text-gray-300">
                <span>Streaming:</span>
                <span className={isStreaming ? "text-green-300" : "text-gray-400"}>
                  {isStreaming ? "ON (10 Hz)" : "OFF"}
                </span>
              </div>
              <div className="flex justify-between text-gray-300">
                <span>Packets Sent:</span>
                <span className="text-orange-300 font-mono">{txCount}</span>
              </div>
              <div className="flex justify-between text-gray-300">
                <span>Last Sent:</span>
                <span className="text-orange-300 font-mono">{lastTxAt || "-"}</span>
              </div>
              {lastTxError && <p className="text-red-300">Error: {lastTxError}</p>}
            </div>
          </div>

          {/* Gyroscope Section */}
          <div className="bg-gray-900 rounded-lg p-6 border border-cyan-700">
            <h2 className="text-2xl font-bold text-cyan-400 mb-6">Filtered Tilt (Complementary)</h2>
            <div className="grid grid-cols-3 gap-4">
              {gaugeCircle(filteredPitch, 100, "Pitch")}
              {gaugeCircle(filteredRoll, 100, "Roll")}
              {gaugeCircle(imu.calibrated.alpha, 360, "Alpha (Z)")}
            </div>

            {/* Raw Values */}
            <div className="mt-6 space-y-2 text-sm">
              <div className="flex justify-between text-gray-300">
                <span>Raw Beta:</span>
                <span className="text-cyan-300 font-mono">{imu.raw.beta.toFixed(2)}°</span>
              </div>
              <div className="flex justify-between text-gray-300">
                <span>Raw Gamma:</span>
                <span className="text-cyan-300 font-mono">{imu.raw.gamma.toFixed(2)}°</span>
              </div>
              <div className="flex justify-between text-gray-300">
                <span>Raw Alpha:</span>
                <span className="text-cyan-300 font-mono">{imu.raw.alpha.toFixed(2)}°</span>
              </div>
            </div>

            {/* Calibration Button */}
            <button
              onClick={() => {
                imu.calibrate();
                pitchBiasRef.current = pitchEstimateRef.current;
                rollBiasRef.current = rollEstimateRef.current;
                smoothForwardRef.current = 0;
                smoothTurnRef.current = 0;
                forwardRef.current = 0;
                turnRef.current = 0;
                setForwardValue(0);
                setTurnValue(0);
              }}
              className="mt-4 w-full bg-cyan-600 hover:bg-cyan-700 text-white font-bold py-2 px-4 rounded transition-colors"
            >
              Calibrate (Set Current as Zero)
            </button>
          </div>

          {/* Accelerometer Section */}
          <div className="bg-gray-900 rounded-lg p-6 border border-purple-700">
            <h2 className="text-2xl font-bold text-purple-400 mb-6">Accelerometer (Motion)</h2>

            {/* Acceleration Vector Display */}
            <div className="mb-6">
              <div className="bg-gray-800 rounded p-4 mb-4">
                <svg viewBox="-150 -150 300 300" className="w-full max-w-xs mx-auto">
                  {/* Grid */}
                  <circle cx="0" cy="0" r="100" fill="none" stroke="#444" strokeWidth="1" />
                  <circle cx="0" cy="0" r="50" fill="none" stroke="#666" strokeWidth="1" />
                  <line x1="-150" y1="0" x2="150" y2="0" stroke="#555" strokeWidth="1" />
                  <line x1="0" y1="-150" x2="0" y2="150" stroke="#555" strokeWidth="1" />

                  {/* Acceleration vector */}
                  <line
                    x1="0"
                    y1="0"
                    x2={accel.x * 5}
                    y2={accel.y * 5}
                    stroke="#a78bfa"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                  <circle
                    cx={accel.x * 5}
                    cy={accel.y * 5}
                    r="8"
                    fill="#a78bfa"
                    opacity="0.8"
                  />

                  {/* Labels */}
                  <text x="130" y="-10" fill="#888" fontSize="12">
                    X
                  </text>
                  <text x="-10" y="-130" fill="#888" fontSize="12">
                    Y
                  </text>
                </svg>
              </div>
              <p className="text-sm text-gray-400">X-Y Acceleration (viewed from above)</p>
            </div>

            {/* Detailed Values */}
            <div className="space-y-3">
              <div className="flex justify-between items-center bg-gray-800 p-3 rounded">
                <span className="text-gray-300">X Acceleration:</span>
                <span className="text-purple-300 font-mono text-lg">
                  {accel.x.toFixed(2)} m/s²
                </span>
              </div>
              <div className="flex justify-between items-center bg-gray-800 p-3 rounded">
                <span className="text-gray-300">Y Acceleration:</span>
                <span className="text-purple-300 font-mono text-lg">
                  {accel.y.toFixed(2)} m/s²
                </span>
              </div>
              <div className="flex justify-between items-center bg-gray-800 p-3 rounded">
                <span className="text-gray-300">Z Acceleration:</span>
                <span className="text-purple-300 font-mono text-lg">
                  {accel.z.toFixed(2)} m/s²
                </span>
              </div>
              <div className="flex justify-between items-center bg-gray-800 p-3 rounded">
                <span className="text-gray-300">Total Magnitude:</span>
                <span className="text-purple-300 font-mono text-lg">
                  {Math.sqrt(
                    accel.x * accel.x + accel.y * accel.y + accel.z * accel.z
                  ).toFixed(2)} m/s²
                </span>
              </div>
            </div>
          </div>

          {/* Status Section */}
          <div className="bg-gray-900 rounded-lg p-6 border border-green-700">
            <h2 className="text-lg font-bold text-green-400 mb-4">Status</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Device:</span>
                <span className="text-green-300">
                  {isMobileDevice ? "📱 Mobile" : "💻 Desktop"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Gyroscope:</span>
                <span className={imu.isActive ? "text-green-300" : "text-red-300"}>
                  {imu.isActive ? "✓ Active" : "✗ Inactive"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Accelerometer:</span>
                <span className={motionActive ? "text-green-300" : "text-red-300"}>
                  {motionActive ? "✓ Active" : "✗ Inactive"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Permission:</span>
                <span
                  className={
                    (!imu.needsPermission && !needsMotionPermission) || permissionGranted
                      ? "text-green-300"
                      : "text-yellow-300"
                  }
                >
                  {!imu.needsPermission && !needsMotionPermission
                    ? "✓ Not Required"
                    : permissionGranted
                      ? "✓ Granted"
                      : "⚠ Required"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Secure Context:</span>
                <span className={isSecureOrigin ? "text-green-300" : "text-red-300"}>
                  {isSecureOrigin ? "✓ Yes" : "✗ No"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="bg-gray-900 border-t border-gray-700 p-4 text-center text-sm text-gray-500">
        Real-time sensor data • Keep phone level to see gyro changes
      </div>
    </div>
  );
}
