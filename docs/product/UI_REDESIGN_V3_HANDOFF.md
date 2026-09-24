# TCL KOL OS — UI Redesign v3 Handoff

## Scope

Visual/UX integration over the existing Next.js App Router application. The domain model, DB schema, permissions, server actions and workflow transitions remain the source of truth.

Implemented areas:

- persistent authenticated app shell
- login
- home
- campaign list
- create campaign
- campaign workspace / overview
- sources / files
- brief workspace
- internal/client review workspace

The `/campanas/[id]/preguntas` compatibility route remains a redirect into the Brief Workspace; questions are not a separate UX environment.

## Visual language

- typography-first, low visual density
- white / off-white surfaces
- neutral file and product presentation; no campaign or product photography required
- TCL red `#C80000` only for primary actions, active navigation, progress and explicit focus
- burgundy `#660013` reserved as a deeper brand tone
- status colors are deliberately muted and semantic
- larger whitespace and fewer nested cards
- campaign/product identification uses monograms, model names and typography

## Sources / files

The file UI intentionally avoids one strong color per file type. Files use neutral icons and status marks; processing gets a subtle animated dot rather than a saturated badge.

## Brief workspace

Three-column structure:

1. sections / completion navigation
2. editable brief content or local questions
3. contextual comments / evidence

Questions are resolved without leaving the workspace. Evidence is derived from the real field evidence already stored in the system; there is no fictitious AI assistant/chat feature.

## Review workspace

Two-column review layout built on the real `allowedTransitions` behavior. No extra “approved brief” screen or parallel workflow has been invented.

## Motion / interaction references

Approved references retained for future component-level refinement:

- Motion Primitives: https://motion-primitives.com/docs
- Bencho confirm: https://bencho.dev/?c=confirm&theme=dark
- Bencho dock: https://bencho.dev/?c=dock&theme=dark&fill=light&stroke=on
- Bencho liq-create: https://bencho.dev/?c=liq-create&theme=dark
- React Bits Folder Float: https://reactbits.dev/micro/folder-float
- React Bits StatusMark: `npx shadcn@latest add @react-bits/StatusMark-JS-CSS`
- Demostack / shadcn dashboard reference: `npx shadcn@latest add https://registry.watermelon.sh/r/demostack-dashboard.json`

### What is already implemented without extra runtime dependencies

To avoid introducing package/lockfile churn just for presentation, the integration currently implements equivalent lightweight motion with CSS:

- route/page entrance (`uiEnter`)
- button/card hover lift
- upload/folder-style float interaction
- processing/status pulse
- progress animation-ready bars
- sticky contextual dock in Brief/Create
- spring-like confirmation dialog entry
- contextual tab transitions through native state + CSS
- `prefers-reduced-motion` support

If the project later standardizes on Motion Primitives/Bencho/React Bits, the replacement should preserve the same behavior and restraint rather than add decorative continuous animation.

## Integration constraints preserved

- no backend/schema changes
- no new persisted entities for assigned team / next actions
- “next action” comes from real pending critical questions / workflow state
- assigned team is not inferred from comments or audit activity
- no fictitious budget/objective fields added to campaign creation
- no fictitious AI assistant
- existing client role isolation remains in `VistaCliente`
