# Astro + Preact ports of the Tailwind UI kit

1:1 ports of every template in `../tailwindcss.com/react/` (364 files), for
copying into `webmail/src/` the way the live shell already does.

```
referenceTemplates/
  tailwindcss.com/{html,react,vue}/   ← licensed originals (do not edit)
  astro/                              ← this tree
    _kit/headless.tsx                 Preact stand-in for @headlessui/react
    _kit/heroicons/*.tsx              inlined Heroicons used by the kit
    elements/buttons/01-primary-buttons.tsx
    elements/buttons/01-primary-buttons.astro
    …
```

Each example is two files:

- **`.tsx`** — the React source, mechanically rewritten: `react` → `preact` /
  `preact/hooks`, `@headlessui/react` → `_kit/headless`, `@heroicons/react/*`
  → `_kit/heroicons/*`. Markup and class names are unchanged.
- **`.astro`** — a one-line island: `<Example client:load />`.

## Why not the HTML templates?

The HTML originals now ship `<el-dialog>` / `<el-dropdown>` from Tailwind Plus
Elements. The React originals are already components, which is the shape this
app uses (Astro page, Preact island). Headless UI is still not a production
dependency — the live app's CSP forbids the inline `style` attributes it
sets — so the ports point at `_kit/headless.tsx`, a small Preact shim that
covers the API these templates actually call (`open`/`onClose`, menus,
listboxes, comboboxes, disclosures, tabs, `data-*` selected/focus/open).

When you copy a template into `src/`, keep the markup and classes; replace
the shim with the same hand-rolled open/close the shell already uses
(`ShellNav.tsx`).

## Regenerating

From the repo root:

```sh
node webmail/referenceTemplates/astro/_generate.mjs
npx oxfmt webmail/referenceTemplates/astro   # generator output is not pre-formatted
npx oxlint webmail/referenceTemplates/astro  # must be clean before committing
```

Needs network once, to pull Heroicons SVGs from jsDelivr. The generator
overwrites the `.tsx` / `.astro` files, `_kit/heroicons/*.tsx` and
`_kit/heroicons/props.ts`; it does not touch `_kit/headless.tsx`.

Do not skip the lint step. The generator's first run emitted all 125 icon
components with their SVG markup as a bare JSX attribute containing `\"`
escapes — which JSX does not honour, so every icon module was a syntax error.
They merged anyway, because at the time nothing in CI read this subtree.

## What the gates cover

These files live outside `webmail/src/`, so `astro build` and
`npm run -w webmail typecheck` never see them — `webmail/tsconfig.json`
includes `src/**` only, and the root `tsconfig.json` excludes `webmail`
entirely. **They are not typechecked by anything.**

What does cover them, as of the PR that fixed the above:

| Gate | Covers | Notes |
|---|---|---|
| `npx oxlint` | the 369 `.tsx` | catches non-parsing files — the failure that shipped |
| `npx oxfmt --check` | the 369 `.tsx` | |
| typecheck | nothing | 106 known errors in 70 leaf templates; see below |

`.oxlintrc.json` / `.oxfmtrc.json` ignore only
`webmail/referenceTemplates/tailwindcss.com/**` (the licensed originals). This
tree is our code and is linted, with `no-unused-vars` off for it alone: the
ports are 1:1 with the React source, and twelve identifiers upstream declares
are ones upstream never uses.

The 364 leaf templates are 1:1 ports of untyped React demo code and do not
survive `strict` — `event.target.value` on an untyped handler,
`useState(null)` inferring `null`, and demo data whose shape is Tailwind's
rather than ours. Typing them means inventing structure the originals do not
have, and the generator would overwrite it. `_kit/` — the shared foundation
every template imports — *is* fully typed and clean under `strict`.

Note the 364 `.astro` wrappers are read by no gate at all: oxlint and oxfmt
both skip `.astro`. Each is the same eight-line island, so there is little to
check, but it is not nothing.
