# A17 answer-quality eval

## Retrieval scoring
- hit@1: 1.00
- hit@3: 1.00
- MRR: 1.00

## Answer transcript — hand-grade each: does this correctly answer the question, with honest citations?

### q1: Who is the engineering lead at Northstar Robotics?

**Answer:** Priya Nair is the engineering lead at Northstar Robotics [1]. She joined in year 2 (~2023) from a larger robotics company and owns the routing engine, fleet coordinator, and firmware [1, 3].

**Cited:** [1] priya-nair, [3] northstar-robotics
**Retrieved:** priya-nair, rohan-mehta, northstar-robotics, sara-kim, finch-logistics, northstar-robotics, project-falcon, warehouse-routing-engine

Grade: [ ] pass  [ ] fail — notes:

---

### q2: Who is the CEO and founder of Northstar Robotics?

**Answer:** Rohan Mehta is the founder and CEO of Northstar Robotics [1][2].

**Cited:** [1] rohan-mehta, [2] northstar-robotics
**Retrieved:** rohan-mehta, northstar-robotics, priya-nair, sara-kim, finch-logistics, northstar-robotics, pricing-model, warehouse-routing-engine

Grade: [ ] pass  [ ] fail — notes:

---

### q3: What discount did Finch Logistics ask for in their renewal negotiation?

**Answer:** Finch asked for a 12% discount on the per-robot fee if they commit to a 2-year term instead of renewing annually [1][3].

**Cited:** [1] finch-logistics-renewal, [3] 2026-06-10-customer-call-finch
**Retrieved:** finch-logistics-renewal, finch-logistics, 2026-06-10-customer-call-finch, pricing-model, onboarding-flow-v2, 2026-06-03-standup-notes, project-falcon, northstar-robotics

Grade: [ ] pass  [ ] fail — notes:

---

### q4: What counter-offer did Rohan approve for the Finch Logistics renewal?

**Answer:** Rohan approved a counter-offer of 8% for a 2-year term [1][2].

**Cited:** [1] finch-logistics-renewal, [2] 2026-06-10-customer-call-finch
**Retrieved:** finch-logistics-renewal, 2026-06-10-customer-call-finch, finch-logistics, northstar-robotics, rohan-mehta, pricing-model, northstar-robotics, warehouse-routing-engine

Grade: [ ] pass  [ ] fail — notes:

---

### q5: What algorithm approach does the warehouse routing engine use to avoid robot collisions?

**Answer:** The routing engine treats the warehouse as a graph (aisles and junctions are nodes/edges) and uses a time-window reservation system: each robot gets a reserved time-window on every edge it plans to use, like an air traffic control system [1]. When a new job arrives, the planner attempts to find a path whose time-windows do not conflict with any already-reserved windows; if a conflict occurs, it either finds an alternate path or tells the robot to wait at a junction [1]. The current version (called Falcon) uses incremental replanning — only the robots whose paths would actually be affected by a new job get replanned, which allowed scaling past 15 robots [1][6].

**Cited:** [1] warehouse-routing-engine, [6] project-falcon
**Retrieved:** warehouse-routing-engine, warehouse-routing-engine, northstar-robotics, onboarding-flow-v2, finch-logistics, project-falcon, 2026-06-03-standup-notes, northstar-robotics

Grade: [ ] pass  [ ] fail — notes:

---

### q6: What is Project Falcon and what is its current status?

**Answer:** Project Falcon is the incremental-replanning rework of the routing engine that replaced the old system, which could not handle more than ~15 robots [1]. Its current status is that it has been shipped to production and is running at Finch Logistics across all three sites, enabling their fleet to scale to 40 robots [1]. No one is actively working on the backlog items (global optimization and better shelf-movement handling) as efforts are focused elsewhere [1].

**Cited:** [1] project-falcon
**Retrieved:** project-falcon, northstar-robotics, 2026-06-10-customer-call-finch, northstar-robotics, rohan-mehta, finch-logistics, onboarding-flow-v2, finch-logistics-renewal

Grade: [ ] pass  [ ] fail — notes:

---

### q7: What was decided about the fleet API rate limiter in the June 3rd standup?

**Answer:** The per-warehouse rate limit was bumped to 350 requests per second, with a plan to ship that change within the week after some load testing, and no major architecture change was required (just a config bump) [1].

**Cited:** [1] 2026-06-03-standup-notes
**Retrieved:** 2026-06-03-standup-notes, project-falcon, northstar-robotics, 2026-06-10-customer-call-finch, pricing-model, finch-logistics-renewal, finch-logistics, onboarding-flow-v2

Grade: [ ] pass  [ ] fail — notes:

---

### q8: What pricing tiers does Northstar Robotics offer?

**Answer:** Northstar Robotics offers three pricing tiers: Starter (per-robot monthly fee, no platform fee, capped at 10 robots), Growth (per-robot fee with volume discount plus a flat monthly platform fee), and Scale (custom pricing for 30+ robots across multiple sites) [1].

**Cited:** [1] pricing-model
**Retrieved:** pricing-model, northstar-robotics, rohan-mehta, finch-logistics, northstar-robotics, sara-kim, priya-nair, finch-logistics-renewal

Grade: [ ] pass  [ ] fail — notes:

---

### q9: What problem is the onboarding flow v2 project trying to solve?

**Answer:** The onboarding flow v2 project is trying to solve the problem that getting a new warehouse live takes too much manual setup. Someone has to hand-draw the floor plan graph (the aisles/junctions thing from the routing engine) and manually place charging docks on a map. This took almost two weeks of back-and-forth for Finch's third warehouse, which is too slow for signing bigger 3PLs with more sites [1].

**Cited:** [1] onboarding-flow-v2
**Retrieved:** onboarding-flow-v2, northstar-robotics, project-falcon, northstar-robotics, rohan-mehta, warehouse-routing-engine, priya-nair, warehouse-routing-engine

Grade: [ ] pass  [ ] fail — notes:

---

### q10: Who leads sales at Northstar Robotics and which customer deal have they closed?

**Answer:** Sara Kim leads sales at Northstar Robotics [1]. She has personally closed most of the company's first 6 logo deals, including Finch Logistics, which was Northstar's first and biggest customer [1][2].

**Cited:** [1] sara-kim, [2] northstar-robotics
**Retrieved:** sara-kim, northstar-robotics, rohan-mehta, finch-logistics, priya-nair, northstar-robotics, finch-logistics-renewal, project-falcon

Grade: [ ] pass  [ ] fail — notes:

---
