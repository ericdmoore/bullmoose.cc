import { MethodRegistry } from "@bullmoose/jmap-core";
import type { RequestContext } from "./common";
import { registerMailboxMethods } from "./mailbox";
import { registerEmailMethods } from "./email";
import { registerThreadMethods } from "./thread";
import { registerIdentityMethods } from "./identity";
import { registerSubmissionMethods } from "./submission";
import { registerAgentMethods } from "./agent";
import { registerAgentBindingMethods } from "./agentBinding";
import { registerActionProposalMethods } from "./actionProposal";
import { registerWatchMethods } from "./watch";
import { registerGoalMethods } from "./goal";
import { registerAnnotationMethods } from "./annotation";
import { registerNoteMethods } from "./note";
import { registerVacationMethods } from "./vacation";
import { registerSieveMethods } from "./sieve";
import { registerContactsMethods } from "./contacts";
import { registerCalendarMethods } from "./calendars";
import { registerFileNodeMethods } from "./filenode";
import { registerProviderCredentialMethods } from "./providerCredential";
import { registerDeviceReportMethods } from "./deviceReport";

export type { RequestContext } from "./common";

export function buildRegistry(): MethodRegistry<RequestContext> {
  const registry = new MethodRegistry<RequestContext>();
  registry.register("Core/echo", async (args) => args);
  registerMailboxMethods(registry);
  registerEmailMethods(registry);
  registerThreadMethods(registry);
  registerIdentityMethods(registry);
  registerSubmissionMethods(registry);
  registerAgentMethods(registry);
  registerAgentBindingMethods(registry);
  registerActionProposalMethods(registry);
  registerWatchMethods(registry);
  registerGoalMethods(registry);
  registerAnnotationMethods(registry);
  registerNoteMethods(registry);
  registerVacationMethods(registry);
  registerSieveMethods(registry);
  registerContactsMethods(registry);
  registerCalendarMethods(registry);
  registerFileNodeMethods(registry);
  registerProviderCredentialMethods(registry);
  registerDeviceReportMethods(registry);
  return registry;
}
