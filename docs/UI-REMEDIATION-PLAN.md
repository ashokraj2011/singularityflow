# VS Code UI Remediation Plan

Status: implemented and regression-backed on `main`.

## Outcome

The VS Code UI must keep the contributor oriented when several Stories exist, remain usable in a
narrow editor column, and expose a safe recovery action when a long-running command outlives the
extension request. The UI is a projection of the CLI state; it does not create a second lifecycle
or infer that a timed-out mutation failed.

## Remediation work

### 1. Story context and navigation

- Show every active Story in Lifecycle and Inbox, with the selected checkout explicitly marked.
- Switch Stories through `session attach`, then open the exact checkout returned by the CLI.
- Keep generated artifacts scoped to their owning Work ID so sibling Stories never share a phase
  or artifact row accidentally.
- Fail visibly when a stored Story selection is stale instead of falling back to another checkout.

### 2. Timeout and recovery states

- Keep the exact, repository-bound terminal command when a Start operation times out.
- Offer **Check and open created Story** so a terminal retry that completed after the timeout is
  adopted without starting the Story again.
- Render errors as alerts, recovery results as polite status updates, and busy forms with
  `aria-busy`.

### 3. Responsive layout

- Prevent cards, form fields, help search, action rows, and Story selectors from imposing a fixed
  minimum width on the editor.
- Stack dense forms and actions at narrow widths while keeping tables horizontally scrollable.
- Preserve keyboard focus, reduced-motion behavior, high-contrast borders, and theme-owned colors.

### 4. Visual and automated assurance

- Exercise light, dark, and high-contrast fixtures at 320, 640, 1024, 1200, and 1440 pixels.
- Include active-Story selection and timed-out Start recovery in the deterministic fixture.
- Test semantic status icons, single-primary-action hierarchy, explicit recovery controls, active
  Story ordering, responsive breakpoints, and the shared viewport contract.

## Acceptance criteria

- A sibling Story is reachable from both Lifecycle and Inbox without manually locating a worktree.
- Selecting it opens the repository path proven by `session attach`.
- A timed-out start cannot silently disappear and can be checked without issuing a second start.
- No card, field, or action group forces horizontal page overflow at 320 pixels; intentionally wide
  evidence tables remain inside their own scroll container.
- All status and recovery changes are announced to assistive technology and all animation respects
  reduced-motion settings.
- The extension typecheck, visual fixture generation, and VS Code UI tests pass before publication.

## Ongoing rule

New full-page surfaces must use the shared `page()` and `STYLE` helpers. New stateful UI must add a
deterministic model test and, when it introduces a new layout pattern, extend the visual fixture.
This keeps later features inside the same navigation, accessibility, and responsive contracts.
