
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ConnectionStatus = "offline" | "connecting" | "connected" | "reconnecting" | "error";

interface OrientationData {
  beta: number;
  gamma: number;
  alpha: number;
}

type OrientationPermissionApi = {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const SEND_HZ = 40;
const SEND_INTERVAL = 1000 / SEND_HZ;
const MAX_SPEED = 255;
const MAX_TURN = 100;
const DEAD_ZONE = 2.5;
const TILT_SCALE = 20;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export default function Home() {
  const [status, setStatus] = useState<ConnectionStatus>("offline");
  const [ipInput, setIpInput] = useState("192.168.4.1");
  const [showPermissionOverlay, setShowPermissionOverlay] = useState(true);
  const [showCalOverlay, setShowCalOverlay] = useState(false);
  const [calCount, setCalCount] = useState(3);
  const [stopped, setStopped] = useState(false);
  const [speedMulPct, setSpeedMulPct] = useState(70);
  const [steerMulPct, setSteerMulPct] = useState(60);
  const [raw, setRaw] = useState<OrientationData>({ beta: 0, gamma: 0, alpha: 0 });
  const [speed, setSpeed] = useState(0);
  const [turn, setTurn] = useState(0);
  const [txCount, setTxCount] = useState(0);
  const [txFlash, setTxFlash] = useState(false);
  const [wsUrl, setWsUrl] = useState("");
  const [wsAttempt, setWsAttempt] = useState(0);
  const [connectRequested, setConnectRequested] = useState(false);
  const [calOffsets, setCalOffsets] = useState({ beta: 0, gamma: 0 });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const txFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const calTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sensorHandlerRef = useRef<((e: DeviceOrientationEvent) => void) | null>(null);
  const rawRef = useRef<OrientationData>({ beta: 0, gamma: 0, alpha: 0 });
  const calOffsetsRef = useRef({ beta: 0, gamma: 0 });
  const connectRequestedRef = useRef(false);
  const speedRef = useRef(0);
  const turnRef = useRef(0);

  const vibrate = useCallback((pattern: number | number[]) => {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(pattern);
    }
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    connectRequestedRef.current = false;
    setConnectRequested(false);
    clearReconnectTimer();
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus("offline");
  }, [clearReconnectTimer]);

  const startSensors = useCallback(() => {
    if (typeof window === "undefined" || sensorHandlerRef.current) return;
    const handleOrientation = (e: DeviceOrientationEvent) => {
      const nextRaw = {
        beta: e.beta ?? 0,
        gamma: e.gamma ?? 0,
        alpha: e.alpha ?? 0,
      };
      rawRef.current = nextRaw;
      setRaw(nextRaw);
    };

    sensorHandlerRef.current = handleOrientation;
    window.addEventListener("deviceorientation", handleOrientation, true);
  }, []);

  const stopSensors = useCallback(() => {
    if (typeof window === "undefined" || !sensorHandlerRef.current) return;
    window.removeEventListener("deviceorientation", sensorHandlerRef.current, true);
    sensorHandlerRef.current = null;
  }, []);

  const grantAccess = useCallback(async () => {
    if (typeof window !== "undefined" && "DeviceOrientationEvent" in window) {
      const orientationApi =
        window.DeviceOrientationEvent as unknown as OrientationPermissionApi;

      if (typeof orientationApi.requestPermission === "function") {
        try {
          const permission = await orientationApi.requestPermission();
          if (permission === "granted") {
            startSensors();
          } else {
            window.alert("Sensor permission denied.");
          }
        } catch {
          window.alert("Sensor permission denied.");
        }
      } else {
        startSensors();
      }
    }

    setShowPermissionOverlay(false);
  }, [startSensors]);

  const connect = useCallback(() => {
    const ip = ipInput.trim();
    if (!ip) return;

    connectRequestedRef.current = true;
    setConnectRequested(true);
    setWsUrl(`ws://${ip}/ws`);
    setWsAttempt((count) => count + 1);
  }, [ipInput]);

  useEffect(() => {
    calOffsetsRef.current = calOffsets;
  }, [calOffsets]);

  useEffect(() => {
    connectRequestedRef.current = connectRequested;
  }, [connectRequested]);

  useEffect(() => {
    if (!connectRequested || !wsUrl || wsAttempt === 0) return;

    clearReconnectTimer();
    setStatus((prev) => (prev === "reconnecting" ? "reconnecting" : "connecting"));

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      clearReconnectTimer();
    };

    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }

      if (!connectRequestedRef.current) {
        setStatus("offline");
        return;
      }

      setStatus("reconnecting");
      clearReconnectTimer();
      reconnectTimerRef.current = setTimeout(() => {
        setWsAttempt((count) => count + 1);
      }, 2000);
    };

    ws.onerror = () => {
      if (connectRequestedRef.current) {
        setStatus("error");
      }
    };

    return () => {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    };
  }, [clearReconnectTimer, connectRequested, wsAttempt, wsUrl]);

  useEffect(() => {
    const loopId = window.setInterval(() => {
      if (stopped) {
        speedRef.current = 0;
        turnRef.current = 0;
        setSpeed(0);
        setTurn(0);
        return;
      }

      const rawB = rawRef.current.beta - calOffsetsRef.current.beta;
      const rawG = rawRef.current.gamma - calOffsetsRef.current.gamma;

      const db = Math.abs(rawB) < DEAD_ZONE ? 0 : rawB;
      const dg = Math.abs(rawG) < DEAD_ZONE ? 0 : rawG;

      const normB = clamp(db / TILT_SCALE, -1, 1);
      const normG = clamp(dg / TILT_SCALE, -1, 1);

      const targetSpeed = Math.round(normB * MAX_SPEED * (speedMulPct / 100));
      const targetTurn = Math.round(normG * MAX_TURN * (steerMulPct / 100));

      const nextSpeed = Math.round(speedRef.current + (targetSpeed - speedRef.current) * 0.4);
      const nextTurn = Math.round(turnRef.current + (targetTurn - turnRef.current) * 0.45);

      speedRef.current = nextSpeed;
      turnRef.current = nextTurn;

      setSpeed((prev) => (prev === nextSpeed ? prev : nextSpeed));
      setTurn((prev) => (prev === nextTurn ? prev : nextTurn));

      if (status === "connected" && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ speed: nextSpeed, turn: nextTurn }));
        setTxCount((count) => count + 1);

        if (txFlashTimerRef.current) {
          clearTimeout(txFlashTimerRef.current);
        }
        setTxFlash(true);
        txFlashTimerRef.current = setTimeout(() => {
          setTxFlash(false);
        }, 40);
      }
    }, SEND_INTERVAL);

    return () => {
      clearInterval(loopId);
    };
  }, [speedMulPct, status, steerMulPct, stopped]);

  useEffect(() => {
    const needsPermission =
      typeof window !== "undefined" &&
      "DeviceOrientationEvent" in window &&
      typeof (window.DeviceOrientationEvent as unknown as OrientationPermissionApi)
        .requestPermission === "function";

    if (!needsPermission) {
      setShowPermissionOverlay(false);
      startSensors();
    }

    return () => {
      stopSensors();
      disconnect();
      if (txFlashTimerRef.current) clearTimeout(txFlashTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (calTimerRef.current) clearInterval(calTimerRef.current);
    };
  }, [disconnect, startSensors, stopSensors]);

  const startCal = useCallback(() => {
    if (calTimerRef.current) {
      clearInterval(calTimerRef.current);
    }

    vibrate(25);

    let countdown = 3;
    setCalCount(countdown);
    setShowCalOverlay(true);

    calTimerRef.current = setInterval(() => {
      countdown -= 1;
      if (countdown > 0) {
        setCalCount(countdown);
        return;
      }

      if (calTimerRef.current) {
        clearInterval(calTimerRef.current);
        calTimerRef.current = null;
      }

      const nextOffsets = {
        beta: rawRef.current.beta,
        gamma: rawRef.current.gamma,
      };
      calOffsetsRef.current = nextOffsets;
      setCalOffsets(nextOffsets);
      setShowCalOverlay(false);
    }, 1000);
  }, [vibrate]);

  const toggleStop = useCallback(() => {
    vibrate([35, 40, 35]);
    setStopped((prev) => {
      const next = !prev;
      if (next && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ speed: 0, turn: 0 }));
      }
      return next;
    });
  }, [vibrate]);

  const statusClass = useMemo(() => {
    if (status === "connected") return "connected";
    if (status === "connecting" || status === "reconnecting") return "connecting";
    if (status === "error") return "error";
    return "";
  }, [status]);

  const statusLabel = useMemo(() => {
    if (status === "connecting") return "CONNECTING...";
    if (status === "connected") return "CONNECTED";
    if (status === "reconnecting") return "RECONNECTING...";
    if (status === "error") return "ERROR";
    return "OFFLINE";
  }, [status]);

  const dirRingClass = useMemo(() => {
    const classes = ["dir-ring"];

    if (Math.abs(speed) > 20 || Math.abs(turn) > 10) {
      if (speed > 20) classes.push("active-fwd");
      else if (speed < -20) classes.push("active-back");

      if (turn > 10) classes.push("active-right");
      else if (turn < -10) classes.push("active-left");
    }

    return classes.join(" ");
  }, [speed, turn]);

  const tiltDotClass = useMemo(() => {
    const classes = ["tilt-dot"];
    if (speed > 20) classes.push("moving-fwd");
    if (speed < -20) classes.push("moving-back");
    return classes.join(" ");
  }, [speed]);

  const dotX = 50 + (turn / MAX_TURN) * 46;
  const dotY = 50 - (speed / MAX_SPEED) * 46;
  const leftMotor = clamp(speed + turn, -255, 255);
  const rightMotor = clamp(speed - turn, -255, 255);
  const motionIntensity = clamp((Math.abs(speed) / MAX_SPEED + Math.abs(turn) / MAX_TURN) / 2, 0, 1);
  const arenaTiltX = clamp(-(raw.beta - calOffsets.beta) / 7, -8, 8);
  const arenaTiltY = clamp((raw.gamma - calOffsets.gamma) / 7, -8, 8);
  const motionState = stopped ? "STOPPED" : motionIntensity > 0.12 ? "ACTIVE" : "READY";

  return (
    <div className={`gmotion ${motionIntensity > 0.12 ? "is-driving" : ""} ${stopped ? "is-stopped" : ""}`}>
      <div className={`overlay ${showPermissionOverlay ? "" : "hidden"}`} id="permOverlay">
        <div className="overlay-icon">📡</div>
        <div className="overlay-title">G-Motion Controller</div>
        <div className="overlay-body">
          This app uses your phone&apos;s motion sensors to control a robot.
          <br />
          <br />
          Tap below to grant sensor access.
        </div>
        <button className="btn-grant" id="grantBtn" onClick={grantAccess}>
          Grant Access
        </button>
      </div>

      <div className={`cal-overlay ${showCalOverlay ? "" : "hidden"}`} id="calOverlay">
        <div className="cal-msg">Hold phone flat &amp; still</div>
        <div className="cal-countdown" id="calCount">
          {calCount}
        </div>
        <div className="cal-msg">Calibrating sensors...</div>
      </div>

      <header>
        <div className="logo">
          <div className="logo-mark" />
          <span className="logo-text">G-MOTION</span>
        </div>
        <div className="header-right">
          <div className={`status-dot ${statusClass}`} id="statusDot" />
          <span className={`status-label ${statusClass}`} id="statusLabel">
            {statusLabel}
          </span>
        </div>
      </header>

      <main>
        <div className={`banner ${status === "reconnecting" ? "visible" : ""}`} id="reconnBanner">
          ⚠ CONNECTION LOST - RECONNECTING
        </div>

        <div className="connect-panel">
          <input
            className="ip-input"
            type="text"
            id="ipInput"
            placeholder="192.168.x.x"
            value={ipInput}
            onChange={(e) => setIpInput(e.target.value)}
            inputMode="decimal"
          />
          <button
            className={`btn btn-connect ${status === "connected" ? "active" : ""}`}
            id="connectBtn"
            onClick={() => {
              vibrate(18);
              if (status === "connected") disconnect();
              else connect();
            }}
          >
            {status === "connected" ? "DISCONNECT" : "CONNECT"}
          </button>
        </div>

        <div className="viz-section">
          <div className="tilt-aura" style={{ opacity: 0.18 + motionIntensity * 0.45 }} />
          <div
            className="tilt-arena"
            id="tiltArena"
            style={{
              transform: `perspective(700px) rotateX(${arenaTiltX}deg) rotateY(${arenaTiltY}deg)`,
            }}
          >
            <span className="zone-label zone-fwd">FWD</span>
            <span className="zone-label zone-bck">REV</span>
            <span className="zone-label zone-lft">L</span>
            <span className="zone-label zone-rgt">R</span>
            <div className="crosshair-h" />
            <div className="crosshair-v" />
            <div className="corner-br" />
            <div className="corner-bl" />
            <div className={dirRingClass} id="dirRing" />
            <div
              className={tiltDotClass}
              id="tiltDot"
              style={{ left: `${dotX}%`, top: `${dotY}%` }}
            />
          </div>
          <div className={`tx-flash ${txFlash ? "active" : ""}`} id="txFlash" />
          <div className="motion-readout">
            <span>{motionState}</span>
            <span>{`V:${Math.round(motionIntensity * 100)}%`}</span>
          </div>
        </div>

        <div className="metrics">
          <div className="metric">
            <div className="metric-label">SPEED</div>
            <div className="metric-value" id="mSpeed">
              {speed}
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">TURN</div>
            <div className="metric-value" id="mTurn">
              {turn}
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">L-MTR</div>
            <div className="metric-value" id="mLeft">
              {leftMotor}
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">R-MTR</div>
            <div className="metric-value" id="mRight">
              {rightMotor}
            </div>
          </div>
        </div>

        <div className="controls">
          <div className="slider-row">
            <span className="slider-label">SPEEDx</span>
            <input
              type="range"
              id="speedMul"
              min="10"
              max="100"
              value={speedMulPct}
              onChange={(e) => setSpeedMulPct(Number(e.target.value))}
            />
            <span className="slider-val" id="speedMulVal">
              {speedMulPct}%
            </span>
          </div>
          <div className="slider-row">
            <span className="slider-label">STEERx</span>
            <input
              type="range"
              id="steerMul"
              min="10"
              max="100"
              value={steerMulPct}
              onChange={(e) => setSteerMulPct(Number(e.target.value))}
            />
            <span className="slider-val" id="steerMulVal">
              {steerMulPct}%
            </span>
          </div>
        </div>

        <div className="action-bar">
          <button
            className={`btn-stop-big ${stopped ? "is-resume" : ""}`}
            id="eStopBtn"
            onClick={toggleStop}
          >
            {stopped ? "▶ RESUME" : "⬛ E-STOP"}
          </button>
          <button className="btn-cal-sq" id="calBtn" onClick={startCal}>
            CAL
          </button>
        </div>

        <div className="debug-strip" id="debugStrip">
          {`β:${raw.beta.toFixed(1)}° γ:${raw.gamma.toFixed(1)}° α:${raw.alpha.toFixed(0)}° | ws:${
            status === "connected" ? "OPEN" : "IDLE"
          } | tx:${txCount}`}
        </div>
      </main>
    </div>
  );
}
