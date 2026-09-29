| metric | A1 | A2 | B | B-bufsrc | B-chunkedself |
|---|---|---|---|---|---|
| cuts measured | 200/200 | 200/200 | 200/200 | 200/200 | 200/200 |
| program / wall (s) | 961.6 / 968.7 | 961.6 / 963.6 | 961.6 / 961.6 | 961.6 / 961.6 | 961.6 / 961.6 |
| cuts with dropped frames | 0 (total 0, max 0) | 1 (total 2, max 2) | 0 (total 0, max 0) | 0 (total 0, max 0) | 0 (total 0, max 0) |
| cuts with freeze >= 1 frame | 117 (dup total 126) | 29 (dup total 41) | 4 (dup total 5) | 2 (dup total 7) | 7 (dup total 9) |
| freeze at cut ms mean / p95 / max | 21.8 / 41.1 / 133.6 | 6.7 / 50 / 149 | 2.1 / 9.8 / 64.7 | 1.3 / 4.2 / 155.2 | 1.9 / 10.3 / 112.3 |
| cuts showing wrong (stray) frames | 0 (total 0) | 0 (total 0) | 0 (total 0) | 0 (total 0) | 0 (total 0) |
| interior drops / freezes (baseline) | 171 of 28445 / 83 | 114 of 28445 / 116 | 7 of 28445 / 18 | 16 of 28445 / 13 | 4 of 28445 / 23 |
| audio: cuts with click | 196 | 0 | 1 | 15 | 0 |
| audio: cuts with gap >= 1 ms | 200 | 0 | 0 | 0 | 0 |
| audio gap ms mean / p95 / max | 60.6 / 69.3 / 90.7 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| audio: cuts with overlap | 0 | 0 | 0 | 4 | 0 |
| audio glitches outside cuts | 0 | 16 | 28 | 0 | 0 |
| audio: repeated 128-sample quanta | 0 | 16 | 29 | 0 | 0 |
| A/V offset at cut ms mean [p5, p95] | -30.4 [-33.5, -27.1] (n=200) | 17.4 [5.1, 24.6] (n=200) | 4 [0.5, 7.8] (n=200) | 3.7 [0.5, 7.6] (n=200) | 4.8 [1.2, 7.6] (n=200) |
| rAF interval ms p50 / p99 / max | 8.3 / 9.3 / 1870.7 | 8.3 / 9.3 / 191.7 | 8.3 / 10.2 / 98.4 | 8.3 / 9.3 / 188.4 | 8.2 / 10.4 / 146.8 |
| probe cost ms mean / p99 | 1.6 / 4.1 | 2.3 / 8.9 | 1.2 / 3.7 | 1 / 2.2 | 2.4 / 8.9 |
| CPU all processes % mean | 2.8 | 3.3 | 2.5 | 1.8 | 5.1 |
