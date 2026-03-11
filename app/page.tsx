
"use client";

import { useCallback, useEffect, useRef, useState, lazy, Suspense } from "react";
import { useIMU } from "./hooks/useIMU";
import { useWebSocket, WSStatus } from "./hooks/useWebSocket";
import { motion, AnimatePresence } from "motion/react";
import GradientText from "./components/GradientText";
import BlurText from "./components/BlurText";
import CountUp from "./components/CountUp";
import ClickSpark from "./components/ClickSpark";
import Aurora from "./components/Aurora";

const CarScene = lazy(() => import("./components/CarScene"));

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function processGesture(
  beta: number,
  gamma: number,
  deadzone: number,
  speedScale: number,
  steerScale: number
) {
  let velocity = 0;
  let turn = 0;

  if (Math.abs(beta) > deadzone) {
    velocity = clamp(Math.round(beta * speedScale), -100, 100);
  }
  if (Math.abs(gamma) > deadzone) {
    turn = clamp(Math.round(gamma * steerScale), -100, 100);
  }

  let direction = "STOP";
  if (Math.abs(velocity) > 5 || Math.abs(turn) > 5) {
    if (Math.abs(velocity) > Math.abs(turn)) {
      direction = velocity > 0 ? "FORWARD" : "REVERSE";
    } else {
      direction = turn > 0 ? "RIGHT" : "LEFT";
    }
  }

  return { velocity, turn, direction };
}

// --- Status Dot ---
function StatusDot({ status }: { status: WSStatus }) {
  const colors: Record<WSStatus, string> = {
    disconnected: "bg-gray-500",
    connecting: "bg-yellow-400 animate-pulse",
    connected: "bg-emerald-400",
    error: "bg-red-500",
  };
  return (
    <motion.span
      className={`inline-block w-2.5 h-2.5 rounded-full ${colors[status]}`}
      animate={{ scale: status === "connected" ? [1, 1.3, 1] : 1 }}
      transition={{ repeat: status === "connected" ? Infinity : 0, duration: 2 }}
    />
  );
}

// --- Circular Gauge ---
function CircularGauge({
  value,
  max,
  label,
  colorFrom,
  colorTo,
}: {
  value: number;
  max: number;
  label: string;
  colorFrom: string;
  colorTo: string;
}) {
  const percent = Math.abs(value) / max;
  const circumference = 2 * Math.PI * 38;
  const dashOffset = circumference - percent * circumference;
  const gradientId = `gauge-${label}`;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative w-24 h-24">
        <svg viewBox="0 0 80 80" className="w-full h-full -rotate-90">
          <circle cx="40" cy="40" r="38" fill="none" stroke="#1a1a2e" strokeWidth="4" />
          <defs>
            <linearGradient id={gradientId}>
              <stop offset="0%" stopColor={colorFrom} />
              <stop offset="100%" stopColor={colorTo} />
            </linearGradient>
          </defs>
          <circle
            cx="40"
            cy="40"
            r="38"
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className="transition-all duration-150"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-bold font-mono tabular-nums">
            <CountUp to={Math.abs(value)} from={0} duration={0.3} startWhen={true} />
          </span>
        </div>
      </div>
      <span className="text-[10px] uppercase tracking-widest text-gray-400">{label}</span>
    </div>
  );
}

// --- Direction Arrow ---
function DirectionIndicator({ direction, eStop }: { direction: string; eStop: boolean }) {
  const arrows: Record<string, string> = {
    FORWARD: "↑",
    REVERSE: "↓",
    LEFT: "←",
    RIGHT: "→",
    STOP: "●",
  };

  return (
    <motion.div
      className={`w-16 h-16 rounded-full flex items-center justify-center text-3xl font-bold border-2 ${
        eStop
          ? "border-red-500 text-red-500 bg-red-500/10"
          : direction === "STOP"
          ? "border-gray-600 text-gray-500 bg-gray-800/50"
          : "border-cyan-400 text-cyan-400 bg-cyan-400/10"
      }`}
      animate={{
        scale: direction !== "STOP" && !eStop ? [1, 1.05, 1] : 1,
        rotate: direction === "LEFT" ? -5 : direction === "RIGHT" ? 5 : 0,
      }}
      transition={{ duration: 0.3 }}
    >
      {eStop ? "⊘" : arrows[direction] || "●"}
    </motion.div>
  );
}

// --- Main Page ---
export default function Home() {
  const { raw, calibrated, isActive, needsPermission, requestPermission, calibrate } = useIMU();
  const { status, connect, disconnect, send, lastError } = useWebSocket();

  const [espIp, setEspIp] = useState("192.168.4.1");
  const [speedScale, setSpeedScale] = useState(2.5);
  const [steerScale, setSteerScale] = useState(2.5);
  const [deadzone] = useState(5);
  const [eStop, setEStop] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sendRate] = useState(50);

  const lastSend = useRef(0);

  const gesture = processGesture(
    calibrated.beta,
    calibrated.gamma,
    deadzone,
    speedScale,
    steerScale
  );

  // Send commands at fixed rate
  useEffect(() => {
    if (status !== "connected") return;

    const interval = setInterval(() => {
      const now = Date.now();
      if (now - lastSend.current < sendRate) return;
      lastSend.current = now;

      if (eStop) {
        send({ cmd: "move", velocity: 0, turn: 0, eStop: true });
      } else {
        send({ cmd: "move", velocity: gesture.velocity, turn: gesture.turn });
      }
    }, sendRate);

    return () => clearInterval(interval);
  }, [status, gesture.velocity, gesture.turn, eStop, send, sendRate]);

  const handleConnect = useCallback(() => {
    if (status === "connected" || status === "connecting") {
      disconnect();
    } else {
      connect(`ws://${espIp}/ws`);
    }
  }, [status, espIp, connect, disconnect]);

  const handleEStop = useCallback(() => {
    setEStop((prev) => {
      const next = !prev;
      if (next) send({ cmd: "move", velocity: 0, turn: 0, eStop: true });
      return next;
    });
  }, [send]);

  const handlePermission = useCallback(async () => {
    await requestPermission();
  }, [requestPermission]);

  return (
    <ClickSpark sparkColor="#7b2ff7" sparkRadius={30} sparkCount={10} duration={500}>
      <main className="min-h-screen flex flex-col items-center relative overflow-hidden select-none">
        {/* Aurora Background */}
        <div className="fixed inset-0 z-0 opacity-40 pointer-events-none">
          <Aurora
            colorStops={eStop ? ["#ff0040", "#ff6600", "#ff0040"] : ["#00d4ff", "#7b2ff7", "#00d4ff"]}
            amplitude={1.2}
            blend={0.6}
            speed={eStop ? 2.0 : 0.8}
          />
        </div>

        {/* Content */}
        <div className="relative z-10 w-full max-w-md mx-auto flex flex-col items-center px-4 py-6 gap-4">
          {/* Header */}
          <motion.div
            className="text-center"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <GradientText
              colors={["#00d4ff", "#7b2ff7", "#ff6bcb", "#00d4ff"]}
              animationSpeed={4}
              className="text-4xl font-black tracking-tight"
            >
              G-MOTION
            </GradientText>
            <BlurText
              text="Gesture-Controlled RC"
              delay={80}
              className="text-xs text-gray-400 mt-1 justify-center"
              animateBy="letters"
            />
          </motion.div>

          {/* Connection Bar */}
          <motion.section
            className="w-full glass-card"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.2 }}
          >
            <div className="flex items-center gap-2 mb-2">
              <StatusDot status={status} />
              <span className="text-xs font-medium capitalize text-gray-300">{status}</span>
              {lastError && <span className="text-[10px] text-red-400 ml-auto">{lastError}</span>}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={espIp}
                onChange={(e) => setEspIp(e.target.value)}
                placeholder="ESP32 IP"
                className="input-field flex-1 text-xs"
              />
              <motion.button
                onClick={handleConnect}
                className={`btn text-xs ${status === "connected" ? "btn-danger" : "btn-glow"}`}
                whileTap={{ scale: 0.95 }}
              >
                {status === "connected" ? "Disconnect" : status === "connecting" ? "Cancel" : "Connect"}
              </motion.button>
            </div>
          </motion.section>

          {/* iOS Permission */}
          {needsPermission && (
            <motion.button
              onClick={handlePermission}
              className="btn btn-glow w-full text-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              whileTap={{ scale: 0.97 }}
            >
              Enable Motion Sensors (iOS)
            </motion.button>
          )}

          {/* 3D Car */}
          <motion.section
            className="w-full glass-card p-0 overflow-hidden"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            <div className="h-52 w-full relative">
              <Suspense
                fallback={
                  <div className="w-full h-full flex items-center justify-center text-gray-500 text-sm">
                    Loading 3D...
                  </div>
                }
              >
                <CarScene velocity={gesture.velocity} turn={gesture.turn} eStop={eStop} />
              </Suspense>
            </div>
          </motion.section>

          {/* Gauges + Direction */}
          <motion.section
            className="w-full glass-card"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
          >
            <div className="flex items-center justify-between">
              <CircularGauge value={gesture.velocity} max={100} label="Speed" colorFrom="#00d4ff" colorTo="#7b2ff7" />
              <DirectionIndicator direction={gesture.direction} eStop={eStop} />
              <CircularGauge value={gesture.turn} max={100} label="Steer" colorFrom="#ff6bcb" colorTo="#7b2ff7" />
            </div>
          </motion.section>

          {/* Action Buttons */}
          <div className="w-full grid grid-cols-3 gap-2">
            <motion.button onClick={calibrate} className="btn btn-glass text-xs" whileTap={{ scale: 0.93 }}>
              🎯 Calibrate
            </motion.button>

            <motion.button
              onClick={handleEStop}
              className={`btn font-bold text-xs ${eStop ? "btn-warning" : "btn-danger"}`}
              whileTap={{ scale: 0.93 }}
              animate={eStop ? { scale: [1, 1.02, 1] } : {}}
              transition={eStop ? { repeat: Infinity, duration: 0.8 } : {}}
            >
              {eStop ? "⚡ Resume" : "🛑 E-STOP"}
            </motion.button>

            <motion.button onClick={() => setShowSettings((p) => !p)} className="btn btn-glass text-xs" whileTap={{ scale: 0.93 }}>
              ⚙️ Tune
            </motion.button>
          </div>

          {/* Settings Panel */}
          <AnimatePresence>
            {showSettings && (
              <motion.section
                className="w-full glass-card overflow-hidden"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.3 }}
              >
                <div className="flex flex-col gap-3 py-2">
                  <label className="flex items-center justify-between text-xs">
                    <span className="text-gray-300">Speed Sensitivity</span>
                    <span className="font-mono text-cyan-400">{speedScale.toFixed(1)}</span>
                  </label>
                  <input
                    type="range" min="0.5" max="5" step="0.1" value={speedScale}
                    onChange={(e) => setSpeedScale(parseFloat(e.target.value))}
                    className="slider"
                  />
                  <label className="flex items-center justify-between text-xs">
                    <span className="text-gray-300">Steering Sensitivity</span>
                    <span className="font-mono text-purple-400">{steerScale.toFixed(1)}</span>
                  </label>
                  <input
                    type="range" min="0.5" max="5" step="0.1" value={steerScale}
                    onChange={(e) => setSteerScale(parseFloat(e.target.value))}
                    className="slider"
                  />
                </div>
              </motion.section>
            )}
          </AnimatePresence>

          {/* Debug Toggle */}
          <button
            onClick={() => setShowDebug((p) => !p)}
            className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
          >
            {showDebug ? "▲ Hide Debug" : "▼ Show Debug"}
          </button>

          {/* Debug Panel */}
          <AnimatePresence>
            {showDebug && (
              <motion.section
                className="w-full glass-card font-mono text-[10px] leading-relaxed overflow-hidden"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.3 }}
              >
                <div className="grid grid-cols-3 gap-4 py-1">
                  <div>
                    <p className="font-bold text-cyan-400 mb-1">Raw IMU</p>
                    <p>α {raw.alpha.toFixed(1)}</p>
                    <p>β {raw.beta.toFixed(1)}</p>
                    <p>γ {raw.gamma.toFixed(1)}</p>
                  </div>
                  <div>
                    <p className="font-bold text-purple-400 mb-1">Calibrated</p>
                    <p>β {calibrated.beta.toFixed(1)}</p>
                    <p>γ {calibrated.gamma.toFixed(1)}</p>
                  </div>
                  <div>
                    <p className="font-bold text-pink-400 mb-1">Output</p>
                    <p>vel {gesture.velocity}</p>
                    <p>trn {gesture.turn}</p>
                    <p>dir {gesture.direction}</p>
                  </div>
                </div>
                <div className="mt-2 pt-2 border-t border-white/5 flex gap-4 text-gray-500">
                  <span>Sensor: {isActive ? "✅" : "❌"}</span>
                  <span>WS: {status}</span>
                </div>
              </motion.section>
            )}
          </AnimatePresence>

          {/* Sensor warning */}
          {!isActive && !needsPermission && (
            <motion.p
              className="text-[10px] text-yellow-500/70 text-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              ⚠️ No sensor data. Use a mobile device with HTTPS.
            </motion.p>
          )}
        </div>
      </main>
    </ClickSpark>
  );
}
