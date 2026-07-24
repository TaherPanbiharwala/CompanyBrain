---
title: Onboarding flow v2 — project notes
tags: [project, product]
---

# onboarding flow v2

problem this solves: right now getting a new warehouse live takes way too much manual setup — someone
has to hand-draw the floor plan graph (the aisles/junctions thing from the routing engine doc) and
manually place charging docks on a map. Took almost 2 weeks of back-and-forth for Finch's 3rd
warehouse, which is way too slow if we want to sign bigger 3PLs with more sites.

v2 goal: let a customer upload a rough floor plan (even a phone photo of a printed layout, ideally)
and auto-generate a first-draft routing graph, which someone then just reviews/tweaks instead of
building from scratch.

this is very early, mostly design sketches right now, no committed timeline. Priya's team is
prioritizing it below the falcon v2 backlog items for now since nothing's on fire with onboarding
speed at our current customer count (we've only onboarded, what, 3 sites total ever, all Finch's).
