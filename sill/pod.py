#!/usr/bin/env python3
"""
The Sill — the little body on the windowsill.

Reads whatever senses are plugged in (BME280: temperature/humidity/pressure;
BH1750: light) and phones home to Petrichor every few minutes. Sensors are
optional and independent: if only one is attached, she reports what she has;
if a read fails, she skips that sense this round and tries again next time.

She never holds an API key or a database credential — only PETRICHOR_URL and
a device secret that lets her do exactly one thing: say what the room is like.

Config (environment, or /etc/sill.env via the systemd unit in the README):
  PETRICHOR_URL        e.g. https://your-app.vercel.app   (required)
  SILL_DEVICE_SECRET   must match the Vercel env var       (required)
  SILL_INTERVAL        seconds between readings (default 600)

Dependencies (see sill/README.md for the full setup):
  pip3 install adafruit-blinka adafruit-circuitpython-bme280 \
               adafruit-circuitpython-bh1750
"""

import json
import os
import sys
import time
import urllib.request

INTERVAL = int(os.environ.get("SILL_INTERVAL", "600"))
URL = os.environ.get("PETRICHOR_URL", "").rstrip("/")
SECRET = os.environ.get("SILL_DEVICE_SECRET", "")
HTTP_TIMEOUT = 30


def make_sensors():
    """Open I2C and whichever sensors answer. Missing hardware is fine —
    she wakes up with the senses she has."""
    bme = bh = None
    try:
        import board
        i2c = board.I2C()
    except Exception as e:
        print(f"[sill] no I2C bus ({e}) — is I2C enabled? (sudo raspi-config)",
              flush=True)
        return None, None
    try:
        from adafruit_bme280 import basic as adafruit_bme280
        try:
            bme = adafruit_bme280.Adafruit_BME280_I2C(i2c)          # addr 0x77
        except Exception:
            bme = adafruit_bme280.Adafruit_BME280_I2C(i2c, address=0x76)
        print("[sill] BME280 found (warmth, humidity, pressure)", flush=True)
    except Exception:
        print("[sill] no BME280 — going without warmth/humidity", flush=True)
    try:
        import adafruit_bh1750
        bh = adafruit_bh1750.BH1750(i2c)
        print("[sill] BH1750 found (light)", flush=True)
    except Exception:
        print("[sill] no BH1750 — going without light", flush=True)
    return bme, bh


def take_reading(bme, bh):
    reading = {}
    if bme is not None:
        try:
            reading["temp_c"] = round(float(bme.temperature), 2)
            reading["humidity"] = round(float(bme.relative_humidity), 1)
            reading["pressure_hpa"] = round(float(bme.pressure), 1)
        except Exception as e:
            print(f"[sill] BME280 read failed this round: {e}", flush=True)
    if bh is not None:
        try:
            reading["lux"] = round(float(bh.lux), 1)
        except Exception as e:
            print(f"[sill] BH1750 read failed this round: {e}", flush=True)
    return reading


def phone_home(reading):
    req = urllib.request.Request(
        f"{URL}/api/sill",
        data=json.dumps(reading).encode(),
        headers={"Content-Type": "application/json",
                 "X-Sill-Secret": SECRET},
        method="POST")
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return resp.status == 200


def main():
    if not URL or not SECRET:
        print("[sill] PETRICHOR_URL and SILL_DEVICE_SECRET are required",
              flush=True)
        sys.exit(1)
    bme, bh = make_sensors()
    if bme is None and bh is None:
        print("[sill] no senses found — check wiring, then restart me",
              flush=True)
        sys.exit(1)
    print(f"[sill] awake — reporting every {INTERVAL}s to {URL}", flush=True)
    while True:
        reading = take_reading(bme, bh)
        if reading:
            try:
                ok = phone_home(reading)
                print(f"[sill] {json.dumps(reading)} → "
                      f"{'delivered' if ok else 'not accepted'}", flush=True)
            except Exception as e:
                # Wi-Fi hiccups happen; she just tries again next round.
                print(f"[sill] couldn't reach home: {e}", flush=True)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
