"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface IMUData {
  alpha: number; 
  beta: number;  
  gamma: number; 
}

export interface CalibrationOffsets {
  beta: number;
  gamma: number;
}

interface UseIMUReturn {
  raw: IMUData;
  calibrated: IMUData;
  offsets: CalibrationOffsets;
  isActive: boolean;
  needsPermission: boolean;
  requestPermission: () => Promise<boolean>;
  calibrate: () => void;
}

export function useIMU(): UseIMUReturn {
  const [raw, setRaw] = useState<IMUData>({ alpha: 0, beta: 0, gamma: 0 });
  const [offsets, setOffsets] = useState<CalibrationOffsets>({ beta: 0, gamma: 0 });
  const [isActive, setIsActive] = useState(false);
  const [needsPermission, setNeedsPermission] = useState(false);

  const rawRef = useRef<IMUData>({ alpha: 0, beta: 0, gamma: 0 });

  useEffect(() => {
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission === "function"
    ) {
      setNeedsPermission(true);
    }
  }, []);

  const startListening = useCallback(() => {
    const handleOrientation = (e: DeviceOrientationEvent) => {
      const data: IMUData = {
        alpha: e.alpha ?? 0,
        beta: e.beta ?? 0,
        gamma: e.gamma ?? 0,
      };
      rawRef.current = data;
      setRaw(data);
      if (!isActive) setIsActive(true);
    };

    window.addEventListener("deviceorientation", handleOrientation);
    return () => window.removeEventListener("deviceorientation", handleOrientation);
  }, [isActive]);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    const DOE = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    if (typeof DOE.requestPermission === "function") {
      try {
        const result = await DOE.requestPermission();
        if (result === "granted") {
          setNeedsPermission(false);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }
    return true;
  }, []);


  useEffect(() => {
    if (!needsPermission) {
      const cleanup = startListening();
      return cleanup;
    }
  }, [needsPermission, startListening]);

  const calibrate = useCallback(() => {
    setOffsets({
      beta: rawRef.current.beta,
      gamma: rawRef.current.gamma,
    });
  }, []);

  const calibrated: IMUData = {
    alpha: raw.alpha,
    beta: raw.beta - offsets.beta,
    gamma: raw.gamma - offsets.gamma,
  };

  return {
    raw,
    calibrated,
    offsets,
    isActive,
    needsPermission,
    requestPermission,
    calibrate,
  };
}
