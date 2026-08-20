/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { cx, inputClasses } from "../../lib/ui/classes";

/** A labelled control — Tailwind UI `forms/input-groups` spacing. */
export default function Field({
  label,
  hint,
  error,
  class: cls,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  class?: string;
  children: ComponentChildren;
}) {
  return (
    <label class={cx("block", cls)}>
      <span class="block text-sm/6 font-medium text-gray-900 dark:text-white">{label}</span>
      <div class="mt-2">{children}</div>
      {error ? (
        <p class="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : hint ? (
        <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">{hint}</p>
      ) : null}
    </label>
  );
}

type WithClass<T> = Omit<T, "class"> & { class?: string };

export function Input({ class: cls, ...rest }: WithClass<preact.JSX.IntrinsicElements["input"]>) {
  return <input {...rest} class={cx(inputClasses(), cls)} />;
}

export function Textarea({ class: cls, ...rest }: WithClass<preact.JSX.IntrinsicElements["textarea"]>) {
  return <textarea {...rest} class={cx(inputClasses(), "resize-y", cls)} />;
}

export function Select({ class: cls, ...rest }: WithClass<preact.JSX.IntrinsicElements["select"]>) {
  return <select {...rest} class={cx(inputClasses(), cls)} />;
}
