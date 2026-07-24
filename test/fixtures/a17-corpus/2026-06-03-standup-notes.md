---
title: Tuesday standup — 2026-06-03
tags: [meeting, engineering, standup]
---

# standup 6/3

(priya runs these, keeps em short, this is basically verbatim)

PN: rate limiter on the fleet API — we're capping at 200 req/s per warehouse right now, finch is
occasionally bumping into that during their morning batch job. decided: bump the per-warehouse limit
to 350 req/s, ship this week, no big architecture change needed, just a config bump + a bit of load
testing first.

firmware person (name not in these notes, sorry): safety beacon battery drain issue from last week
is fixed, was a polling interval bug, beacons were checking in way more often than they needed to.

routing eng: nothing new, still stable.

thats it, short one today.
