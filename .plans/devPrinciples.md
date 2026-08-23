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

- HATEOAS by default — decided 2026-08-22, after the explorer shipped with the
  links already in it and Eric still could not find them:
    - **An id in a response body is a dead end.** To use it a reader must select
      it, know the grammar, and hand-assemble a URL. Emit the href; the raw id
      stays legible inside it, so linking costs nothing and removes a step.
    - **Deviating needs a stated reason**, the way `--force` or a scoped
      lint-disable does. "It was easier" is not one.
    - The argument that settles it is that BOTH readers now agree. A *compiled*
      client prefers to CONSTRUCT — it has a spec, generates URL builders, and
      treats ids as values to interpolate; that is why codegen-from-OpenAPI beat
      HATEOAS the first time. An *LLM agent* prefers to FOLLOW: it has no
      generated client, following requires zero prior knowledge, and
      constructing requires knowing parameter names and encoding rules well
      enough that a mistake yields a plausible-looking 404. A link is
      self-documenting and cannot be malformed.
    - So the constructing audience is served by `POST /api/jmap`, and every
      browsable surface — the explorer today, anything like it later — is
      link-first for the two audiences it actually has: a human pointing and
      clicking, and an agent reading and following.
    - **Ordering is part of navigability.** The explorer emitted a correct
      `_links` on every list item and a wall of 25 opaque `ids` directly above
      it; the person who WROTE the requirement read the wall and concluded the
      links were missing. If the first thing on screen is not the thing you can
      click, the affordance does not exist. Put the navigable keys first.
    - For open input, prefer **RFC 6570 URI templates** — already the
      convention next door, since JMAP's own `downloadUrl` / `uploadUrl` /
      `eventSourceUrl` are templates — and describe the parameters with **JSON
      Hyper-Schema `hrefSchema`** rather than a bare list of accepted names. It
      publishes what the code already knows, and it serves both readers at once:
      machine-checkable input rules for an agent, and enough for a
      form-rendering extension to draw actual inputs for a human.
- (CLOSED 2026-08-22: the Node CLI was REMOVED the same day, soak waived — Eric: "literally the only user… ready to bury the CLI". The freeze completed its job.) The Node CLI is FEATURE-FROZEN — decided 2026-08-22, Eric: *"no more node CLI
  work. Only adding via golang."*
    - Every new CLI capability lands in `cli-go`. That includes the client side
      of a new JMAP type: the server half stays TypeScript because the workers
      are TypeScript, but nothing new is taught to `packages/cli`.
    - **Why it is a rule and not a preference:** the Node CLI is scheduled for
      deletion (s08 T7), and a feature added to it is a feature that has to be
      ported before it can be deleted. Every such addition moves the retirement
      date away from itself.
    - Bug fixes to `packages/cli` remain fine while it ships — the freeze is on
      NEW surface, not on keeping the thing correct.
    - The measurement that says how close retirement is stays `BULLMOOSE_TRACE`
      and the contract suite, not anyone's sense of doneness (s08 T7).
