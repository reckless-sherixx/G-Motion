"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type WSStatus = "disconnected" | "connecting" | "connected" | "error";

interface UseWebSocketReturn {
  status: WSStatus;
  connect: (url: string) => void;
  disconnect: () => void;
  send: (data: Record<string, unknown>) => void;
  lastError: string | null;
}

const RECONNECT_DELAY = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;

export function useWebSocket(): UseWebSocketReturn {
  const [status, setStatus] = useState<WSStatus>("disconnected");
  const [lastError, setLastError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const urlRef = useRef<string>("");
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalClose = useRef(false);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
  }, []);

  const connectWs = useCallback(
    (url: string) => {
      if (wsRef.current) {
        intentionalClose.current = true;
        wsRef.current.close();
      }
      clearReconnectTimer();

      urlRef.current = url;
      intentionalClose.current = false;
      reconnectAttempts.current = 0;
      setStatus("connecting");
      setLastError(null);

      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          setStatus("connected");
          setLastError(null);
          reconnectAttempts.current = 0;
        };

        ws.onclose = () => {
          setStatus("disconnected");
          wsRef.current = null;

          if (
            !intentionalClose.current &&
            reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS
          ) {
            reconnectAttempts.current++;
            reconnectTimer.current = setTimeout(() => {
              connectWs(urlRef.current);
            }, RECONNECT_DELAY);
          }
        };

        ws.onerror = () => {
          setLastError("WebSocket connection error");
          setStatus("error");
        };
      } catch (err) {
        setLastError(err instanceof Error ? err.message : "Connection failed");
        setStatus("error");
      }
    },
    [clearReconnectTimer]
  );

  const disconnect = useCallback(() => {
    intentionalClose.current = true;
    clearReconnectTimer();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus("disconnected");
  }, [clearReconnectTimer]);

  const send = useCallback((data: Record<string, unknown>) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  useEffect(() => {
    return () => {
      intentionalClose.current = true;
      clearReconnectTimer();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [clearReconnectTimer]);

  return { status, connect: connectWs, disconnect, send, lastError };
}
