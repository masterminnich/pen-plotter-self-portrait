# All 13 styles: optimization savings and time estimates

These are the real outputs of each style at Detail 0.5. They were captured from the app with the public-domain NASA
portrait in `test/fixtures/` (by `tools/capture_fixtures.py`) and run with the default settings: NextDraw 8511,
US Letter portrait, 0.5 in margin, drawing 35 mm/s, travel 100 mm/s, acceleration 800/1200 mm/s².
Regenerate with `node tools/style-report.js`.

| Style | Pen lifts | Travel | Drawn | Estimate (raw → optimized) | Naive length/speed | EBB commands | Optimize time |
|---|---|---|---|---|---|---|---|
| blueprint | 2548 → 831 | 14.9 → 4.1 m | 21.2 m | 22:17 → **15:04** | 12:03 | 30980 | 57 ms |
| composition | 1180 → 744 | 6.8 → 3.0 m | 11.8 m | 10:58 → **9:28** | 7:16 | 21112 | 27 ms |
| constellation | 1681 → 206 | 12.6 → 1.7 m | 8.6 m | 12:08 → **5:39** | 4:43 | 10053 | 24 ms |
| invader | 1031 → 1031 | 6.1 → 3.9 m | 6.3 m | 7:42 → **7:20** | 5:15 | 21919 | 12 ms |
| outline | 1 → 1 | 0.2 → 0.2 m | 0.6 m | 0:20 → **0:20** | 0:20 | 124 | 0 ms |
| pinwheel | 1864 → 1600 | 11.2 → 3.8 m | 7.5 m | 11:55 → **9:23** | 6:39 | 23119 | 31 ms |
| pixel | 794 → 582 | 14.9 → 2.8 m | 10.7 m | 11:49 → **9:06** | 6:26 | 33602 | 21 ms |
| shards | 1104 → 1053 | 7.4 → 4.4 m | 3.7 m | 7:26 → **6:48** | 4:06 | 21883 | 17 ms |
| sobel | 266 → 266 | 9.1 → 1.3 m | 6.2 m | 5:26 → **4:04** | 3:35 | 4267 | 5 ms |
| spiral | 30 → 30 | 1.8 → 0.5 m | 7.2 m | 3:55 → **3:41** | 3:34 | 1638 | 0 ms |
| squiggle | 58 → 58 | 5.1 → 0.7 m | 5.5 m | 3:58 → **3:14** | 2:49 | 9604 | 7 ms |
| topo | 95 → 94 | 8.4 → 0.7 m | 10.2 m | 7:16 → **5:57** | 5:06 | 20335 | 12 ms |
| wiggle | 1971 → 1871 | 13.3 → 5.1 m | 7.5 m | 12:53 → **10:55** | 7:17 | 38244 | 46 ms |

How to read it:

- **Pen lifts** and **Travel** are shown before → after optimization. The *before* figures are the order the style
  drew its paths in.
- **Estimate (raw → optimized)** is the full plot time with the acceleration model, before and after optimizing.
- **Naive length/speed** is the formula from issue #2: drawn length ÷ speed + travel ÷ speed + lifts × lift time,
  worked out on the *optimized* paths.
  - It comes out 15–40 % short on styles made of many tiny strokes (blueprint, pinwheel, wiggle, shards). The pen
    never gets up to full speed on those, which is why the planner models acceleration.
  - It is still uncalibrated against a real NextDraw (see docs/MORNING.md).
- **EBB commands** is the number of commands streamed to the NextDraw.
- **Optimize time** is how long the merge, sort and simplify steps took in Node on this Mac. In the browser it is
  similar.
- Some styles don't gain much:
  - Invaders and Shards are made of separate small closed shapes, so nothing can be joined; only the travel
    between shapes shrinks.
  - Outline is a single path.
