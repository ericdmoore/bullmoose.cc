/** @jsxImportSource preact */
import { avatarClasses, avatarInitial, cx, type AvatarSize } from "../../lib/ui/classes";

/** The initial-in-a-circle identity mark (the ShellNav header treatment, made
 *  a primitive). Give it a name or an email; it shows the first letter. */
export default function Avatar({
  name,
  size = "md",
  class: cls,
}: {
  name: string | undefined | null;
  size?: AvatarSize;
  class?: string;
}) {
  return (
    <span class={cx(avatarClasses(size), cls)} aria-hidden="true">
      {avatarInitial(name)}
    </span>
  );
}
