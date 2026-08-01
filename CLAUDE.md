## Specs — `context/`
`context/` is the source of truth for product specs and design intent. When a task touches data model, UX, or expansion scope, read the relevant file here first — code may lag the spec, and discrepancies should be flagged rather than silently followed.


`herbert.json` at the repo root is the in-tree PRD — the product summary and the logged specification map, exported from the herbert dashboard. It's refreshed after a retro; commit it alongside the work it describes.

**Logging specs: reuse the PRD's components.** Before `log_specification`, call `get_prd` and pick the spec's `context` from the components already there (`subjects`, `tags`, `ontology`, `design-system`, `agents`, `ios`, `infra`, …). Only invent a new component when the concept genuinely has no home — and say so out loud when you do. A spec describes product behaviour, so state it once for both clients; `ios` carries only genuinely iOS-only facts (e.g. the font gap), because parity means the same IA with platform-native chrome.

**Log corrections when redirected.** When the user corrects or redirects the approach, call `log_correction` at that moment — not reconstructed later at the retro. Keep a spec's status matching its real state (`in_progress` while it's being built); `log_specification` defaults new specs to complete, which parks in-flight work in the wrong column.

`README.md` covers setup, env vars, and the deploy walkthrough.

---

## Behavioral guidelines

Bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.
- **Read the real diagnostic before hypothesising.** The actual error, log line, DB row, or library source — not a plausible story about it. Inspect real DB/API state before writing a fix.
- **When a task names an outcome but not the element, confirm which before building.** "Increase the font size when expanded" — the title or the summary? Guessing here has cost two reopens.

### 2. Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

### 3. Surgical changes

Touch only what you must. Clean up only your own mess.

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that *your* changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

**Exception — defects.** When fixing a defect, fix it on every surface that exhibits it: all four surfaces above, both editor surfaces, both Subject mappers. That is the scope of the fix, not scope creep. "Touch only what you must" governs *unrelated* code — not the other half of the same bug.

### 4. Goal-driven execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

### 5. SOLID principles

Follow SOLID when designing classes, modules, and agents/tools. These are defaults, not dogma — when a principle and rule #2 (Simplicity first) conflict, simplicity wins for single-use code.

- **S — Single responsibility.** Each module, class, or function has one reason to change. If you find yourself writing "and" in the docstring (`"parses input and writes to DB and sends email"`), split it. Examples in this repo: prompt files, context builders, and tools are separated per agent precisely so each has one reason to change.
- **O — Open/closed.** Open for extension, closed for modification. Adding a new agent, Subject type, or MCP connection mode should not require editing unrelated existing code — extend via registration (`registry.py`), discriminated unions (`subject.type`), or new files, not by patching switch statements that already work.
- **L — Liskov substitution.** Subtypes must honor the contract of their base. Any new `Subject` (Image, Widget) must work everywhere a `Note` works — same identity, iteration, conversation wiring — without callers special-casing it. Same for `Container` (Book, Slide, App).
- **I — Interface segregation.** Don't force callers to depend on methods they don't use. Keep agent tool signatures narrow; keep API response models scoped to what the caller actually reads. Prefer two small interfaces over one wide one.
- **D — Dependency inversion.** High-level code depends on abstractions, not concretions. Routes depend on the async SQLAlchemy session abstraction (injected), not on a specific DB; agents call tools through the pydantic-ai tool protocol, not by importing concrete implementations.

When SOLID would push you toward an abstraction that has only one implementation today, don't build it speculatively — wait until the second use case is real. Rule #2 outranks premature SOLID compliance.
