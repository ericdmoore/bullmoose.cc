- Leverage open-source project when it makes sense.
- If we are designing and implementing something - here are our architectural principles:
    - Pure-core; effects-in-the-shell
    - tests must be ample, and fast
    - clients are always passed in to functions - so that tests can pass in mocks/fakes
    - leverage 3rd party fake-clients & fake-db-mocks, and harnesses for testing - make them as needed.
    - By injecting fake-clients most of the shell code can get coverage too without the need for real network access
    - use codecoverage to find places where these priu
- Plan hygiene — learned the hard way, 2026-08-17, when an audit found seven sections
  claiming "design" for work that had shipped:
    - A **readme's status line freezes at authoring time**; a **devPlan's status block stays
      true**, because it gets updated during the build. Where a section has a devPlan, its
      readme should say so and point at it rather than carrying a second, staler answer.
    - Say **shipped / deployed / switched on** separately. They are three different facts.
      The explorer is shipped and deployed and off; Jobs is shipped and has no caller.
    - The drift ran **one direction only** — every stale line understated what existed. That
      is the forgiving failure mode, but it still means the roadmap invents work.
    - When a plan justifies a decision with a claim about the code, **the claim rots**. Three
      security-relevant examples in one week: a scope justified by a wrong tier, an outbound
      check justified by "the agent cannot mint it", and a blocker that had already been
      fixed. Cite `file:line` so the claim is checkable, or do not make it.

