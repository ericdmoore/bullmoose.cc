/** @jsxImportSource preact */
/**
 * A small Preact stand-in for `@headlessui/react` v2, for the Tailwind UI
 * reference ports. Enough of the API the templates actually call — `open` /
 * `onClose`, `value` / `onChange`, `as`, `className`, render-prop children,
 * `data-selected` / `data-focus` / `data-open` — without Headless UI's
 * inline `style` attributes (which this app's CSP forbids on the live
 * surface). Not a drop-in for production; copy markup, then wire real
 * behaviour in the island the way ShellNav does.
 */
import { cloneElement, createContext, createElement, toChildArray } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, JSX, VNode } from "preact";

type Tag = keyof JSX.IntrinsicElements | string;
type Rest = Record<string, unknown>;

const STRIP = new Set(["transition", "static", "hold", "anchor", "modal", "unmount"]);

function split(props: Rest) {
  const rest: Rest = {};
  for (const [k, v] of Object.entries(props)) {
    if (STRIP.has(k) || v === undefined) continue;
    rest[k] = v;
  }
  const cls = (rest.className as string | undefined) ?? (rest.class as string | undefined);
  delete rest.className;
  delete rest.class;
  if (cls) rest.class = cls;
  return rest;
}

function El({ as = "div", children, ref, ...props }: Rest & { as?: Tag; children?: ComponentChildren; ref?: unknown }) {
  return createElement(as as string, { ref, ...split(props) }, children);
}

function callOnClose(onClose: unknown, value = false) {
  if (typeof onClose === "function") (onClose as (v: boolean) => void)(value);
}

// ── Dialog ────────────────────────────────────────────────────────────────

type DialogBag = { open: boolean; onClose: unknown };
const DialogCtx = createContext<DialogBag>({ open: false, onClose: undefined });

export function Dialog({
  open = true,
  onClose,
  children,
  ...rest
}: Rest & { open?: boolean; onClose?: unknown; children?: ComponentChildren }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") callOnClose(onClose, false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <DialogCtx.Provider value={{ open, onClose }}>
      <El {...rest}>{children}</El>
    </DialogCtx.Provider>
  );
}

export function DialogBackdrop(props: Rest) {
  const { onClose } = useContext(DialogCtx);
  return <El as="div" aria-hidden="true" onClick={() => callOnClose(onClose, false)} {...props} />;
}

export function DialogPanel(props: Rest & { children?: ComponentChildren }) {
  return <El role="dialog" aria-modal="true" {...props} />;
}

export function DialogTitle(props: Rest & { children?: ComponentChildren }) {
  return <El as="h2" {...props} />;
}

export function TransitionChild(props: Rest & { children?: ComponentChildren }) {
  return <El {...props} />;
}

export function Transition({
  show = true,
  children,
  ...rest
}: Rest & { show?: boolean; children?: ComponentChildren }) {
  if (!show) return null;
  return <El {...rest}>{children}</El>;
}

// ── Menu ──────────────────────────────────────────────────────────────────

type MenuBag = { open: boolean; setOpen: (v: boolean) => void };
const MenuCtx = createContext<MenuBag>({ open: false, setOpen: () => {} });

export function Menu({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <MenuCtx.Provider value={{ open, setOpen }}>
      <El ref={root} data-open={open ? "" : undefined} {...rest}>
        {children}
      </El>
    </MenuCtx.Provider>
  );
}

export function MenuButton({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  const { open, setOpen } = useContext(MenuCtx);
  return (
    <El as="button" type="button" aria-expanded={open} onClick={() => setOpen(!open)} {...rest}>
      {children}
    </El>
  );
}

export function MenuItems({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  const { open } = useContext(MenuCtx);
  if (!open) return null;
  return (
    <El role="menu" {...rest}>
      {children}
    </El>
  );
}

export function MenuItem({ children }: { children?: ComponentChildren }) {
  const [focus, setFocus] = useState(false);
  const child = toChildArray(children)[0];
  if (child && typeof child === "object") {
    return cloneElement(child as VNode<Rest>, {
      role: "menuitem",
      "data-focus": focus ? "" : undefined,
      onMouseEnter: () => setFocus(true),
      onMouseLeave: () => setFocus(false),
    });
  }
  return <>{children}</>;
}

// ── Listbox ───────────────────────────────────────────────────────────────

type ListboxBag = {
  value: unknown;
  onChange: (v: unknown) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
};
const ListboxCtx = createContext<ListboxBag>({
  value: undefined,
  onChange: () => {},
  open: false,
  setOpen: () => {},
});

export function Listbox({
  value,
  onChange,
  children,
  ...rest
}: Rest & { value?: unknown; onChange?: (v: unknown) => void; children?: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <ListboxCtx.Provider value={{ value, onChange: onChange ?? (() => {}), open, setOpen }}>
      <El ref={root} {...rest}>
        {children}
      </El>
    </ListboxCtx.Provider>
  );
}

export function ListboxButton({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  const { open, setOpen } = useContext(ListboxCtx);
  return (
    <El as="button" type="button" aria-expanded={open} onClick={() => setOpen(!open)} {...rest}>
      {children}
    </El>
  );
}

export function ListboxOptions({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  const { open } = useContext(ListboxCtx);
  if (!open) return null;
  return (
    <El role="listbox" {...rest}>
      {children}
    </El>
  );
}

export function ListboxOption({ value, children, ...rest }: Rest & { value?: unknown; children?: ComponentChildren }) {
  const { value: selected, onChange, setOpen } = useContext(ListboxCtx);
  const [focus, setFocus] = useState(false);
  const isSelected =
    selected === value || (selected != null && value != null && JSON.stringify(selected) === JSON.stringify(value));
  return (
    <El
      role="option"
      aria-selected={isSelected}
      data-selected={isSelected ? "" : undefined}
      data-focus={focus ? "" : undefined}
      onMouseEnter={() => setFocus(true)}
      onMouseLeave={() => setFocus(false)}
      onClick={() => {
        onChange(value);
        setOpen(false);
      }}
      {...rest}
    >
      {children}
    </El>
  );
}

export function Label({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  return (
    <El as="label" {...rest}>
      {children}
    </El>
  );
}

// ── Combobox ──────────────────────────────────────────────────────────────

type ComboboxBag = {
  value: unknown;
  onChange: (v: unknown) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  activeOption: unknown;
  setActiveOption: (v: unknown) => void;
};
const ComboboxCtx = createContext<ComboboxBag>({
  value: undefined,
  onChange: () => {},
  open: false,
  setOpen: () => {},
  activeOption: undefined,
  setActiveOption: () => {},
});

export function Combobox({
  value,
  onChange,
  children,
  ...rest
}: Rest & {
  value?: unknown;
  onChange?: (v: unknown) => void;
  children?: ComponentChildren | ((bag: { activeOption: unknown }) => ComponentChildren);
}) {
  const [open, setOpen] = useState(true);
  const [activeOption, setActiveOption] = useState<unknown>(undefined);
  const bag: ComboboxBag = {
    value,
    onChange: onChange ?? (() => {}),
    open,
    setOpen,
    activeOption,
    setActiveOption,
  };
  const body = typeof children === "function" ? children({ activeOption }) : children;
  return (
    <ComboboxCtx.Provider value={bag}>
      <El {...rest}>{body}</El>
    </ComboboxCtx.Provider>
  );
}

export function ComboboxInput({
  displayValue,
  onChange,
  ...rest
}: Rest & { displayValue?: (v: unknown) => string; onChange?: (e: Event) => void }) {
  const { value, setOpen } = useContext(ComboboxCtx);
  const shown = displayValue && value != null ? displayValue(value) : undefined;
  return (
    <input
      {...split(rest)}
      value={shown}
      onFocus={() => setOpen(true)}
      onChange={onChange as JSX.GenericEventHandler<HTMLInputElement>}
    />
  );
}

export function ComboboxButton({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  const { open, setOpen } = useContext(ComboboxCtx);
  return (
    <El as="button" type="button" aria-expanded={open} onClick={() => setOpen(!open)} {...rest}>
      {children}
    </El>
  );
}

export function ComboboxOptions({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  const { open } = useContext(ComboboxCtx);
  if (!open) return null;
  return (
    <El role="listbox" {...rest}>
      {children}
    </El>
  );
}

export function ComboboxOption({ value, children, ...rest }: Rest & { value?: unknown; children?: ComponentChildren }) {
  const { onChange, setOpen, setActiveOption, value: selected } = useContext(ComboboxCtx);
  const [focus, setFocus] = useState(false);
  const isSelected = selected === value;
  return (
    <El
      role="option"
      data-focus={focus ? "" : undefined}
      data-selected={isSelected ? "" : undefined}
      onMouseEnter={() => {
        setFocus(true);
        setActiveOption(value);
      }}
      onMouseLeave={() => setFocus(false)}
      onClick={() => {
        onChange(value);
        setOpen(false);
      }}
      {...rest}
    >
      {children}
    </El>
  );
}

// ── Disclosure ────────────────────────────────────────────────────────────

type DiscBag = { open: boolean; setOpen: (v: boolean) => void };
const DiscCtx = createContext<DiscBag>({ open: false, setOpen: () => {} });

export function Disclosure({
  defaultOpen = false,
  children,
  ...rest
}: Rest & { defaultOpen?: boolean; children?: ComponentChildren }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <DiscCtx.Provider value={{ open, setOpen }}>
      <El data-open={open ? "" : undefined} {...rest}>
        {children}
      </El>
    </DiscCtx.Provider>
  );
}

export function DisclosureButton({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  const { open, setOpen } = useContext(DiscCtx);
  return (
    <El
      as="button"
      type="button"
      aria-expanded={open}
      data-open={open ? "" : undefined}
      onClick={() => setOpen(!open)}
      {...rest}
    >
      {children}
    </El>
  );
}

export function DisclosurePanel({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  const { open } = useContext(DiscCtx);
  if (!open) return null;
  return <El {...rest}>{children}</El>;
}

// ── Popover ───────────────────────────────────────────────────────────────

type PopBag = { open: boolean; setOpen: (v: boolean) => void };
const PopCtx = createContext<PopBag>({ open: false, setOpen: () => {} });

export function Popover({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  return (
    <PopCtx.Provider value={{ open, setOpen }}>
      <El data-open={open ? "" : undefined} {...rest}>
        {children}
      </El>
    </PopCtx.Provider>
  );
}

export function PopoverButton({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  const { open, setOpen } = useContext(PopCtx);
  return (
    <El as="button" type="button" aria-expanded={open} onClick={() => setOpen(!open)} {...rest}>
      {children}
    </El>
  );
}

export function PopoverPanel({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  const { open } = useContext(PopCtx);
  if (!open) return null;
  return <El {...rest}>{children}</El>;
}

// ── Tabs ──────────────────────────────────────────────────────────────────

type TabBag = { selected: number; setSelected: (n: number) => void; register: () => number };
const TabCtx = createContext<TabBag>({
  selected: 0,
  setSelected: () => {},
  register: () => 0,
});

export function TabGroup({
  defaultIndex = 0,
  children,
  ...rest
}: Rest & { defaultIndex?: number; children?: ComponentChildren }) {
  const [selected, setSelected] = useState(defaultIndex);
  const counter = useRef(0);
  // Reset the register counter each render so Tab buttons get 0..n.
  counter.current = 0;
  const register = () => counter.current++;
  return (
    <TabCtx.Provider value={{ selected, setSelected, register }}>
      <El {...rest}>{children}</El>
    </TabCtx.Provider>
  );
}

export function TabList({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  return (
    <El role="tablist" {...rest}>
      {children}
    </El>
  );
}

export function Tab({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  const { selected, setSelected, register } = useContext(TabCtx);
  const id = useRef<number | null>(null);
  if (id.current === null) id.current = register();
  const i = id.current;
  const on = selected === i;
  return (
    <El
      as="button"
      type="button"
      role="tab"
      aria-selected={on}
      data-selected={on ? "" : undefined}
      onClick={() => setSelected(i)}
      {...rest}
    >
      {children}
    </El>
  );
}

/** `register` hands each TabPanel its index on first render, in mount order. */
type PanelBag = { selected: number; register: () => number };
const PanelCtx = createContext<PanelBag>({ selected: 0, register: () => 0 });

export function TabPanels({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  const { selected } = useContext(TabCtx);
  const counter = useRef(0);
  counter.current = 0;
  return (
    <PanelCtx.Provider value={{ selected, register: () => counter.current++ }}>
      <El {...rest}>{children}</El>
    </PanelCtx.Provider>
  );
}

export function TabPanel({ children, ...rest }: Rest & { children?: ComponentChildren }) {
  const { selected, register } = useContext(PanelCtx);
  const id = useRef<number | null>(null);
  if (id.current === null) id.current = register();
  if (selected !== id.current) return null;
  return (
    <El role="tabpanel" {...rest}>
      {children}
    </El>
  );
}
