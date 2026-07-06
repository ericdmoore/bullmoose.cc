import { MethodRegistry } from "@bullmoose/jmap-core";
import type { RequestContext } from "./common";
import { registerMailboxMethods } from "./mailbox";
import { registerEmailMethods } from "./email";
import { registerThreadMethods } from "./thread";
import { registerIdentityMethods } from "./identity";
import { registerSubmissionMethods } from "./submission";

export type { RequestContext } from "./common";

export function buildRegistry(): MethodRegistry<RequestContext> {
  const registry = new MethodRegistry<RequestContext>();
  registry.register("Core/echo", async (args) => args);
  registerMailboxMethods(registry);
  registerEmailMethods(registry);
  registerThreadMethods(registry);
  registerIdentityMethods(registry);
  registerSubmissionMethods(registry);
  return registry;
}
