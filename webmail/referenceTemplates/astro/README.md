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
```

Needs network once, to pull Heroicons SVGs from jsDelivr. The generator
overwrites the `.tsx` / `.astro` files and `_kit/heroicons/*`; it does not
touch `_kit/headless.tsx`.

## Not part of the app build

These files live outside `webmail/src/`, so `astro build` / `tsc` never see
them. Lint and format already ignore `webmail/referenceTemplates/**`.
