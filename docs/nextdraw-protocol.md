# NextDraw / EBB protocol notes

Research notes behind the plotter driver in `plotter/ebb.js`, `plotter/serial.js`
and `plotter/mock.js`. Compiled 2026-10-05 from Bantam's own code, not from memory
and not from issue #2.

## Sources

- **[NC]** The official NextDraw Python API zip:
  https://software-download.bantamtools.com/nd/api/nextdraw_api.zip (linked from
  https://bantam.tools/nd_py). Inside it is `nextdrawcore-1.7.4`. The files used are
  `nextdraw_conf.py` (v1.4.0), `nextdraw_options/models.py`, `pen_handling.py`,
  `serial_utils.py`, `motion.py`, `dripfeed.py` and `homing.py`.
- **[PI]** https://github.com/evil-mad/plotink (v1.14.3), specifically
  `plotink/ebb3_serial.py` and `plotink/ebb3_motion.py`. These are the
  EBB-firmware-3 classes that NextDraw uses.
- **[EBB]** The EBB command reference for firmware v3.0+:
  https://evil-mad.github.io/EggBot/ebb.html
- **[WEB]** https://www.evilmadscientist.com/2024/bantam-tools-nextdraw/ and
  https://drawingbots.com/machines/nextdraw/ (the model lineup)

## What issue #2 got wrong

| Issue #2 says | Actually |
|---|---|
| `SP,1` = pen down | **`SP,1` = pen UP**, `SP,0` = pen down. [EBB "SP"] [PI `ebb3_motion.py` `pen_raise` sends `SP,1,…`] |
| NextDraw 4411 | **There is no 4411.** The NextDraw models are 8511, 1117 and 2234. [NC `models.py`] [WEB] |
| Motor A = (dx+dy), B = (dx−dy) | Correct. `SM,dur,steps1,steps2` takes `steps1 = s·(dx+dy)` and `steps2 = s·(dx−dy)`. [NC `motion.py`] |

## Pen (brushless pen-lift)

- `SP,Value[,Duration[,PortB_Pin]]`:
  - `0` lowers the pen to `SC,5` (pen down) and `1` raises it to `SC,4` (pen up). Both are queued in the motion FIFO.
  - `Duration` (1–65535 ms) holds back the *next* queued command, which gives the servo time to finish. It does not change how fast the servo moves.
- **Brushless lift is on Port B pin 2.** Every pen command must include `,2`, for example `SP,1,45,2`. [NC `models.py:80-94`]
- Brushless pulse range runs from 5400 (0 %) to 12600 (100 %), in units of 1/12 MHz. That is 0.45 ms to 1.05 ms.
  - Pen position in percent converts to a servo value as `5400 + 72·pct`.
  - NextDraw's defaults are up 60 % (`SC,4,9720`) and down 40 % (`SC,5,8280`).
- Servo speed:
  - `SC,11` sets the raise rate and `SC,12` the lower rate.
  - The rate is `round(range·0.03/70 · pct)`, where `range` is the brushless pulse span from above, 12600 − 5400 = 7200.
  - At the defaults of 75 % raise and 50 % lower, that gives `SC,11,231` and `SC,12,154`.
- `SC,8,1` selects one PWM channel, which gives a 3 ms frame. It is needed for brushless.
- Standard servo (not used by default):
  - It uses pin 1 with range 9855 to 27831, a 200 ms sweep and `SC,8,8`.
  - It also needs `SR,60000` (servo power timeout).
- Pen travel time, as computed by NextDraw [NC `pen_handling.py:137-160`]:
  ```
  d = |up% − down%|
  t = ((move_slope·d + move_min)^4 + (sweep_time·d/rate%)^4)^(1/4)
  brushless: move_slope 1.28, move_min 20, sweep_time 70
  standard:  move_slope 2.69, move_min 45, sweep_time 200
  ```
  - With the defaults, raise takes 45 ms and lower takes 47 ms.
  - NextDraw's extra `pen_delay_up` and `pen_delay_down` both default to 0.
  - This app uses the same formula. The result goes into the `SP` Duration and also into the time estimate.

## Motion

- Resolution:
  - `EM,1,1` sets 16× microstepping. NextDraw's `step_scale` is then 2 × 1016 = 2032 steps per inch, which is **80 steps per mm**, in the formula `motor1 = 80·(dx+dy)` (dx and dy in mm).
  - The 80 steps/mm is derived from NextDraw's constants; no source states it directly. The 50 mm test square verifies it.
- Kinematics:
  - `steps1 = s·(dx+dy)`, `steps2 = s·(dx−dy)`.
  - Home is (0,0), and the whole drawing area is +x and +y from home.
  - x runs along the long axis.
- Travel per model:

  | Model | travel x (in) | travel y (in) | travel x (mm) | travel y (mm) |
  |---|---|---|---|---|
  | 8511 | 11.81 | 8.58 | 299.97 | 217.93 |
  | 1117 | 16.93 | 11.69 | 430.02 | 296.93 |
  | 2234 | 34.02 | 23.39 | 864.11 | 594.11 |

- `SM,Duration,Steps1,Steps2`:
  - Duration is 1–4294967295 ms. The rate on each axis must stay at or below **25,000 steps/s**, or the command is rejected with an error.
  - `SM` with 0 and 0 steps is a pause, capped at 100 s.
  - The practical minimum is about 2 ms per command on firmware 3.x.
- NextDraw itself draws with `TD`/`T3`, which give jerk-limited S-curves. This app uses plain `SM` time slices with a trapezoidal speed profile instead.
  - `SM` is documented on every firmware and is easy to verify: the round-trip test decodes it back to XY.
  - The cost is slightly jerkier acceleration. If plots look shaky, lower the acceleration.
- `HM,StepFrequency[,p1,p2]`:
  - An absolute move to step position (0,0), or to (p1,p2). It runs in a straight line on firmware 3.0+.
  - It waits until earlier motion has finished.
  - This app uses it for *Walk home* and after *Cancel*.
- `EM,a,b`:
  - `EM,1,1` enables both motors at 16×. `EM,0,0` turns the motors off.
  - **EM resets the step counters to 0.** Wherever the carriage is when `EM,1,1` is sent becomes "home" for `HM`.
- `CS` clears the step counters.
- `QS` returns `QS,m1,m2`, the step position.
- `ES` is an emergency stop. It flushes the FIFO and replies `ES,0|1`.
- `QG` returns a status byte:
  - Bit 4 is pen up. Bits 3–0 are command executing, motor 1 moving, motor 2 moving and FIFO not empty.
  - The machine is idle when `(byte & 15) == 0`.
- FIFO:
  - The FIFO is 1 deep at boot. NextDraw sets it to 16 with `CU,4,16`.
  - When the FIFO is full, the next motion command waits in the parser and **blocks every later command, including ES**.
  - So the driver keeps only a few commands in flight.

## Framing

- Commands are ASCII and end with `\r`.
- After `CU,10,1` ("future syntax"), every command gets exactly **one reply line ending in `\n`**:
  - the command name if there is no data (`SM`)
  - otherwise the name followed by the data (`QS,12,-4`)
  - errors come back as `XX,!N Err: …`
- `CU,10,1` itself replies with a bare `\n` when sent in legacy mode. The driver sends it first and then discards the input.
- In legacy mode (the boot default) most commands reply `OK\r\n`, and queries reply with data plus `OK`. The driver understands both modes.
- `V` replies `V,EBBv13_and_above EB Firmware Version 3.x.y`. NextDraw requires firmware 3.0.2 or newer.

## USB

- USB vendor ID **0x04D8** and product ID **0xFD92** ("EiBotBoard"), matched with the Web Serial filter `{usbVendorId: 0x04D8, usbProductId: 0xFD92}`.
- The board is a USB CDC device, so the baud rate doesn't matter. The app uses 115200.

## What the app sends

On **Connect**:
```
CU,10,1        (then discard reply / flush)
V              (must contain "EBB")
CU,4,16        (FIFO depth 16; error ignored on older firmware)
```

**Before a plot** (also on Test Up / Test Down, so the sliders take effect):
```
SC,11,<raise rate>   SC,12,<lower rate>
SC,4,<up value>      SC,5,<down value>
SC,8,1               (brushless; standard servo: SC,8,8 and SR,60000)
SP,1,<raise ms>,2    (pen up)
EM,1,1               (only when you confirm the carriage is at home; sets home)
```

**The plot itself** is a stream of commands:

- `SP,0,<lower ms>,2` to put the pen down
- `SM,<ms>,<s1>,<s2>` slices
- `SP,1,<raise ms>,2` to lift the pen
- a final travel back to (0,0)

**Pause**, **Cancel** and the other buttons send:

| Action | Commands |
|---|---|
| Pause | Stop sending. Wait for `QG` to show idle. Then `SP,1,…,2`. |
| Resume | `SP,0,…,2` if the pen was down, then carry on. |
| Cancel | `ES`, then `SP,1,…,2`, then `HM,<home rate>`. |
| Walk home | `SP,1,…,2`, then `HM,<home rate>`. |
| Motors off | `EM,0,0`. Home is now unknown. |

## Verify in the morning (on the real machine)

1. **Pen direction.** *Test Up* must lift the pen, which confirms that `SP,1` is up. If it is reversed, tick *Settings → Machine → Swap pen up/down*.
2. **The pen-lift pin.** If *Test Up/Down* does nothing, the machine may have a standard servo. Set *Pen-lift* to *Standard servo*, which uses pin 1.
3. **80 steps/mm.** Draw the 50 mm test square and measure it.
4. **Axis direction.** The test square should draw away from home, toward +x and +y. If it tries to move into the frame, stop and report it.
5. **The `V` reply.** The firmware version is shown in the panel after Connect. It must be 3.0.2 or newer for `CU,4` and `CU,10`.
6. **Timing.** Compare the estimate with the real plot time, then use *Calibrate*.
