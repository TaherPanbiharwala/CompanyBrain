---
title: Project Falcon — status
tags: [project, engineering]
---

# project falcon

(internal codename, nothing to do with birds, someone just liked the name)

Falcon is the incremental-replanning rework of the routing engine — basically the thing described in
the routing engine concept doc as "current version." Before Falcon, the planner replanned literally
every robot's path on every new job, which is why the old system fell over above ~15 robots.

status as of the last update: SHIPPED to production, running at Finch across all 3 sites. This is
what let us scale their fleet to 40 robots without things grinding to a halt.

what's left (kind of a "falcon v2" backlog, not officially scheduled):
- the global-optimization idea from the concept doc (10-15% travel time savings, unscoped, someday)
- better handling of the "shelf moved without updating the map" edge case that bit us at Finch once

nobody's actively working the backlog items right now, everyone's heads-down on either sales support
for the renewal or the onboarding flow v2 project.
