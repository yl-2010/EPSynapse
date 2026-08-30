# Ideas

Frontier Cascadia · September 12, 2026 · UW Foster · 12 hours

One idea. Built to win grand prize by being something nobody else in the room can reasonably attempt.

---

## PlumeMesh

**Autonomous UAV-swarm intelligence for volcanic ash forecasting and ecological protection — Cascadia edition.**

Adapted from NASA/TM research: *Autonomous UAV Swarms in Volcanic Zones: Edge Intelligence for Ash3d Aviation Forecasting and Ecological Protection in Hawaiʻi* (Bhandari, Dhruva, Eftekhari, Mounier, Panyala, Pyati).

### Why this wins

Judges at Frontier Cascadia score what **works**, not what sounds scientific. Almost every team will ship an AI chatbot, a study app, or a generic “climate dashboard.” This is a live, demoable **scientific instrument**: a simulated UAV swarm that measures ash the way satellites cannot (altitude-specific particle size and concentration), feeds those measurements into an Ash3d-style forecast, and shows what that does to **Sea-Tac / Boeing Field / Portland** airspace *and* to a real endangered species.

It is also the only idea in the room that already has a NASA-format technical memo behind it. That is the Frontier Award and the grand prize at the same time: nobody else will have tried this, and the demo still has to run.

### The problem (PNW, not Hawaii)

Mt. Rainier, Mt. St. Helens, Mt. Baker, Glacier Peak, and Mt. Hood sit next to the busiest aviation corridor in the Pacific Northwest. Volcanic ash wrecks jet engines, forces reroutes, and shuts airports. Today:

- Satellites only see the **top** of an ash cloud, not concentration by altitude (the number that actually kills engines).
- Grain size and mass eruption rate in USGS **Ash3d** are often historical guesses, not live measurements.
- Washington VAAC ash advisories update on a **6-hour** cycle unless something major changes.
- Helicopters cannot fly into dense ash; ground crews cannot enter the hazard zone.

The NASA memo showed that swapping default Ash3d grain-size / Suzuki assumptions for more specific inputs **changed modeled ashfall footprints and airport arrival times** (minutes of difference at Hawaiian airports; same physics applies here). Direct UAV measurements close that gap.

Secondary mission, same sensors: after an eruption, the same thermal + acoustic + LiDAR payload can check whether a colony is still occupied. In Hawaiʻi that species is the endangered **ʻuaʻu** (Hawaiian petrel). For Cascadia, the analog is high-elevation habitat that people cannot safely survey after a blast (Rainier alpine, St. Helens blast zone, Baker).

### What we actually ship in 12 hours

Not a real drone over Kīlauea. A working software system that *is* the brain of that swarm:

1. **Swarm sim** — a map of Rainier / St. Helens with a two-tier flock (high-altitude relay “fixed wing” + low-altitude hexacopter inspectors). Drones autonomously steer toward the plume peak (LoCUS / Gaussian field), survive individual failures, and keep a mesh when ground radio dies.
2. **Edge package** — each inspector emits the same compact packet the memo specifies: timestamp, lat/lon, altitude, plume height, ash mass concentration, particle size bins. No raw video dump. That is the product VAAC would actually ingest.
3. **Ash3d sensitivity live** — two forecast layers on one map: *baseline* (default GSD + Suzuki 4) vs *drone-informed* (measured GSD + Suzuki 2). Show Sea-Tac / BFI / PDX **cloud arrival time** and deposit thickness flipping when the swarm data arrives. That is the “it works” moment for judges.
4. **Aviation board** — a fake-but-faithful VONA / color-code panel (Green → Red) plus a “restrict this flight level, not the whole FIR” recommendation. Jet-engine risk is concentration × time at altitude, not “ash exists on the satellite picture.”
5. **Ecology overlay (second tab)** — thermal-occupancy + acoustic-presence heatmap on a protected polygon. Same hardware story, different output: burrows occupied vs buried, plus a gas/ash exposure layer. Pitch it as a free extra from the aviation payload, not the main product.

Pre-event (allowed): empty repo, map tiles, Ash3d docs, USGS Rainier / St. Helens shapefiles bookmarked, UI skeleton with no logic. Day-of: all the swarm, forecast, and overlay logic.

### Why it is unique

- **Particle-bin ash, not “AI detected a volcano.”** Judges from Seattle aviation / earth science will know the satellite vertical-structure gap is real.
- **Cascadia airports on the screen.** PNW Impact is automatic if Sea-Tac arrival time moves when the swarm reports.
- **Hardware story without fake hardware.** Particle IoT is a sponsor; the architecture (FANET mesh, edge inference, battery-swap that does not reset consensus) is a real systems design, shown in software.
- **NASA memo as provenance.** Prasham is already a co-author. We are not inventing volcanoes; we are compressing a full TM into a 12-hour ship.

### Tracks it hits

| Prize | Fit |
| --- | --- |
| Grand prize | Works on a table, serious judges, not a wrapper |
| Frontier Award | UAV swarm + Ash3d + ecology on one stack |
| PNW Impact | Rainier / St. Helens → Sea-Tac / PDX |
| Best AI for Good | Edge MARL for plume tracking + endangered-species survey as side benefit |

### Demo script (90 seconds)

1. Eruption starts on Rainier. Baseline Ash3d paints a conservative ash blob; Sea-Tac arrival ~X hours.
2. Swarm launches. Inspectors climb into the plume; relays keep the mesh when “ground link lost.”
3. Live particle-size histogram updates. Forecast **recomputes**. Sea-Tac arrival shifts; a lower flight level is marked safe.
4. Flip to ecology: same pass, thermal dots on burrows, one sector over 15% occupancy drop → alert.
5. Cost one-liner from the memo: targeted helicopter/field work is the expensive, dangerous slice; this supplements HVO/VAAC, it does not replace them.

### Out of scope (do not build)

Real FAA flight, real Ash3d HPC cluster, real TDLAS laser, real ʻuaʻu classifier trained on field audio, real battery chemistry. Those live in the memo. The hackathon ships the **decision system** that would consume that hardware.
