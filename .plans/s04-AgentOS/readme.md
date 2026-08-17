Borrowing Concepts From "Cloudflare OS"
========================================

> **Status: the Bureau (T1–T3a, T3) is SHIPPED; T4–T6 are not.** An isolated worker owns `VAULT_MASTER_KEY`, `bureau_grants` authorize `(principal, credRef, verb)`, and Class A `fetch` enforces the kind gate. Egress redaction is a wired-but-inert seam; Class B verbs are unbuilt. ⚠️ This readme scopes four governance items but the devPlan is entirely the Bureau — **budgets shipped elsewhere**, in `packages/scheduling` under s10/s17. Do not look for them here.

> https://blog.cloudflare.com/cloudflare-os/


Share "The App with others" 
or Share "The App Blueprint with others" 

- Workspace
    - Read/Write/Execute Files
    - Gated Access
        - Read/Write across granted MCPs
        - 
- Governance
    - Gatekeeper  → designed in [`bureau.md`](./bureau.md) ("The Bureau")
    - Budget Constraints
    - Access Control Lists 
        - People Accessing Agents
        - Agents Accessing Tools/Data


