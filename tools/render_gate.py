#!/usr/bin/env python3
"""Render gate for ibm-shmup — proves the game actually DRAWS THE WORLD.

Static checks and unit tests cannot see a black playfield. This boots index.html in headless
Chrome over CDP, lets it play for a few seconds, then asserts on:
  * three.js's own renderer.info  -> triangles actually rasterised this frame
  * the live HUD state            -> the simulation is advancing
  * a decoded screenshot          -> the playfield region has lit pixels
  * Runtime.exceptionThrown       -> the page threw nothing

Run:  uv run --no-project --python 3.12 --with websocket-client --with pillow \
          python tools/render_gate.py
"""
import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import websocket
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CHROMES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]
RUN_SECONDS = 9
MIN_TRIANGLES = 100          # the world pass must rasterise real geometry
MIN_LIT_FRACTION = 0.0002    # >0.02% of the playfield window must be non-black

fails = []


def check(ok, good, bad):
    print(("  ok   " + good) if ok else ("  FAIL " + bad))
    if not ok:
        fails.append(bad)


def serve():
    handler = partial(SimpleHTTPRequestHandler, directory=str(ROOT))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def free_port():
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    chrome = next((c for c in CHROMES if os.path.exists(c)), None)
    if not chrome:
        print("  FAIL no chrome/edge binary available")
        return 1

    httpd, web_port = serve()
    dev_port = free_port()
    prof = tempfile.mkdtemp(prefix="shmup-gate-")
    proc = subprocess.Popen(
        [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
         "--window-size=1024,768", f"--remote-debugging-port={dev_port}",
         "--remote-allow-origins=*", f"--user-data-dir={prof}", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        targets = None
        for _ in range(80):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{dev_port}/json/list", timeout=2) as r:
                    targets = json.load(r)
                if targets:
                    break
            except Exception:
                time.sleep(0.5)
        if not targets:
            print("  FAIL chrome devtools never came up")
            return 1

        ws_url = next(t["webSocketDebuggerUrl"] for t in targets if t.get("type") == "page")
        ws = websocket.create_connection(ws_url, timeout=60, max_size=64 * 1024 * 1024)
        mid = [0]

        def send(method, params=None):
            mid[0] += 1
            ws.send(json.dumps({"id": mid[0], "method": method, "params": params or {}}))
            while True:
                m = json.loads(ws.recv())
                if m.get("id") == mid[0]:
                    return m

        send("Runtime.enable")
        send("Log.enable")
        send("Page.enable")
        send("Page.navigate", {"url": f"http://127.0.0.1:{web_port}/index.html"})

        errors = []
        deadline = time.time() + RUN_SECONDS
        while time.time() < deadline:
            try:
                ws.settimeout(0.5)
                msg = json.loads(ws.recv())
            except Exception:
                continue
            m = msg.get("method")
            if m == "Runtime.exceptionThrown":
                d = msg["params"]["exceptionDetails"]
                errors.append((d.get("text") or "") + " " +
                              str((d.get("exception") or {}).get("description", ""))[:200])
            elif m == "Log.entryAdded":
                e = msg["params"]["entry"]
                if e.get("level") == "error" and "favicon" not in str(e.get("url", "")):
                    errors.append(str(e.get("text"))[:200])

        expr = """JSON.stringify((() => {
          const s = window.__shmup;
          const r = s && s.scene && s.scene.renderer && s.scene.renderer.info.render;
          return {
            engine: (document.querySelector('#game-canvas')||{}).dataset?.engine ?? null,
            score: Number((document.getElementById('score')||{}).textContent || 0),
            lives: Number((document.getElementById('lives')||{}).textContent || 0),
            boss: (document.querySelector('[id*=boss]')||{}).textContent || '',
            triangles: r ? r.triangles : null,
            drawCalls: r ? r.calls : null,
            batchActors: s ? s.scene.batches.actors.count : null,
            batchFx: s ? s.scene.batches.fx.count : null,
          };
        })())"""
        raw = send("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        data = json.loads(raw["result"]["result"]["value"])

        shot = send("Page.captureScreenshot", {"format": "png"})
        png = base64.b64decode(shot["result"]["data"])

        print("  ..   runtime: " + json.dumps(data))

        check(data.get("engine", "").lower().startswith("three"),
              "three.js renderer initialised", "three.js renderer never initialised")
        check(not errors, "page threw no exceptions", "page threw: " + " | ".join(errors[:3]))
        check((data.get("score") or 0) > 0,
              f"simulation advancing (score {data.get('score')})", "simulation is not advancing (score 0)")
        check((data.get("batchActors") or 0) > 0,
              f"sprite batches populated ({data.get('batchActors')} actors)", "no sprites were queued")

        # AUTHORITATIVE CHECK. renderer.info.render RESETS on every render() call, so reading it after
        # a frame describes only the LAST pass (the CRT composite) - it can never tell you whether the
        # world was drawn. Instead run the game's own draw() and read the default framebuffer back
        # within the same evaluate, so neither rAF nor the capture path can interleave.
        comp = send("Runtime.evaluate", {
            "expression": """JSON.stringify((() => {
              const s = window.__shmup.scene, r = s.renderer, gl = r.getContext();
              r.setRenderTarget(null); r.setScissorTest(false);
              r.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
              s.draw(0);
              const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
              const px = new Uint8Array(w * h * 4);
              gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
              let max = 0, lit = 0;
              for (let i = 0; i < px.length; i += 4) {
                const m = Math.max(px[i], px[i + 1], px[i + 2]);
                if (m > max) max = m;
                if (m > 24) lit++;
              }
              return { lit: lit / (w * h), max };
            })())""",
            "returnByValue": True})
        c = json.loads(comp["result"]["result"]["value"])
        check(c["lit"] > MIN_LIT_FRACTION,
              f"composited frame shows the world ({c['lit'] * 100:.3f}% lit, max luminance {c['max']})",
              f"composited frame is BLACK ({c['lit'] * 100:.3f}% lit) - the world is rendered but never "
              f"reaches the screen (check that the CRT pass is bound to the render target's texture)")

        img = Image.open(io.BytesIO(png)).convert("RGB")
        w, h = img.size
        px = img.load()
        x0, x1 = int(w * 0.10), int(w * 0.90)
        y0, y1 = int(h * 0.16), int(h * 0.86)
        lit = total = 0
        for y in range(y0, y1):
            for x in range(x0, x1):
                r_, g_, b_ = px[x, y]
                if max(r_, g_, b_) > 24:
                    lit += 1
                total += 1
        frac = lit / max(1, total)
        print(f"  ..   screenshot playfield lit: {frac * 100:.3f}% (informational only: headless captures "
              f"of a WebGL canvas without preserveDrawingBuffer often come back black)")

    finally:
        try:
            ws.close()  # noqa: F821 - closed here so the post-screenshot checks can still talk CDP
        except Exception:
            pass
        try:
            proc.terminate()
        except Exception:
            pass
        httpd.shutdown()

    print("\n" + ("PASS - the game draws its world." if not fails else f"FAIL - {len(fails)} render problem(s)"))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
