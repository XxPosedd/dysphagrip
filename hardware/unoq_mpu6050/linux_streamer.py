#!/usr/bin/env python3
"""UNO Q Linux-side IMU forwarder (Qualcomm processor).

Reads NDJSON IMU lines from the MCU Bridge serial device (or a pty/file) and
serves them over TCP so the MacBook DysphaGrip backend can connect:

    Mac: POST /api/imu/connect  {"transport":"tcp","host":"<UNO-Q-IP>","tcp_port":9001}

Usage on the UNO Q (Linux)::

    python3 linux_streamer.py --serial /dev/ttyBridge0 --listen 0.0.0.0 --port 9001

If the Bridge device path differs on your image, pass the correct ``--serial``.
Do not assume a macOS ``/dev/tty.*`` path from Arduino App Lab automatically appears.
"""
from __future__ import annotations

import argparse
import select
import socket
import sys
import time


def open_serial(path: str, baud: int):
    try:
        import serial
    except ImportError as exc:
        raise SystemExit("pyserial required on the UNO Q Linux side: pip install pyserial") from exc
    return serial.Serial(path, baud, timeout=0.1)


def main() -> int:
    p = argparse.ArgumentParser(description="Forward UNO Q MPU-6050 NDJSON to TCP clients")
    p.add_argument("--serial", default="/dev/ttyBridge0", help="MCU Bridge / serial device path")
    p.add_argument("--baud", type=int, default=115200)
    p.add_argument("--listen", default="0.0.0.0")
    p.add_argument("--port", type=int, default=9001)
    p.add_argument("--demo", action="store_true", help="Emit synthetic IMU lines (board bring-up without MPU)")
    args = p.parse_args()

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((args.listen, args.port))
    server.listen(4)
    server.setblocking(False)
    print(f"Listening on {args.listen}:{args.port}", flush=True)

    clients: list[socket.socket] = []
    ser = None
    if not args.demo:
        try:
            ser = open_serial(args.serial, args.baud)
            print(f"Opened {args.serial} @ {args.baud}", flush=True)
        except Exception as exc:
            print(f"WARN: could not open {args.serial}: {exc}", file=sys.stderr)
            print("Continuing; clients will receive nothing until the device appears.", flush=True)

    buf = ""
    seq = 0
    try:
        while True:
            readable, _, _ = select.select([server] + clients + ([ser] if ser else []), [], [], 0.05)
            if server in readable:
                conn, addr = server.accept()
                conn.setblocking(False)
                clients.append(conn)
                print(f"Client connected: {addr}", flush=True)

            for c in list(clients):
                if c in readable:
                    try:
                        data = c.recv(256)
                    except OSError:
                        data = b""
                    if not data:
                        clients.remove(c)
                        try:
                            c.close()
                        except OSError:
                            pass

            line = None
            if args.demo:
                seq += 1
                t = time.time()
                line = (
                    f'{{"type":"imu","seq":{seq},"t_ms":{int(t*1000)},'
                    f'"ax":{0.01*__import__("math").sin(t):.5f},"ay":0.0,"az":1.0,'
                    f'"gx":0.0,"gy":0.0,"gz":0.0}}\n'
                )
                time.sleep(0.01)
            elif ser is not None and ser in readable:
                chunk = ser.read(512)
                if chunk:
                    buf += chunk.decode("utf-8", errors="ignore")
                    if "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        line = line.strip() + "\n"

            if line:
                dead = []
                payload = line.encode("utf-8")
                for c in clients:
                    try:
                        c.sendall(payload)
                    except OSError:
                        dead.append(c)
                for c in dead:
                    clients.remove(c)
                    try:
                        c.close()
                    except OSError:
                        pass
    except KeyboardInterrupt:
        print("\nStopping.", flush=True)
    finally:
        if ser:
            ser.close()
        for c in clients:
            c.close()
        server.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
