import type { JSX } from "preact";

/**
 * Props accepted by every inlined Heroicon in this kit.
 *
 * An icon renders exactly one <svg> and forwards what it is given to it, so it
 * accepts the SVG attributes Preact accepts — nothing invented. Preact's
 * SVGAttributes already extends HTMLAttributes, which is where `class` and the
 * React-style `className` alias both come from; the Tailwind UI templates we
 * port pass `className`, and it type-checks for that reason rather than by
 * special-casing here.
 *
 * `viewBox` and `stroke` are excluded. Both are genuine SVG attributes, but
 * each icon hard-codes its own viewBox, and `stroke` is destructured off as an
 * internal fill-vs-stroke *flag* rather than the paint value its SVG name
 * implies. A caller passing either would have it silently swallowed, so
 * accepting them would be a lie about what the component does.
 */
export interface IconProps extends Omit<JSX.SVGAttributes<SVGSVGElement>, "viewBox" | "stroke"> {}
