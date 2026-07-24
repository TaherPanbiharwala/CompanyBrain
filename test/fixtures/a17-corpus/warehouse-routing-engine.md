---
title: Warehouse routing engine — concept doc
tags: [concept, product, engineering]
---

# the routing engine (aka "the moat")

ok this is the important one so let me actually try to write it properly instead of my usual half
assed notes.

## what it does

Takes a warehouse floor plan + the current position of every active robot + a queue of pending
pallet-move jobs, and outputs a path for each robot that gets its job done without any two robots
colliding or gridlocking each other in a narrow aisle. Sounds simple, is NOT simple once you have
more than like 8 robots moving at once.

## the actual algorithm (high level, priya can correct me if this is stale)

We treat the warehouse as a graph — aisles and junctions are nodes/edges, basically. Each robot gets
a reserved time-window on every edge it plans to use (like an air traffic control system but for
forklifts). When a new job comes in, the planner tries to find the fastest path whose time-windows
don't conflict with any other robot's already-reserved windows. If there's a conflict, it either
finds an alternate path or, worst case, tells the robot to wait a beat at a junction.

This is NOT a fully centralized planner running every robot's path from scratch every tick — that
was the first version and it fell over past ~15 robots (too slow to replan). Current version is
mostly incremental: only the robots whose paths would actually be affected by a new job get
replanned, everyone else keeps their existing reservation. This is what let us scale past 15 robots
without the whole system grinding to a halt.

## "boring reliability" applied here specifically

If the planner can't find a conflict-free path in a bounded amount of time, it does NOT just pick a
path and hope — it tells the robot to hold position and retries. A robot standing still and blocking
half an aisle for 10 seconds is an annoying but boring failure. A robot picking a path anyway and
clipping another robot is the bad kind of failure. Priya is extremely opinionated about this
distinction, it comes up in like every design review.

## known limitations (as of writing)

- doesn't do global optimization, it's greedy per-job — someone mentioned once that a smarter global
  scheduler could shave maybe 10-15% off total travel time across a whole warehouse, but nobody's
  built it, it's a "someday" project
- assumes a static floor plan — if someone moves a shelf without updating the map, things get weird
  fast (this has happened at Finch at least once, embarrassing incident, ask priya if you want the
  story)
- current scale tested: comfortably handles 40 robots (that's Finch's whole fleet across their 3
  sites), untested much above that

## why this is "the moat"

Rohan says it constantly: anyone with enough money can buy or build a pallet-moving robot. Very few
people can route 40+ of them through a real, messy, constantly-changing warehouse without gridlock or
collisions. This algorithm (and years of edge cases baked into it) is the actual hard part.
