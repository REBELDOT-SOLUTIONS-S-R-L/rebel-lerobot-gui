#!/usr/bin/env python3
"""
JSON-RPC sidecar for the LeRobot GUI.

Speaks newline-delimited JSON on stdin/stdout. stdout carries ONLY protocol
frames; every log line goes to stderr. Run inside the venv that has lerobot
installed:

    <venv>/bin/python lerobot_gui_bridge.py

Frames
------
request       {"id": 1, "method": "ports.list", "params": {}}
response      {"id": 1, "ok": true, "value": ...}
error         {"id": 1, "ok": false, "error": "...", "detail": "<traceback>"}
notification  {"type": "positions", "positions": {...}}   (no id)

Why this exists: the lerobot CLI has no command that reports live motor
positions or writes a single motor's ID/limits, which the Configure panel needs.
Everything else (calibrate, teleoperate, record, replay, rollout) is driven
through the real console scripts by the Electron side.
"""

from __future__ import annotations

import base64
import contextlib
import json
import sys
import threading
import time
import traceback
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Protocol plumbing
# ---------------------------------------------------------------------------

_write_lock = threading.Lock()


def log(msg: str) -> None:
    print(f"[bridge] {msg}", file=sys.stderr, flush=True)


def _emit(obj: dict[str, Any]) -> None:
    line = json.dumps(obj, default=_json_default)
    with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _json_default(o: Any) -> Any:
    # Paths, numpy scalars, enums, dataclasses we did not convert explicitly.
    for attr in ("tolist", "item"):
        if hasattr(o, attr):
            try:
                return getattr(o, attr)()
            except Exception:  # noqa: BLE001 - best effort only
                pass
    return str(o)


def notify(kind: str, **payload: Any) -> None:
    _emit({"type": kind, **payload})


# ---------------------------------------------------------------------------
# Motor tables (mirrors src/shared/devices.ts)
# ---------------------------------------------------------------------------

SO_MOTORS: list[tuple[str, int]] = [
    ("shoulder_pan", 1),
    ("shoulder_lift", 2),
    ("elbow_flex", 3),
    ("wrist_flex", 4),
    ("wrist_roll", 5),
    ("gripper", 6),
]

# Order of travel for one joint's turn, as (motor, target) pairs.
#
# Most joints just sweep their own range. shoulder_lift is interleaved with
# elbow_flex: dropping the shoulder to its minimum with the forearm extended puts
# the gripper into the table, so the elbow is swept while the shoulder is down,
# the shoulder then travels to its maximum, and both return to their midpoints
# together.
SWEEP_PLANS: dict[str, list[tuple[str, str]]] = {
    "shoulder_lift": [
        ("shoulder_lift", "min"),
        ("elbow_flex", "max"),
        ("elbow_flex", "min"),
        ("shoulder_lift", "max"),
        ("shoulder_lift", "mid"),
        ("elbow_flex", "mid"),
    ],
}


# Joints already exercised inside another joint's plan, so they get no turn of
# their own: elbow_flex is swept to both limits and back during shoulder_lift's
# paired sequence, and repeating it afterwards would move it for no new coverage.
PAIRED_AWAY: set[str] = {
    motor for owner, plan in SWEEP_PLANS.items() for motor, _target in plan if motor != owner
}


# Auto-calibration travel, in order, as (motor, action) pairs.
#
# `find_min` / `find_max` drive the joint until it stops and record where it
# stopped; `go_*` moves to something already measured. A joint whose last step is
# a search is left standing at that limit, which is deliberate: the gripper
# finishes closed and the elbow finishes folded, so nothing sticks out while the
# rest of the arm travels.
#
# Distinct from the motion test's SWEEP_PLANS on purpose. shoulder_lift is split
# in two - down and *staying* down while the elbow is measured, only then up - so
# the forearm is never extended with the shoulder dropping. The gripper goes
# first, while the arm is still in the pose the user set by hand.
AUTOCAL_STEPS: list[tuple[str, str]] = [
    ("gripper", "find_min"),
    ("gripper", "find_max"),
    ("gripper", "go_min"),
    ("wrist_flex", "find_min"),
    ("wrist_flex", "find_max"),
    ("wrist_flex", "go_mid"),
    ("shoulder_lift", "find_min"),
    ("elbow_flex", "find_max"),
    ("elbow_flex", "find_min"),
    ("shoulder_lift", "find_max"),
    ("shoulder_lift", "go_mid"),
    ("shoulder_pan", "find_min"),
    ("shoulder_pan", "find_max"),
    ("shoulder_pan", "go_mid"),
]

# Joints auto-calibration measures. wrist_roll is not among them: it turns
# continuously, so its stored limits are left exactly as they are - neither
# widened nor rewritten - and it is never commanded to move.
AUTOCAL_JOINTS: list[str] = sorted({motor for motor, _ in AUTOCAL_STEPS})

# Where the arm is left afterwards, as (motor, target). wrist_roll is absent
# deliberately: nothing was measured for it, so there is nowhere meaningful to go.
AUTOCAL_HOME: list[tuple[str, str]] = [
    ("shoulder_pan", "mid"),
    ("shoulder_lift", "min"),
    ("elbow_flex", "max"),
    ("wrist_flex", "mid"),
    ("gripper", "min"),
]


def sweep_plan(name: str) -> list[tuple[str, str]]:
    return SWEEP_PLANS.get(name, [(name, "min"), (name, "max"), (name, "mid")])


def sweep_turns() -> list[str]:
    """Joints that take a turn of their own, in LeRobot's dict order."""
    return [name for name, _default in SO_MOTORS if name not in PAIRED_AWAY]


# Auto-calibration stall detection: a limit is reached when the commanded position
# is not being met *and* the reading has stopped moving toward it for this long.
# The joint is held against its stop for two of these - once under the gentle
# lead, once under SEEK_LEAD_MAX - so a limit takes ~1s of contact to confirm.
STALL_S = 0.3
# How far behind its goal a joint has to sit to count as "not reached". Above the
# servo's own deadband, below SEEK_LEAD, so a real stall always trips it.
STALL_TOLERANCE = 25
# Ticks of travel that count as progress rather than encoder noise.
STALL_PROGRESS = 2
# Ticks the goal leads the joint by while it is travelling freely. The position
# error is what the motor pushes with, so a small lead keeps a hard stop gentle.
SEEK_LEAD = 40
# ...but a small lead is also a small torque, and the shoulder carrying the whole
# arm needs more than that just to break stiction. So when a joint stops making
# progress the lead escalates to here and it gets another STALL_S to prove it can
# move; only then is a stall believed. Without this a heavy joint reports a limit
# wherever it happened to be standing, having never moved at all.
SEEK_LEAD_MAX = 140
# Slack on top of the time a full-span sweep needs. A search that outlasts even
# this has not found anything: a slipping gear, or a joint free to keep turning.
SEEK_SLACK_S = 15.0

STS3215_MAX_TICK = 4095
DEFAULT_BAUDRATE = 1_000_000
MAX_MOTOR_ID = 253
MOTOR_MODEL = "sts3215"


# ---------------------------------------------------------------------------
# Bus session
# ---------------------------------------------------------------------------


class _Cancelled(Exception):
    """Raised inside a driving sequence when the stop flag is set."""


class BusSession:
    """
    Owns one FeetechMotorsBus plus the polling thread that streams positions.

    The bus object is deliberately cheap to rebuild: changing a motor ID
    invalidates `_id_to_model_dict` / `_id_to_name_dict` and the `ids`/`models`
    cached properties, which are computed once in MotorsBus.__init__
    (motors_bus.py:369-371, 398-402). Every mutation therefore goes through
    `rebuild()`.
    """

    def __init__(self) -> None:
        self.bus = None
        self.port: str | None = None
        self.motor_ids: dict[str, int] = {}
        self._stream_stop = threading.Event()
        self._stream_thread: threading.Thread | None = None
        self._motion_stop = threading.Event()
        self._motion_thread: threading.Thread | None = None
        self._lock = threading.RLock()

    # -- lifecycle ---------------------------------------------------------

    def _make_bus(self, port: str, motor_ids: dict[str, int]):
        from lerobot.motors import Motor, MotorNormMode
        from lerobot.motors.feetech import FeetechMotorsBus

        motors = {}
        for name, _default in SO_MOTORS:
            norm = MotorNormMode.RANGE_0_100 if name == "gripper" else MotorNormMode.DEGREES
            motors[name] = Motor(motor_ids.get(name, _default), "sts3215", norm)
        return FeetechMotorsBus(port=port, motors=motors)

    def open(self, port: str, motor_ids: dict[str, int] | None = None) -> dict[str, Any]:
        with self._lock:
            self.close()
            ids = {name: default for name, default in SO_MOTORS}
            if motor_ids:
                ids.update({k: int(v) for k, v in motor_ids.items() if k in ids})
            bus = self._make_bus(port, ids)
            # handshake=False skips _assert_motors_exist/_assert_same_firmware so a
            # partially wired or mis-ID'd arm still opens and can be inspected.
            bus._connect(handshake=False)
            bus.set_timeout()
            self.bus = bus
            self.port = port
            self.motor_ids = ids
            return {"port": port, "baudrate": bus.get_baudrate(), "motorIds": ids}

    def rebuild(self) -> None:
        """Re-create the bus object after an EEPROM identity change."""
        with self._lock:
            if self.bus is None or self.port is None:
                return
            port, ids = self.port, dict(self.motor_ids)
            try:
                self.bus.disconnect(disable_torque=False)
            except Exception as exc:  # noqa: BLE001
                log(f"rebuild: disconnect failed, continuing: {exc}")
            bus = self._make_bus(port, ids)
            bus._connect(handshake=False)
            bus.set_timeout()
            self.bus = bus

    def close(self) -> None:
        self._motion_stop.set()
        with self._lock:
            self.stop_stream()
            if self.bus is not None:
                try:
                    self.bus.disconnect()
                except Exception as exc:  # noqa: BLE001
                    log(f"close: disconnect failed: {exc}")
            self.bus = None
            self.port = None

    def require(self):
        if self.bus is None:
            raise RuntimeError("No motor bus is open. Select a port and connect first.")
        return self.bus

    # -- reads -------------------------------------------------------------

    def read_state(self) -> dict[str, Any]:
        bus = self.require()
        with self._lock:
            motors: list[dict[str, Any]] = []
            for name, _default in SO_MOTORS:
                entry: dict[str, Any] = {
                    "name": name,
                    "id": self.motor_ids.get(name, _default),
                    "position": None,
                    "rangeMin": None,
                    "rangeMax": None,
                    "homingOffset": None,
                    "driveMode": 0,
                    "online": False,
                    "error": None,
                }
                try:
                    entry["position"] = int(bus.read("Present_Position", name, normalize=False))
                    entry["rangeMin"] = int(bus.read("Min_Position_Limit", name, normalize=False))
                    entry["rangeMax"] = int(bus.read("Max_Position_Limit", name, normalize=False))
                    entry["homingOffset"] = int(bus.read("Homing_Offset", name, normalize=False))
                    entry["online"] = True
                except Exception as exc:  # noqa: BLE001 - one dead motor must not hide the rest
                    entry["error"] = f"{type(exc).__name__}: {exc}"
                motors.append(entry)
            return {
                "port": self.port,
                "baudrate": bus.get_baudrate(),
                "motors": motors,
            }

    def read_positions(self) -> dict[str, int]:
        bus = self.require()
        with self._lock:
            try:
                raw = bus.sync_read("Present_Position", normalize=False)
                return {k: int(v) for k, v in raw.items()}
            except Exception:  # noqa: BLE001 - protocol 1 has no sync_read; fall back
                out: dict[str, int] = {}
                for name, _ in SO_MOTORS:
                    try:
                        out[name] = int(bus.read("Present_Position", name, normalize=False))
                    except Exception:  # noqa: BLE001
                        continue
                return out

    # -- streaming ---------------------------------------------------------

    def start_stream(self, hz: float = 10.0) -> dict[str, Any]:
        self.require()
        self.stop_stream()
        self._stream_stop.clear()
        interval = 1.0 / max(1.0, min(hz, 50.0))

        def loop() -> None:
            consecutive_errors = 0
            while not self._stream_stop.is_set():
                t0 = time.perf_counter()
                try:
                    notify("positions", positions=self.read_positions())
                    consecutive_errors = 0
                except Exception as exc:  # noqa: BLE001
                    consecutive_errors += 1
                    if consecutive_errors in (1, 10) or consecutive_errors % 50 == 0:
                        notify("streamError", message=f"{type(exc).__name__}: {exc}")
                    if consecutive_errors > 200:
                        # `fatal` tells the UI this thread is gone, so it can stop
                        # showing a live badge over positions that will not update.
                        notify(
                            "streamError",
                            message="Too many read failures; stopping stream.",
                            fatal=True,
                        )
                        return
                self._stream_stop.wait(max(0.0, interval - (time.perf_counter() - t0)))

        self._stream_thread = threading.Thread(target=loop, name="pos-stream", daemon=True)
        self._stream_thread.start()
        return {"hz": 1.0 / interval}

    def stop_stream(self) -> dict[str, Any]:
        self._stream_stop.set()
        t = self._stream_thread
        if t is not None and t.is_alive():
            t.join(timeout=2.0)
        self._stream_thread = None
        return {"stopped": True}

    # -- range-of-motion sweep --------------------------------------------

    def record_rom(self, duration_s: float = 30.0) -> dict[str, Any]:
        """
        Reimplementation of MotorsBus.record_ranges_of_motion (motors_bus.py:802),
        which cannot be reused directly because it prints its own live table and
        blocks on Enter. Streams running min/max instead.
        """
        bus = self.require()
        mins: dict[str, int] = {}
        maxes: dict[str, int] = {}
        start = time.perf_counter()
        self._rom_stop = threading.Event()
        while not self._rom_stop.is_set() and (time.perf_counter() - start) < duration_s:
            positions = self.read_positions()
            for name, value in positions.items():
                mins[name] = min(mins.get(name, value), value)
                maxes[name] = max(maxes.get(name, value), value)
            notify("rom", mins=dict(mins), maxes=dict(maxes), positions=positions)
            time.sleep(0.02)
        # wrist_roll is the full-turn motor: LeRobot always writes the whole span
        # for it (so_follower.py:131-139), so mirror that here.
        mins["wrist_roll"] = 0
        maxes["wrist_roll"] = STS3215_MAX_TICK
        _ = bus
        return {"mins": mins, "maxes": maxes}

    def stop_rom(self) -> dict[str, Any]:
        stop = getattr(self, "_rom_stop", None)
        if stop is not None:
            stop.set()
        return {"stopped": True}

    # -- motion test -------------------------------------------------------

    def _glide(self, bus, start: dict[str, int], target: dict[str, int], speed: float, hz: float) -> bool:
        """
        Interpolate every named joint from `start` to `target` in software.

        The motors would happily jump to a new Goal_Position at their own top
        speed; stepping the goal instead is what makes the move slow and
        inspectable, and it gives the stop flag a chance to land between frames.
        The lock is taken per frame, not for the whole move, so the position
        stream keeps feeding the UI while the arm travels.

        Returns False if the test was stopped part-way.
        """
        span = max((abs(target[n] - start[n]) for n in target), default=0)
        if span == 0:
            return True
        duration = span / max(speed, 1.0)
        steps = max(1, int(duration * hz))
        for i in range(1, steps + 1):
            if self._motion_stop.is_set():
                return False
            f = i / steps
            frame = {n: int(round(start[n] + (target[n] - start[n]) * f)) for n in target}
            with self._lock:
                try:
                    bus.sync_write("Goal_Position", frame, normalize=False)
                except Exception:  # noqa: BLE001 - protocol 1 has no sync_write
                    for name, value in frame.items():
                        bus.write("Goal_Position", name, value, normalize=False)
            time.sleep(duration / steps)
        return True

    def _sleep_phase(self, seconds: float) -> bool:
        """Interruptible wait. False if the test was stopped."""
        return not self._motion_stop.wait(seconds)

    def start_motion_test(
        self,
        countdown_s: float = 5.0,
        settle_s: float = 2.0,
        speed: float = 350.0,
        hz: float = 50.0,
    ) -> dict[str, Any]:
        """
        Exercise every joint through its recorded range, then park at home.

        Home is read here, when the request arrives - i.e. when the user pressed
        the button - not after the countdown, so an arm nudged during those five
        seconds still returns to where it started.

        The countdown runs inside this thread rather than in the UI so that a
        cancel and a stop are the same operation on the same flag, and so nothing
        can move if the renderer stalls mid-countdown.
        """
        bus = self.require()
        if self._motion_thread is not None and self._motion_thread.is_alive():
            raise RuntimeError("A motion test is already running.")

        limits: dict[str, tuple[int, int]] = {}
        home: dict[str, int] = {}
        with self._lock:
            for name, _default in SO_MOTORS:
                try:
                    home[name] = int(bus.read("Present_Position", name, normalize=False))
                    lo = int(bus.read("Min_Position_Limit", name, normalize=False))
                    hi = int(bus.read("Max_Position_Limit", name, normalize=False))
                except Exception as exc:  # noqa: BLE001
                    raise RuntimeError(
                        f"Could not read {name}: {type(exc).__name__}: {exc}. "
                        "Every joint has to answer before the arm is driven."
                    ) from exc
                if hi <= lo:
                    raise RuntimeError(f"{name} has no usable travel limits ({lo}..{hi}).")
                # A joint still reporting the whole encoder span has no recorded
                # range of motion, so min/max are the hard stops rather than the
                # ends of its travel. wrist_roll is the exception: LeRobot stores
                # the full span for it because it turns continuously.
                if name != "wrist_roll" and hi - lo >= STS3215_MAX_TICK:
                    raise RuntimeError(
                        f"{name} still reports its full 0..{STS3215_MAX_TICK} span, so it has no "
                        "recorded range of motion. Calibrate this arm before running a motion test."
                    )
                limits[name] = (lo, hi)

        self._motion_stop = threading.Event()

        def sequence() -> None:
            try:
                deadline = time.perf_counter() + countdown_s
                while True:
                    remaining = deadline - time.perf_counter()
                    if remaining <= 0:
                        break
                    notify("motionTest", phase="countdown", remaining=round(remaining, 1))
                    if not self._sleep_phase(min(0.2, remaining)):
                        notify("motionTest", phase="cancelled", moved=False)
                        return

                with self._lock:
                    bus.enable_torque()

                mids = {name: (lo + hi) // 2 for name, (lo, hi) in limits.items()}
                notify("motionTest", phase="centering")
                if not self._glide(bus, home, mids, speed, hz):
                    notify("motionTest", phase="cancelled", moved=True)
                    return
                notify("motionTest", phase="settle", seconds=settle_s)
                if not self._sleep_phase(settle_s):
                    notify("motionTest", phase="cancelled", moved=True)
                    return

                turns = sweep_turns()
                total = len(turns)
                for index, name in enumerate(turns, start=1):
                    for motor, target in sweep_plan(name):
                        lo, hi = limits[motor]
                        value = {"min": lo, "max": hi, "mid": mids[motor]}[target]
                        notify(
                            "motionTest",
                            phase="joint",
                            # `group` is whose turn it is; `motor` is what actually
                            # moves, and the two differ inside a paired plan.
                            group=name,
                            motor=motor,
                            target=target,
                            position=value,
                            index=index,
                            total=total,
                        )
                        # Only this joint moves; the rest hold their goal. The read
                        # takes the lock like every other transfer — the position
                        # stream is on the same port, and two threads talking at
                        # once corrupts both packets.
                        with self._lock:
                            current = {
                                motor: int(bus.read("Present_Position", motor, normalize=False))
                            }
                        if not self._glide(bus, current, {motor: value}, speed, hz):
                            notify("motionTest", phase="cancelled", moved=True)
                            return

                notify("motionTest", phase="settle", seconds=settle_s)
                if not self._sleep_phase(settle_s):
                    notify("motionTest", phase="cancelled", moved=True)
                    return

                notify("motionTest", phase="homing")
                with self._lock:
                    current = {
                        name: int(bus.read("Present_Position", name, normalize=False))
                        for name, _ in SO_MOTORS
                    }
                if not self._glide(bus, current, home, speed, hz):
                    notify("motionTest", phase="cancelled", moved=True)
                    return
                notify("motionTest", phase="done", home=home)
            except Exception as exc:  # noqa: BLE001
                notify("motionTest", phase="error", message=f"{type(exc).__name__}: {exc}")

        self._motion_thread = threading.Thread(target=sequence, name="motion-test", daemon=True)
        self._motion_thread.start()
        return {
            "started": True,
            "home": home,
            "limits": {name: {"min": lo, "max": hi} for name, (lo, hi) in limits.items()},
            "countdownS": countdown_s,
        }

    def stop_motion_test(self) -> dict[str, Any]:
        """
        Cancel the countdown, or halt a move in progress.

        Torque is deliberately left on: an arm that is part-way through a sweep
        holds where it stopped instead of dropping.
        """
        self._motion_stop.set()
        thread = self._motion_thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)
        self._motion_thread = None
        return {"stopped": True}

    # -- auto-calibration --------------------------------------------------

    def _seek_limit(
        self, bus, motor: str, direction: int, speed: float, hz: float
    ) -> tuple[int, int] | None:
        """
        Drive one joint outward until it stops making progress; return the tick it
        settled at, or None if it never stalled.

        The goal is advanced on a clock (so the travel is slow and even) but never
        allowed to lead the joint by more than SEEK_LEAD. While the joint is free
        the lag stays inside STALL_TOLERANCE, so the stall rule cannot fire; once
        it is against a stop the lag pins at the lead and the reading stops
        changing, which is exactly the specified condition.

        A joint that has stopped moving gets the lead raised to SEEK_LEAD_MAX and
        another STALL_S before that is believed: not moving under a gentle push is
        not the same as being against a stop.

        Returns (tick, travel) - travel being how far it actually moved, so a
        limit found without the joint budging can be reported as suspect.
        """
        with self._lock:
            position = int(bus.read("Present_Position", motor, normalize=False))
        commanded = position
        started_at = position
        furthest = position
        lead = SEEK_LEAD
        last_progress = time.perf_counter()
        # Worst case is the whole encoder span at the commanded speed.
        deadline = last_progress + SEEK_SLACK_S + STS3215_MAX_TICK / max(speed, 1.0)
        step = max(1, int(round(speed / hz)))
        interval = 1.0 / hz

        while not self._motion_stop.is_set():
            commanded += direction * step
            if (commanded - position) * direction > lead:
                commanded = position + direction * lead
            commanded = max(0, min(STS3215_MAX_TICK, commanded))

            with self._lock:
                bus.write("Goal_Position", motor, commanded, normalize=False)
            time.sleep(interval)
            with self._lock:
                position = int(bus.read("Present_Position", motor, normalize=False))

            if (position - furthest) * direction >= STALL_PROGRESS:
                furthest = position
                last_progress = time.perf_counter()
                # The lead only ever rises within a seek. Dropping it back once the
                # joint moves would just stall it again a frame later, stuttering
                # the whole way; a joint that needed the harder push keeps it, and
                # one that never needed it still meets its stop at SEEK_LEAD.

            now = time.perf_counter()
            reached = abs(commanded - position) <= STALL_TOLERANCE
            if not reached and (now - last_progress) > STALL_S:
                if lead < SEEK_LEAD_MAX:
                    # It has stopped, but only under a gentle push. Ask harder
                    # before calling this a limit, and give that push its own
                    # STALL_S to take effect.
                    lead = SEEK_LEAD_MAX
                    last_progress = now
                else:
                    # Stop pushing, and report where the motor says it actually is.
                    with self._lock:
                        bus.write("Goal_Position", motor, position, normalize=False)
                    return position, abs(position - started_at)
            if reached and commanded in (0, STS3215_MAX_TICK):
                # Ran all the way to the encoder edge without stalling.
                return position, abs(position - started_at)
            if now > deadline:
                return None
        return None

    def _write_limits(self, bus, limits: dict[str, tuple[int, int]], enable_after: bool) -> None:
        """
        Push travel limits to the motors' EEPROM.

        Min/Max_Position_Limit are EEPROM registers, so the Lock has to come off,
        which means torque comes off with it - hence the brief release and the
        immediate re-enable.
        """
        with self._lock:
            with bus.torque_disabled():
                for name, (lo, hi) in limits.items():
                    bus.write("Min_Position_Limit", name, lo, normalize=False)
                    bus.write("Max_Position_Limit", name, hi, normalize=False)
            if enable_after:
                bus.enable_torque()

    @staticmethod
    def _target_tick(motor: str, target: str, limits_of) -> int:
        """Resolve "min"/"max"/"mid" against a joint's measured (or stored) range."""
        lo, hi = limits_of(motor)
        if target == "min":
            return lo
        if target == "max":
            return hi
        return (lo + hi) // 2

    def start_auto_calibration(
        self, settle_s: float = 1.0, speed: float = 800.0, hz: float = 50.0
    ) -> dict[str, Any]:
        """
        Discover every joint's travel by driving it into its own stops.

        The user has already posed the arm mid-travel by hand, so that pose is the
        starting point. The first thing this does is widen the motors' stored
        Min/Max_Position_Limit to the full encoder span: a joint cannot be driven
        past a limit it already holds, so an earlier calibration would otherwise
        cap the search at its own numbers. The originals are put back if the run
        is cancelled or fails, so a half-finished attempt never leaves the arm
        with no limits at all.

        Travel order is AUTOCAL_STEPS, and only the joints named there are
        measured: shoulder_pan and wrist_roll keep the limits they already hold,
        and are neither widened nor rewritten. The arm is left in AUTOCAL_HOME
        once the measured limits are stored.
        """
        bus = self.require()
        if self._motion_thread is not None and self._motion_thread.is_alive():
            raise RuntimeError("A motion test or auto-calibration is already running.")

        stored: dict[str, tuple[int, int]] = {}
        start_pose: dict[str, int] = {}
        with self._lock:
            for name, _default in SO_MOTORS:
                try:
                    start_pose[name] = int(bus.read("Present_Position", name, normalize=False))
                    stored[name] = (
                        int(bus.read("Min_Position_Limit", name, normalize=False)),
                        int(bus.read("Max_Position_Limit", name, normalize=False)),
                    )
                except Exception as exc:  # noqa: BLE001
                    raise RuntimeError(
                        f"Could not read {name}: {type(exc).__name__}: {exc}. "
                        "Every joint has to answer before the arm is driven."
                    ) from exc

        self._motion_stop = threading.Event()

        def sequence() -> None:
            found: dict[str, dict[str, int]] = {}
            # Once the measured limits are in EEPROM the calibration stands, so a
            # stop during the move home must not roll it back.
            committed = False
            searches = sum(1 for _, action in AUTOCAL_STEPS if action.startswith("find_"))
            done_searches = 0

            def limits_of(motor: str) -> tuple[int, int]:
                """Measured range if there is one, otherwise what the motor holds."""
                if motor in found and {"min", "max"} <= found[motor].keys():
                    return found[motor]["min"], found[motor]["max"]
                return stored[motor]

            try:
                # A joint cannot be driven past a limit it already holds, so the
                # ones being measured are opened up first. The others are left
                # alone, which keeps any calibration they already have.
                notify("autoCalibration", phase="preparing", motors=AUTOCAL_JOINTS)
                self._write_limits(
                    bus, {n: (0, STS3215_MAX_TICK) for n in AUTOCAL_JOINTS}, enable_after=True
                )

                for motor, action in AUTOCAL_STEPS:
                    if self._motion_stop.is_set():
                        raise _Cancelled()

                    if action.startswith("find_"):
                        target = action.removeprefix("find_")
                        done_searches += 1
                        notify(
                            "autoCalibration",
                            phase="seeking",
                            motor=motor,
                            target=target,
                            index=done_searches,
                            total=searches,
                        )
                        result = self._seek_limit(
                            bus, motor, -1 if target == "min" else 1, speed, hz
                        )
                        if self._motion_stop.is_set():
                            raise _Cancelled()
                        if result is None:
                            raise RuntimeError(
                                f"{motor} never stopped moving toward its {target}. "
                                "Nothing was calibrated - check for a slipping gear or a "
                                "joint that is free to spin."
                            )
                        tick, travel = result
                        found.setdefault(motor, {})[target] = tick
                        notify(
                            "autoCalibration",
                            phase="found",
                            motor=motor,
                            target=target,
                            position=tick,
                            travel=travel,
                            index=done_searches,
                            total=searches,
                        )
                        if not self._sleep_phase(0.3):
                            raise _Cancelled()
                    else:
                        target = action.removeprefix("go_")
                        value = self._target_tick(motor, target, limits_of)
                        notify(
                            "autoCalibration",
                            phase="moving",
                            motor=motor,
                            target=target,
                            position=value,
                            index=done_searches,
                            total=searches,
                        )
                        with self._lock:
                            current = {
                                motor: int(bus.read("Present_Position", motor, normalize=False))
                            }
                        if not self._glide(bus, current, {motor: value}, speed, hz):
                            raise _Cancelled()

                if not self._sleep_phase(settle_s):
                    raise _Cancelled()

                ranges = {n: (v["min"], v["max"]) for n, v in found.items()}
                notify("autoCalibration", phase="writing", motors=sorted(ranges))
                self._write_limits(bus, ranges, enable_after=True)
                committed = True

                for motor, target in AUTOCAL_HOME:
                    if self._motion_stop.is_set():
                        break
                    value = self._target_tick(motor, target, limits_of)
                    notify(
                        "autoCalibration",
                        phase="parking",
                        motor=motor,
                        target=target,
                        position=value,
                    )
                    with self._lock:
                        current = {
                            motor: int(bus.read("Present_Position", motor, normalize=False))
                        }
                    if not self._glide(bus, current, {motor: value}, speed, hz):
                        break

                notify(
                    "autoCalibration",
                    phase="done",
                    ranges={n: {"min": lo, "max": hi} for n, (lo, hi) in ranges.items()},
                    startPose=start_pose,
                    parked=not self._motion_stop.is_set(),
                )
            except _Cancelled:
                if not committed:
                    self._write_limits(bus, {n: stored[n] for n in AUTOCAL_JOINTS}, enable_after=True)
                notify("autoCalibration", phase="cancelled", restored=not committed)
            except Exception as exc:  # noqa: BLE001
                if not committed:
                    try:
                        self._write_limits(
                            bus, {n: stored[n] for n in AUTOCAL_JOINTS}, enable_after=True
                        )
                    except Exception as restore_exc:  # noqa: BLE001
                        log(f"auto-calibration: restoring limits failed: {restore_exc}")
                notify(
                    "autoCalibration",
                    phase="error",
                    message=f"{type(exc).__name__}: {exc}",
                    restored=not committed,
                )

        self._motion_thread = threading.Thread(target=sequence, name="auto-calibration", daemon=True)
        self._motion_thread.start()
        return {
            "started": True,
            "startPose": start_pose,
            "measures": AUTOCAL_JOINTS,
            "previous": {n: {"min": lo, "max": hi} for n, (lo, hi) in stored.items()},
        }

    # -- writes ------------------------------------------------------------

    @contextlib.contextmanager
    def _bus_for(self, port: str | None):
        """
        A bus to write with, whether or not the arm is connected.

        An open session is reused as-is (a second handle on the same serial port
        would just fail to open); otherwise a throwaway bus is opened on `port`
        with handshake=False and closed again, which is what lets an ID be
        written without connecting the arm first.
        """
        if self.bus is not None:
            if port and port != self.port:
                raise RuntimeError(
                    f"The bus is open on {self.port}. Disconnect before writing to {port}."
                )
            yield self.bus
            return

        if not port:
            raise RuntimeError(
                "No bus is open. Pass the serial port to write a motor ID without connecting."
            )
        bus = self._make_bus(port, dict(SO_MOTORS))
        bus._connect(handshake=False)
        bus.set_timeout()
        try:
            yield bus
        finally:
            try:
                bus.disconnect(disable_torque=False)
            except Exception as exc:  # noqa: BLE001
                log(f"write_id: closing temporary bus failed: {exc}")

    def present_ids(self, port: str | None = None) -> dict[str, Any]:
        """
        IDs answering on the bus right now, without needing a connection.

        `broadcast_ping` only reports an ID once a follow-up unicast read of its
        model number also succeeded (feetech.py:450-461), so this is a real
        presence check rather than a broadcast echo.
        """
        with self._lock, self._bus_for(port) as bus:
            found = bus.broadcast_ping(num_retry=1, raise_on_error=False) or {}
            return {
                "port": port or self.port,
                "baudrate": bus.get_baudrate(),
                "ids": sorted(found),
                "models": {str(i): m for i, m in sorted(found.items())},
            }

    def write_id(
        self,
        to_id: int,
        from_id: int | None = None,
        motor: str | None = None,
        port: str | None = None,
        force: bool = False,
    ) -> dict[str, Any]:
        """
        Re-ID one motor in place, addressed by the ID it answers to today.

        `bus.setup_motor()` - the wizard behind `lerobot-setup-motors` - scans for
        a lone motor and refuses to work on a populated bus. Here the write is
        aimed at a single ID with `_write`, and torque + the Lock register that
        gate EEPROM writes are cleared on that ID alone via `_disable_torque`
        (feetech.py:296-300), so the rest of the arm can stay wired up.

        `force` waives the two refusals that are about intent: rewriting the ID a
        motor already has, and moving a motor onto an ID that something else on the
        bus answers to. The second one leaves two motors sharing an ID until the
        other is moved as well, which makes the bus unusable in between - hence the
        opt-in.

        It deliberately does not waive the source check. Every write here is a
        unicast that waits for a status packet, so writing to an ID nothing answers
        to cannot succeed - forcing it only trades a clear refusal for the SDK's
        "[TxRxResult] There is no status packet!".
        """
        to_id = int(to_id)
        if not 0 <= to_id <= MAX_MOTOR_ID:
            raise ValueError(f"Motor ID must be between 0 and {MAX_MOTOR_ID}.")

        known = dict(SO_MOTORS)
        if motor is not None and motor not in known:
            raise ValueError(f"Unknown motor '{motor}'.")
        if from_id is None:
            if motor is None:
                raise ValueError("Pass the motor's current ID (fromId) or its name.")
            from_id = self.motor_ids.get(motor, known[motor])
        from_id = int(from_id)

        from lerobot.motors.motors_bus import get_address

        warnings: list[str] = []
        with self._lock:
            with self._bus_for(port) as bus:
                before = sorted(bus.broadcast_ping(num_retry=1, raise_on_error=False) or {})

                # A unicast ping is the last word on presence: the broadcast scan
                # above can be a frame behind on a bus that was just re-plugged.
                if from_id not in before or bus.ping(from_id, num_retry=2) is None:
                    seen = f"IDs answering: {before}" if before else "nothing answered at all"
                    raise ValueError(
                        f"No motor answered at ID {from_id} ({seen}). "
                        "Every write waits for a reply from that ID, so it cannot be forced. "
                        "Check power and the cable, or write to one of the IDs listed above."
                    )

                if to_id == from_id:
                    if not force:
                        raise ValueError(
                            f"That motor already has ID {to_id}. Force the write to send it anyway."
                        )
                    warnings.append(f"ID {to_id} was rewritten onto the motor that already had it.")
                elif to_id in before:
                    owner = next((n for n, i in self.motor_ids.items() if i == to_id), None)
                    msg = f"ID {to_id} is already answered by another motor on this bus"
                    if owner:
                        msg += f" ('{owner}')"
                    if not force:
                        raise ValueError(f"{msg}. Move that one first, or force the write.")
                    warnings.append(f"{msg} - two motors now share it until one is moved.")

                addr, length = get_address(bus.model_ctrl_table, MOTOR_MODEL, "ID")
                try:
                    # Torque and Lock gate the EEPROM; both are cleared on this ID
                    # alone so the rest of the arm keeps holding position.
                    bus._disable_torque(from_id, MOTOR_MODEL, num_retry=2)
                    bus._write(addr, length, from_id, to_id, num_retry=2)
                except ConnectionError as exc:
                    raise ConnectionError(
                        f"Motor {from_id} stopped replying part-way through the write ({exc}). "
                        f"IDs answering before the write: {before}. Re-check the bus before retrying - "
                        "the ID may or may not have been taken."
                    ) from exc

                after = sorted(bus.broadcast_ping(num_retry=1, raise_on_error=False) or {})

            # Follow the profile: whichever motor held the old ID now holds the new
            # one, and the cached bus object has to be rebuilt around that.
            renamed = [name for name, mid in self.motor_ids.items() if mid == from_id]
            for name in renamed:
                self.motor_ids[name] = to_id
            if renamed and self.bus is not None:
                self.rebuild()

        verified = to_id in after
        if not verified:
            warnings.append(
                f"ID {to_id} did not answer a ping after the write. Re-scan the bus to check."
            )
        return {
            "motor": motor or (renamed[0] if renamed else None),
            "fromId": from_id,
            "toId": to_id,
            "forced": bool(force),
            "verified": verified,
            "presentBefore": before,
            "presentAfter": after,
            "warnings": warnings,
            "motorIds": dict(self.motor_ids),
        }

    def set_limits(self, motor: str, range_min: int, range_max: int) -> dict[str, Any]:
        bus = self.require()
        range_min, range_max = int(range_min), int(range_max)
        if not 0 <= range_min < range_max <= STS3215_MAX_TICK:
            raise ValueError(f"Limits must satisfy 0 <= min < max <= {STS3215_MAX_TICK}.")
        with self._lock:
            with bus.torque_disabled():
                bus.write("Min_Position_Limit", motor, range_min, normalize=False)
                bus.write("Max_Position_Limit", motor, range_max, normalize=False)
        return {"motor": motor, "rangeMin": range_min, "rangeMax": range_max}

    def set_homing_offset(self, motor: str, offset: int) -> dict[str, Any]:
        bus = self.require()
        with self._lock:
            with bus.torque_disabled():
                bus.write("Homing_Offset", motor, int(offset), normalize=False)
        return {"motor": motor, "homingOffset": int(offset)}

    def set_torque(self, enabled: bool, motor: str | None = None) -> dict[str, Any]:
        bus = self.require()
        motors = [motor] if motor else None
        with self._lock:
            if enabled:
                bus.enable_torque(motors)
            else:
                bus.disable_torque(motors)
        return {"enabled": bool(enabled)}

    def move_to(self, motor: str, position: int) -> dict[str, Any]:
        bus = self.require()
        with self._lock:
            bus.write("Goal_Position", motor, int(position), normalize=False)
        return {"motor": motor, "goal": int(position)}

    def apply_calibration(self, calibration: dict[str, dict[str, int]]) -> dict[str, Any]:
        """Push an edited calibration dict to the motors' EEPROM."""
        bus = self.require()
        from lerobot.motors import MotorCalibration

        payload = {
            name: MotorCalibration(
                id=int(entry["id"]),
                drive_mode=int(entry.get("drive_mode", 0)),
                homing_offset=int(entry["homing_offset"]),
                range_min=int(entry["range_min"]),
                range_max=int(entry["range_max"]),
            )
            for name, entry in calibration.items()
        }
        with self._lock:
            with bus.torque_disabled():
                bus.write_calibration(payload)
        return {"applied": sorted(payload)}

    def read_calibration(self) -> dict[str, Any]:
        bus = self.require()
        with self._lock:
            cal = bus.read_calibration()
        return {
            name: {
                "id": entry.id,
                "drive_mode": entry.drive_mode,
                "homing_offset": entry.homing_offset,
                "range_min": entry.range_min,
                "range_max": entry.range_max,
            }
            for name, entry in cal.items()
        }


SESSION = BusSession()


# ---------------------------------------------------------------------------
# Methods
# ---------------------------------------------------------------------------


def m_ping(**_: Any) -> dict[str, Any]:
    return {"pong": True, "pid": __import__("os").getpid()}


def m_env_info(**_: Any) -> dict[str, Any]:
    info: dict[str, Any] = {
        "python": ".".join(str(v) for v in sys.version_info[:3]),
        "executable": sys.executable,
        "platform": sys.platform,
        "lerobotVersion": None,
        "modules": {},
    }
    try:
        import lerobot

        info["lerobotVersion"] = getattr(lerobot, "__version__", "unknown")
    except Exception as exc:  # noqa: BLE001
        info["lerobotError"] = f"{type(exc).__name__}: {exc}"

    for mod in ("serial", "cv2", "rerun", "scservo_sdk", "torch", "numpy"):
        try:
            __import__(mod)
            info["modules"][mod] = True
        except Exception:  # noqa: BLE001
            info["modules"][mod] = False
    return info


def m_ports_list(**_: Any) -> list[dict[str, Any]]:
    """
    Uses pyserial's comports() on every platform.

    `lerobot-find-port` globs /dev/tty* on macOS/Linux, which returns ~200
    pseudo-terminals — useless for a dropdown. comports() gives real USB
    metadata we can rank with.
    """
    from serial.tools import list_ports

    out: list[dict[str, Any]] = []
    for p in list_ports.comports():
        desc = (p.description or "").lower()
        hwid = (p.hwid or "").lower()
        device = p.device or ""
        likely = bool(p.vid) or any(
            token in device.lower() for token in ("usbmodem", "usbserial", "ttyacm", "ttyusb", "com")
        )
        # Feetech/Waveshare boards commonly show up as CH340, CP210x or CDC ACM.
        if any(token in desc or token in hwid for token in ("ch340", "cp210", "ft232", "acm", "serial")):
            likely = True
        out.append(
            {
                "device": device,
                "description": p.description or "",
                "hwid": p.hwid or "",
                "manufacturer": p.manufacturer,
                "serialNumber": p.serial_number,
                "vid": p.vid,
                "pid": p.pid,
                "likelyMotorBus": likely,
            }
        )
    out.sort(key=lambda e: (not e["likelyMotorBus"], e["device"]))
    return out


def m_cameras_list(includeRealsense: bool = True, **_: Any) -> dict[str, Any]:
    """
    Calls the camera classes' own find_cameras() directly.

    `lerobot-find-cameras` is not a pure lister: main() unconditionally connects
    to every camera and writes PNGs for record_time_s seconds, and it has no
    JSON mode.
    """
    cameras: list[dict[str, Any]] = []
    errors: dict[str, str] = {}

    try:
        from lerobot.cameras.opencv import OpenCVCamera

        for cam in OpenCVCamera.find_cameras():
            cameras.append(_normalize_camera(cam))
    except Exception as exc:  # noqa: BLE001
        errors["opencv"] = f"{type(exc).__name__}: {exc}"

    if includeRealsense:
        try:
            from lerobot.cameras.realsense import RealSenseCamera

            for cam in RealSenseCamera.find_cameras():
                cameras.append(_normalize_camera(cam))
        except Exception as exc:  # noqa: BLE001
            # RealSense is frequently absent or unstable (notably on macOS);
            # never let it hide the OpenCV results.
            errors["realsense"] = f"{type(exc).__name__}: {exc}"

    return {"cameras": cameras, "errors": errors}


def _normalize_camera(cam: dict[str, Any]) -> dict[str, Any]:
    profile = cam.get("default_stream_profile") or {}
    return {
        "name": str(cam.get("name", "camera")),
        "type": str(cam.get("type", "OpenCV")),
        "id": str(cam.get("id", "")),
        "backendApi": str(cam.get("backend_api")) if cam.get("backend_api") is not None else None,
        "defaultStreamProfile": {
            "width": _as_int(profile.get("width")),
            "height": _as_int(profile.get("height")),
            "fps": _as_int(profile.get("fps")),
            "format": profile.get("format") if isinstance(profile.get("format"), (str, int, float)) else None,
        },
    }


def _as_int(value: Any) -> int | None:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def m_cameras_snapshot(
    type: str = "opencv",  # noqa: A002 - matches the lerobot camera `type` key
    identifier: str = "0",
    width: int = 640,
    height: int = 480,
    fps: int = 30,
    **_: Any,
) -> dict[str, Any]:
    """Grab one frame so the user can confirm they picked the right camera."""
    import numpy as np

    if type == "intelrealsense":
        from lerobot.cameras.realsense import RealSenseCamera, RealSenseCameraConfig

        cfg = RealSenseCameraConfig(
            serial_number_or_name=identifier, width=width, height=height, fps=fps
        )
        cam = RealSenseCamera(cfg)
    else:
        from lerobot.cameras.opencv import OpenCVCamera, OpenCVCameraConfig

        index: Any = identifier
        try:
            index = int(identifier)
        except (TypeError, ValueError):
            pass
        cfg = OpenCVCameraConfig(index_or_path=index, width=width, height=height, fps=fps)
        cam = OpenCVCamera(cfg)

    cam.connect()
    try:
        frame = cam.read()
    finally:
        cam.disconnect()

    arr = np.asarray(frame)
    # lerobot hands back RGB by default; cv2.imencode wants BGR.
    import cv2

    if arr.ndim == 3 and arr.shape[2] == 3:
        arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    ok, buf = cv2.imencode(".jpg", arr, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
    if not ok:
        raise RuntimeError("Failed to JPEG-encode the captured frame.")
    return {
        "width": int(arr.shape[1]),
        "height": int(arr.shape[0]),
        "jpegBase64": base64.b64encode(buf.tobytes()).decode("ascii"),
    }


def m_bus_scan(port: str, **_: Any) -> dict[str, Any]:
    """FeetechMotorsBus.scan_port -> {baudrate: [ids]} (motors_bus.py:564)."""
    from lerobot.motors.feetech import FeetechMotorsBus

    # scan_port uses tqdm, which writes to stderr — safe for our stdout protocol.
    found = FeetechMotorsBus.scan_port(port)
    return {"found": {str(baud): sorted(int(i) for i in ids) for baud, ids in found.items()}}


def m_bus_open(port: str, motorIds: dict[str, int] | None = None, **_: Any) -> dict[str, Any]:
    return SESSION.open(port, motorIds)


def m_bus_close(**_: Any) -> dict[str, Any]:
    SESSION.close()
    return {"closed": True}


def m_bus_state(**_: Any) -> dict[str, Any]:
    return SESSION.read_state()


def m_bus_positions(**_: Any) -> dict[str, Any]:
    return {"positions": SESSION.read_positions()}


def m_bus_stream_start(hz: float = 10.0, **_: Any) -> dict[str, Any]:
    return SESSION.start_stream(hz)


def m_bus_stream_stop(**_: Any) -> dict[str, Any]:
    return SESSION.stop_stream()


def m_bus_record_rom(durationS: float = 30.0, **_: Any) -> dict[str, Any]:
    return SESSION.record_rom(durationS)


def m_bus_stop_rom(**_: Any) -> dict[str, Any]:
    return SESSION.stop_rom()


def m_bus_configure(**_: Any) -> dict[str, Any]:
    """
    Feetech configure_motors(): Return_Delay_Time=0, acceleration caps, and for
    sts3215 clears Phase bit 4 so positions stay in [0, 4095]
    (feetech.py:209). Exposed as a "fix my motors" action.
    """
    bus = SESSION.require()
    bus.configure_motors()
    return {"configured": True}


def m_bus_present_ids(port: str | None = None, **_: Any) -> dict[str, Any]:
    return SESSION.present_ids(port)


def m_motion_start(
    countdownS: float = 5.0, settleS: float = 2.0, speed: float = 350.0, **_: Any
) -> dict[str, Any]:
    return SESSION.start_motion_test(countdown_s=countdownS, settle_s=settleS, speed=speed)


def m_motion_stop(**_: Any) -> dict[str, Any]:
    return SESSION.stop_motion_test()


def m_autocal_start(settleS: float = 1.0, speed: float = 800.0, **_: Any) -> dict[str, Any]:
    return SESSION.start_auto_calibration(settle_s=settleS, speed=speed)


def m_motor_write_id(
    toId: int,
    fromId: int | None = None,
    motor: str | None = None,
    port: str | None = None,
    force: bool = False,
    **_: Any,
) -> dict[str, Any]:
    return SESSION.write_id(to_id=toId, from_id=fromId, motor=motor, port=port, force=force)


def m_motor_set_limits(motor: str, rangeMin: int, rangeMax: int, **_: Any) -> dict[str, Any]:
    return SESSION.set_limits(motor, rangeMin, rangeMax)


def m_motor_set_homing(motor: str, offset: int, **_: Any) -> dict[str, Any]:
    return SESSION.set_homing_offset(motor, offset)


def m_motor_torque(enabled: bool, motor: str | None = None, **_: Any) -> dict[str, Any]:
    return SESSION.set_torque(enabled, motor)


def m_motor_move(motor: str, position: int, **_: Any) -> dict[str, Any]:
    return SESSION.move_to(motor, position)


def m_calibration_read(**_: Any) -> dict[str, Any]:
    return SESSION.read_calibration()


def m_calibration_apply(calibration: dict[str, dict[str, int]], **_: Any) -> dict[str, Any]:
    return SESSION.apply_calibration(calibration)


def m_setup_motor(motor: str, **_: Any) -> dict[str, Any]:
    """
    Single-motor variant of the `lerobot-setup-motors` wizard: writes the target
    ID + baudrate to whichever lone motor is connected. Lets the GUI drive the
    gripper -> shoulder_pan sequence itself instead of parsing prompts.
    """
    bus = SESSION.require()
    bus.setup_motor(motor)
    return {"motor": motor, "id": SESSION.motor_ids.get(motor), "baudrate": DEFAULT_BAUDRATE}


METHODS: dict[str, Callable[..., Any]] = {
    "ping": m_ping,
    "env.info": m_env_info,
    "ports.list": m_ports_list,
    "cameras.list": m_cameras_list,
    "cameras.snapshot": m_cameras_snapshot,
    "bus.scan": m_bus_scan,
    "bus.open": m_bus_open,
    "bus.close": m_bus_close,
    "bus.state": m_bus_state,
    "bus.positions": m_bus_positions,
    "bus.streamStart": m_bus_stream_start,
    "bus.streamStop": m_bus_stream_stop,
    "bus.recordRom": m_bus_record_rom,
    "bus.stopRom": m_bus_stop_rom,
    "bus.configure": m_bus_configure,
    "bus.presentIds": m_bus_present_ids,
    "motion.start": m_motion_start,
    "motion.stop": m_motion_stop,
    "autocal.start": m_autocal_start,
    # Both sequences drive the arm, so they share one stop flag and one thread.
    "autocal.stop": m_motion_stop,
    "motor.writeId": m_motor_write_id,
    "motor.setLimits": m_motor_set_limits,
    "motor.setHoming": m_motor_set_homing,
    "motor.torque": m_motor_torque,
    "motor.move": m_motor_move,
    "motor.setup": m_setup_motor,
    "calibration.read": m_calibration_read,
    "calibration.apply": m_calibration_apply,
}


# ---------------------------------------------------------------------------
# Dispatch loop
# ---------------------------------------------------------------------------


def handle(frame: dict[str, Any]) -> None:
    req_id = frame.get("id")
    method = frame.get("method")
    params = frame.get("params") or {}

    fn = METHODS.get(str(method))
    if fn is None:
        _emit({"id": req_id, "ok": False, "error": f"Unknown method '{method}'."})
        return
    try:
        value = fn(**params)
        _emit({"id": req_id, "ok": True, "value": value})
    except Exception as exc:  # noqa: BLE001 - every failure must reach the UI
        # LeRobot's own errors are unusually good (e.g. _assert_motors_exist
        # names the missing IDs), so surface the message verbatim.
        _emit(
            {
                "id": req_id,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "detail": traceback.format_exc(limit=8),
            }
        )


def main() -> int:
    log(f"started on {sys.executable}")
    notify("ready", python=".".join(str(v) for v in sys.version_info[:3]))
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                frame = json.loads(line)
            except json.JSONDecodeError as exc:
                _emit({"id": None, "ok": False, "error": f"Malformed frame: {exc}"})
                continue
            # Requests run on worker threads so a slow read cannot block the
            # loop (and bus.recordRom can be cancelled by a later frame).
            threading.Thread(target=handle, args=(frame,), daemon=True).start()
    except KeyboardInterrupt:
        pass
    finally:
        SESSION.close()
        log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
