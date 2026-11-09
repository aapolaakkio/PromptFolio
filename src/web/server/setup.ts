import { createServerFn } from "@tanstack/react-start";

import { createFirstUser, CreateFirstUser, hasAnyUser } from "../../server/setup.ts";
import { readable } from "./guard.ts";

/** First-run screen: the only functions with no session. The create form shows only while `hasUsers` is false and creating refuses once true, so no window exists to claim the instance. */
export const getSetupState = createServerFn().handler(async () => ({
  hasUsers: await hasAnyUser(),
}));

export const createFirstAccount = createServerFn({ method: "POST" })
  .validator(CreateFirstUser)
  .handler(({ data }) => readable(() => createFirstUser(data)));
