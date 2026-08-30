# Ideas

Frontier Cascadia · September 12, 2026 · UW Foster · 12 hours

Candidates. Attribution is under each heading: **human-made** vs **cursor-generated**.

---

## EPSurvey

_Source: human-made_

Student sentiment for schools. Built first for Eastside Prep (EPS). Other schools can run the same product with their own topics and login.

Students answer short, anonymous (or school-account) surveys. Adults see aggregates, not a pile of raw callouts. The point is to stop guessing what people want from LPC, EBC, classes, and teachers, and start counting.

### Topics already on the table (human-made)

- **LPC** — cafeteria offerings: what to keep, drop, add, dietary gaps, wait times.
- **EBC** — the week-long spring-break trip: which locations students actually want, cost sensitivity, who feels locked out.
- **Class offerings** — what to add next year, what is oversubscribed, what is a paper class.
- **Teacher rankings** — RateMyProfessor-style for EPS: useful if it is structured (workload, clarity, would take again) and not a roast wall.

### Extra topic ideas (cursor-generated)

- Nightly homework load by class, not vibes
- Advisory / community-time format
- Lunch length vs passing period
- Clubs and sports: add, drop, or move the meeting time
- Assembly and all-school meeting topics
- Library and quiet study space (hours, noise, enough seats)
- Phone policy as actually lived, not as written
- College counseling access and wait
- Facilities: bathrooms, lockers, gym, theater
- Pickup, parking, and late-start communication
- Arts vs STEM seat pressure (who cannot get into the class)

### What it has to be, or it is a Google Form

A school-branded survey app with a live admin board (counts, breakdown by grade if opted in, trend vs last pulse). One topic at a time so it does not become a 40-question climate survey nobody finishes. Export for whoever already decides LPC menus and EBC sites.

RateMyProfessor only works with a rubric and a floor on n. A named-teacher leaderboard on day one will get the project killed by adults, which is the actual user.

### Fine-tune / research (cursor-generated)

Optional, same NoteLMs loop: free-text comments go through a small sentiment/topic model (fine-tuned on school comments) plus a general LLM. Live student writes feed the research set. Admin board shows theme clusters, not every comment. Do not put identifiable free text on a public demo wall.

---

## Unc

_Source: cursor-generated_

Paste the caption, comment, or bio before you post. A small fine-tuned model votes **human / brand / uncle**: does this sound like a person, like a social intern using the same words, or like an adult performing the internet.

Lilac (or another frontier API) is the fluent third voter. Base BERT is the encyclopedia baseline. You tap posted / rewrote / that was the joke. Those taps are the research set.

The joke is the name and the third class. The useful job is a pre-post register check, not a slang dictionary. Do not scrape TikTok. Paste from a phone. Do not put raw captions on a public research page.

**Why it is in this file:** strongest pop-culture hook from the slang pass, and the research question is real. Frontier models can define a word and still write it like a press release. A DistilBERT trained on who is speaking should disagree with them in a pattern you can plot.

**Demo:** a real FYP comment next to a brand caption using the same slang. Fine-tune splits them. Gemma compliments both. A judge hits "that was the joke." The research count ticks.

**Dies if:** the team authors the slang examples. Use their phones. Or if the homepage is a glossary.

---

## Group chat to a plan

_Source: cursor-generated_

Paste a hang thread (iMessage, Instagram, Discord: paste only). The model labels **vapor / time proposed / locked / dead**. If it is vapor, you get one copyable message with a time, a place, and "reply only if you can."

The laugh is a count of "I'm down" next to an empty calendar. The job is that the weekend stops dying in maybe.

Fine-tune DistilBERT on thread snippets. Lilac drafts the lock text after the small model says a lock text is needed. Later you tap went / nobody showed / still nothing. That outcome is the research label.

**Demo:** 15-line "we should hang" with no Tuesday in it. Fine-tune says vapor and offers the one message. Then a second thread that already has a time, shown as a block.

**Dies if:** the pitch is about slang. Pitch "this thread had no Tuesday, now it does."

---

## When to leave

_Source: cursor-generated_

Paste a messy time and place (`practice 4:30 Robinswood`, a Canvas due, a schedule screenshot). One number: **leave at 3:51**. Fine-tune extracts what / where / when. Travel time can be a dummy pad. Afterward: on time / late / skipped.

The laugh is one line if you are clearly not walking. The screenshot is the clock.

**Demo:** "work 5, bus from U District," then the real 5:30 submission deadline and the walk from the table to the atrium.

**Dies if:** the parse is wrong. Fake transit is fine. Fake event times are not.

---

## Buried question

_Source: cursor-generated_

Paste a long message or email. The ramble collapses. The ask is huge (`pick up your sister at 4:15`) plus reply chips you can copy. If there is no question, it says so. Same three-model vote as NoteLMs. User edits to the extracted question are gold labels.

The laugh is an on-read timer. Strip it and the app still works. This is the closest to a tool you keep.

**Demo:** parent paragraph that buries 4:15. Fine-tune surfaces the time. A second paste that is only venting refuses chips.

**Dies if:** it becomes a summarizer. One field plus a reply tap, or it is the same as half the room.

---

## Recurring spend

_Source: cursor-generated_

Photo or paste of a Venmo / Apple Cash / card week. No bank login. OCR, then a small model on merchant strings: recurring vs one-off, plus a food total for the week. Tap to fix "that was a gift." Public research page does not show amounts.

The laugh is four subscriptions showing up. The list is the product. Do not build cancel or Plaid.

**Demo:** fake week with streaming, Apple, DoorDash. Fine-tune lists recurrings and food. Judge marks one row not recurring. Chart ticks.

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
