
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ConnectionStatus = "offline" | "connecting" | "connected" | "reconnecting" | "error";
type ConnectionMode = "none" | "websocket" | "esp-http";

interface OrientationData {
  beta: number;
  gamma: number;
  alpha: number;
}

type OrientationPermissionApi = {
  requestPermission?: () => Promise<"granted" | "denied">;
};

type MotionPermissionApi = {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const SEND_HZ = 40;
const SEND_INTERVAL = 1000 / SEND_HZ;
const MAX_SPEED = 100;
const MAX_TURN = 100;
const FILTER_ALPHA = 0.98;
const COMMAND_DEAD_ZONE = 5;
const SMOOTH_PREV = 0.7;
const SMOOTH_NEW = 0.3;
const RAD_TO_DEG = 180 / Math.PI;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isLoopbackHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeWsUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  let candidate = raw;
  if (/^https?:\/\//i.test(candidate)) {
    candidate = candidate.replace(/^http/i, "ws");
  } else if (!/^wss?:\/\//i.test(candidate)) {
    const securePage = typeof window !== "undefined" && window.location.protocol === "https:";
    candidate = `${securePage ? "wss" : "ws"}://${candidate}`;
  }

  try {
    const url = new URL(candidate);
    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/ws";
    }
    return url.toString();
  } catch {
    return null;
  }
}

export default function Home() {
  const [status, setStatus] = useState<ConnectionStatus>("offline");
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("none");
  const [ipInput, setIpInput] = useState("192.168.4.1");
  const [showPermissionOverlay, setShowPermissionOverlay] = useState(true);
  const [showCalOverlay, setShowCalOverlay] = useState(false);
  const [calCount, setCalCount] = useState(3);
  const [stopped, setStopped] = useState(false);
  const [invertForward, setInvertForward] = useState(false);
  const [invertTurn, setInvertTurn] = useState(false);
  const [speedMulPct, setSpeedMulPct] = useState(70);
  const [steerMulPct, setSteerMulPct] = useState(60);
  const [raw, setRaw] = useState<OrientationData>({ beta: 0, gamma: 0, alpha: 0 });
  const [speed, setSpeed] = useState(0);
  const [turn, setTurn] = useState(0);
  const [txCount, setTxCount] = useState(0);
  const [txFlash, setTxFlash] = useState(false);
  const [wsUrl, setWsUrl] = useState("");
  const [espHost, setEspHost] = useState("");
  const [wsErrorDetail, setWsErrorDetail] = useState("");
  const [wsAttempt, setWsAttempt] = useState(0);
  const [connectRequested, setConnectRequested] = useState(false);
  const [calOffsets, setCalOffsets] = useState({ beta: 0, gamma: 0 });
  const [filteredPitch, setFilteredPitch] = useState(0);
  const [filteredRoll, setFilteredRoll] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const txFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const calTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sensorHandlerRef = useRef<((e: DeviceOrientationEvent) => void) | null>(null);
  const motionHandlerRef = useRef<((e: DeviceMotionEvent) => void) | null>(null);
  const rawRef = useRef<OrientationData>({ beta: 0, gamma: 0, alpha: 0 });
  const calOffsetsRef = useRef({ beta: 0, gamma: 0 });
  const connectRequestedRef = useRef(false);
  const connectionModeRef = useRef<ConnectionMode>("none");
  const espHostRef = useRef("");
  const httpTxInFlightRef = useRef(false);
  const lastHttpSendAtRef = useRef(0);
  const lastMotionTsRef = useRef<number | null>(null);
  const invertForwardRef = useRef(false);
  const invertTurnRef = useRef(false);
  const pitchEstimateRef = useRef(0);
  const rollEstimateRef = useRef(0);
  const pitchBiasRef = useRef(0);
  const rollBiasRef = useRef(0);
  const smoothForwardRef = useRef(0);
  const smoothTurnRef = useRef(0);
  const commandForwardRef = useRef(0);
  const commandTurnRef = useRef(0);
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
    setConnectionMode("none");
    connectionModeRef.current = "none";
    setEspHost("");
    espHostRef.current = "";
    setWsUrl("");
    setWsErrorDetail("");
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

    const handleMotion = (e: DeviceMotionEvent) => {
      const accel = e.accelerationIncludingGravity ?? e.acceleration;
      if (!accel) return;

      const ax = accel.x ?? 0;
      const ay = accel.y ?? 0;
      const az = accel.z ?? 0;

      const gyroPitchRate = e.rotationRate?.beta ?? 0;
      const gyroRollRate = e.rotationRate?.gamma ?? 0;

      const eventTs = e.timeStamp > 0 ? e.timeStamp : performance.now();
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

      let forwardValue = clamp(correctedPitch, -100, 100);
      let turnValue = clamp(correctedRoll, -100, 100);

      if (Math.abs(forwardValue) < COMMAND_DEAD_ZONE) forwardValue = 0;
      if (Math.abs(turnValue) < COMMAND_DEAD_ZONE) turnValue = 0;

      if (invertForwardRef.current) forwardValue *= -1;
      if (invertTurnRef.current) turnValue *= -1;

      smoothForwardRef.current =
        smoothForwardRef.current * SMOOTH_PREV + forwardValue * SMOOTH_NEW;
      smoothTurnRef.current = smoothTurnRef.current * SMOOTH_PREV + turnValue * SMOOTH_NEW;

      commandForwardRef.current = smoothForwardRef.current;
      commandTurnRef.current = smoothTurnRef.current;
    };

    sensorHandlerRef.current = handleOrientation;
    motionHandlerRef.current = handleMotion;
    window.addEventListener("deviceorientation", handleOrientation, true);
    window.addEventListener("devicemotion", handleMotion, true);
  }, []);

  const stopSensors = useCallback(() => {
    if (typeof window === "undefined") return;

    if (sensorHandlerRef.current) {
      window.removeEventListener("deviceorientation", sensorHandlerRef.current, true);
      sensorHandlerRef.current = null;
    }

    if (motionHandlerRef.current) {
      window.removeEventListener("devicemotion", motionHandlerRef.current, true);
      motionHandlerRef.current = null;
    }

    lastMotionTsRef.current = null;
  }, []);

  const grantAccess = useCallback(async () => {
    let orientationGranted = true;
    let motionGranted = true;

    if (typeof window !== "undefined" && "DeviceOrientationEvent" in window) {
      const orientationApi =
        window.DeviceOrientationEvent as unknown as OrientationPermissionApi;

      if (typeof orientationApi.requestPermission === "function") {
        try {
          const permission = await orientationApi.requestPermission();
          orientationGranted = permission === "granted";
        } catch {
          orientationGranted = false;
        }
      }
    }

    if (typeof window !== "undefined" && "DeviceMotionEvent" in window) {
      const motionApi = window.DeviceMotionEvent as unknown as MotionPermissionApi;
      if (typeof motionApi.requestPermission === "function") {
        try {
          const permission = await motionApi.requestPermission();
          motionGranted = permission === "granted";
        } catch {
          motionGranted = false;
        }
      }
    }

    if (orientationGranted && motionGranted) {
      startSensors();
      setShowPermissionOverlay(false);
      return;
    }

    window.alert("Sensor permission denied.");
  }, [startSensors]);

  const connect = useCallback(() => {
    const input = ipInput.trim();
    if (!input) {
      setStatus("error");
      setWsErrorDetail("Enter a target host or ws:// URL.");
      return;
    }

    if (/^wss?:\/\//i.test(input)) {
      const resolvedUrl = normalizeWsUrl(input);
      if (!resolvedUrl) {
        setStatus("error");
        setWsErrorDetail("Invalid WebSocket URL.");
        return;
      }

      try {
        const target = new URL(resolvedUrl);
        const securePage =
          typeof window !== "undefined" && window.location.protocol === "https:";

        if (securePage && target.protocol === "ws:" && !isLoopbackHost(target.hostname)) {
          setStatus("error");
          setWsErrorDetail(
            "Blocked by browser: HTTPS page cannot connect to ws:// remote targets. Use wss:// or enter plain IP for ESP HTTP mode."
          );
          return;
        }
      } catch {
        setStatus("error");
        setWsErrorDetail("Invalid WebSocket URL.");
        return;
      }

      connectRequestedRef.current = true;
      setConnectRequested(true);
      setConnectionMode("websocket");
      connectionModeRef.current = "websocket";
      setEspHost("");
      espHostRef.current = "";
      setWsErrorDetail("");
      setWsUrl(resolvedUrl);
      setWsAttempt((count) => count + 1);
      return;
    }

    try {
      const hostUrl = new URL(/^https?:\/\//i.test(input) ? input : `http://${input}`);
      const normalizedHost = hostUrl.host;
      if (!normalizedHost) {
        throw new Error("Missing host");
      }

      connectRequestedRef.current = true;
      setConnectRequested(true);
      setConnectionMode("esp-http");
      connectionModeRef.current = "esp-http";
      setWsUrl("");
      setEspHost(normalizedHost);
      espHostRef.current = normalizedHost;
      setWsErrorDetail("");
      setStatus("connected");
    } catch {
      setStatus("error");
      setWsErrorDetail("Invalid ESP32 host. Use IP[:port], hostname, or ws:// URL.");
    }
  }, [ipInput]);

  useEffect(() => {
    calOffsetsRef.current = calOffsets;
  }, [calOffsets]);

  useEffect(() => {
    connectRequestedRef.current = connectRequested;
  }, [connectRequested]);

  useEffect(() => {
    invertForwardRef.current = invertForward;
    invertTurnRef.current = invertTurn;
  }, [invertForward, invertTurn]);

  useEffect(() => {
    connectionModeRef.current = connectionMode;
  }, [connectionMode]);

  useEffect(() => {
    espHostRef.current = espHost;
  }, [espHost]);

  useEffect(() => {
    if (connectionMode !== "websocket") return;
    if (!connectRequested || !wsUrl || wsAttempt === 0) return;

    clearReconnectTimer();
    setStatus((prev) => (prev === "reconnecting" ? "reconnecting" : "connecting"));

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      setWsErrorDetail("");
      clearReconnectTimer();
    };

    ws.onclose = (event) => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }

      const detail = event.reason
        ? `Closed (${event.code}): ${event.reason}`
        : `Closed (${event.code})`;
      setWsErrorDetail(detail);

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
        setWsErrorDetail(
          "WebSocket error. If this page is HTTPS, the target usually must be wss://."
        );
      }
    };

    return () => {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    };
  }, [clearReconnectTimer, connectRequested, connectionMode, wsAttempt, wsUrl]);

  useEffect(() => {
    const loopId = window.setInterval(() => {
      if (stopped) {
        commandForwardRef.current = 0;
        commandTurnRef.current = 0;
        speedRef.current = 0;
        turnRef.current = 0;
        setSpeed(0);
        setTurn(0);
        return;
      }

      const targetForward = commandForwardRef.current * (speedMulPct / 100);
      const targetTurn = commandTurnRef.current * (steerMulPct / 100);

      const nextSpeed = Math.round(
        speedRef.current + (targetForward - speedRef.current) * 0.45
      );
      const nextTurn = Math.round(
        turnRef.current + (targetTurn - turnRef.current) * 0.45
      );

      speedRef.current = nextSpeed;
      turnRef.current = nextTurn;

      setSpeed((prev) => (prev === nextSpeed ? prev : nextSpeed));
      setTurn((prev) => (prev === nextTurn ? prev : nextTurn));

      if (connectionModeRef.current === "websocket") {
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
        return;
      }

      if (connectionModeRef.current === "esp-http" && connectRequestedRef.current) {
        const now = performance.now();
        if (httpTxInFlightRef.current || now - lastHttpSendAtRef.current < 100) {
          return;
        }

        lastHttpSendAtRef.current = now;
        httpTxInFlightRef.current = true;

        const params = new URLSearchParams({
          host: espHostRef.current,
          forward: nextSpeed.toString(),
          turn: nextTurn.toString(),
        });

        void fetch(`/api/esp/control?${params.toString()}`, {
          method: "GET",
          cache: "no-store",
        })
          .then(async (response) => {
            if (!response.ok) {
              const body = (await response.json().catch(() => null)) as
                | { error?: string }
                | null;
              throw new Error(body?.error ?? `ESP request failed (${response.status})`);
            }

            if (status !== "connected") {
              setStatus("connected");
            }
            setWsErrorDetail("");
            setTxCount((count) => count + 1);

            if (txFlashTimerRef.current) {
              clearTimeout(txFlashTimerRef.current);
            }
            setTxFlash(true);
            txFlashTimerRef.current = setTimeout(() => {
              setTxFlash(false);
            }, 40);
          })
          .catch((error: unknown) => {
            const message =
              error instanceof Error
                ? error.message
                : "Unable to reach ESP32 /gyro endpoint";
            setStatus("reconnecting");
            setWsErrorDetail(message);
          })
          .finally(() => {
            httpTxInFlightRef.current = false;
          });
      }
    }, SEND_INTERVAL);

    return () => {
      clearInterval(loopId);
    };
  }, [speedMulPct, status, steerMulPct, stopped]);

  useEffect(() => {
    const needsOrientationPermission =
      typeof window !== "undefined" &&
      "DeviceOrientationEvent" in window &&
      typeof (window.DeviceOrientationEvent as unknown as OrientationPermissionApi)
        .requestPermission === "function";

    const needsMotionPermission =
      typeof window !== "undefined" &&
      "DeviceMotionEvent" in window &&
      typeof (window.DeviceMotionEvent as unknown as MotionPermissionApi)
        .requestPermission === "function";

    if (!needsOrientationPermission && !needsMotionPermission) {
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

      pitchBiasRef.current = pitchEstimateRef.current;
      rollBiasRef.current = rollEstimateRef.current;
      smoothForwardRef.current = 0;
      smoothTurnRef.current = 0;
      commandForwardRef.current = 0;
      commandTurnRef.current = 0;

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
          <a href="/sensor-mobile" className="btn-link" title="View sensor data">
            📊
          </a>
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
            placeholder="192.168.x.x or ws://host:port/ws"
            value={ipInput}
            onChange={(e) => setIpInput(e.target.value)}
            inputMode="url"
          />
          <button
            className={`btn btn-connect ${status === "connected" ? "active" : ""}`}
            id="connectBtn"
            onClick={() => {
              vibrate(18);
              if (connectRequested) disconnect();
              else connect();
            }}
          >
            {connectRequested ? "DISCONNECT" : "CONNECT"}
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
          <div className="slider-row">
            <span className="slider-label">INV</span>
            <label className="slider-val" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={invertForward}
                onChange={(e) => setInvertForward(e.target.checked)}
              />
              FWD
            </label>
            <label className="slider-val" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={invertTurn}
                onChange={(e) => setInvertTurn(e.target.checked)}
              />
              TURN
            </label>
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
          {`β:${raw.beta.toFixed(1)}° γ:${raw.gamma.toFixed(1)}° α:${raw.alpha.toFixed(0)}° | pitch:${filteredPitch.toFixed(1)} roll:${filteredRoll.toFixed(1)} | cmdF:${speed} cmdT:${turn} | mode:${connectionModeRef.current} | link:${
            connectRequested ? "ON" : "OFF"
          } | tx:${txCount} | target:${connectionModeRef.current === "websocket" ? wsUrl || "-" : espHost || "-"}${wsErrorDetail ? ` | err:${wsErrorDetail}` : ""}`}
        </div>
      </main>
    </div>
  );
}
