import type { DeliverCronMail } from "./ticker";

/** A system-trigger deliverer, shaped like `@corbits/webhooks`'s
 * `MailDeliverer`. Structural so this package stays free of it. */
export type RunTriggerDeliverer = {
  to: (
    address: string,
    content: string,
    tenantId: string,
    subject: string | undefined,
  ) => Promise<void>;
};

/** Fan a due schedule's recipients out over a run-trigger deliverer. */
export function createRunTriggerCronDeliver(deliverer: RunTriggerDeliverer): DeliverCronMail {
  return async (message) => {
    for (const address of message.to) {
      await deliverer.to(address, message.body, message.tenantId, message.subject);
    }
  };
}
