#!/usr/bin/env python3
"""Relay NDJSON lines from a serial device to TCP clients.

Use this on the Arduino UNO Q's LINUX side if the microcontroller's serial output is not visible to the
MacBook over USB. It reads the MCU-to-Linux serial device and serves the same lines on a TCP port; the
MacBook then connects with:  python -m dysphagrip_audio serve ...  and starts motion with  tcp://<board-ip>:7070

    python3 serial_to_tcp.py --device /dev/ttyHS1 --port 7070

The device path is an assumption to verify on the board (`ls /dev/tty*`). Requires: pip install pyserial
Lines are forwarded unchanged; the MacBook timestamps them on arrival (see services/audio motion sync).
"""
import argparse
import socket
import threading
import time

import serial  # pyserial


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--device", default="/dev/ttyHS1")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=7070)
    args = ap.parse_args()

    clients: list[socket.socket] = []
    lock = threading.Lock()

    def accept_loop(server: socket.socket) -> None:
        while True:
            conn, addr = server.accept()
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            print(f"client connected: {addr[0]}:{addr[1]}", flush=True)
            with lock:
                clients.append(conn)

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((args.host, args.port))
    server.listen(4)
    threading.Thread(target=accept_loop, args=(server,), daemon=True).start()
    print(f"relaying {args.device} @ {args.baud} -> tcp://{args.host}:{args.port}", flush=True)

    while True:
        try:
            with serial.Serial(args.device, args.baud, timeout=1) as ser:
                while True:
                    line = ser.readline()
                    if not line:
                        continue
                    with lock:
                        for c in list(clients):
                            try:
                                c.sendall(line)
                            except OSError:
                                clients.remove(c)
                                c.close()
        except serial.SerialException as e:
            print(f"serial error: {e}; retrying in 2 s", flush=True)
            time.sleep(2)


if __name__ == "__main__":
    main()
