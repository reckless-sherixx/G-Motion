import { NextRequest, NextResponse } from "next/server";

const REQUEST_TIMEOUT_MS = 1500;

function normalizeEspGyroUrl(hostInput: string): URL | null {
  const raw = hostInput.trim();
  if (!raw) return null;

  const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;

  try {
    const url = new URL(candidate);
    url.pathname = "/gyro";
    url.search = "";
    return url;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const host = params.get("host") ?? "";
  const x = params.get("x");
  const y = params.get("y");
  const z = params.get("z");

  if (!x || !y || !z) {
    return NextResponse.json(
      { ok: false, error: "Missing required query params x, y, z" },
      { status: 400 }
    );
  }

  const target = normalizeEspGyroUrl(host);
  if (!target) {
    return NextResponse.json(
      { ok: false, error: "Invalid ESP32 host. Use IP[:port] or http(s)://host" },
      { status: 400 }
    );
  }

  target.searchParams.set("x", x);
  target.searchParams.set("y", y);
  target.searchParams.set("z", z);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(target.toString(), {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    const responseText = await response.text();

    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: `ESP32 returned ${response.status}`,
          target: target.toString(),
          body: responseText,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      target: target.toString(),
      body: responseText,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown network error";
    return NextResponse.json(
      {
        ok: false,
        error: `Unable to reach ESP32: ${message}`,
        target: target.toString(),
      },
      { status: 502 }
    );
  } finally {
    clearTimeout(timeout);
  }
}
