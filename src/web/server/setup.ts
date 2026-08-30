import { createServerFn } from "@tanstack/react-start";

import { createFirstUser, CreateFirstUser, hasAnyUser } from "../../server/setup.ts";
import { readable } from "./guard.ts";

/**
 * The first-run screen, and the only pair of functions here with no session
 * behind them -- by definition: there is nobody to be signed in as yet.
 *
 * `hasUsers` is what closes the door. The create form is shown only while the
 * answer is false, and creating refuses once it is true, so there is no window
 * after the first visit in which a stranger could claim the instance.
 */
export const getSetupState = createServerFn().handler(() => ({ hasUsers: hasAnyUser() }));

export const createFirstAccount = createServerFn({ method: "POST" })
  .validator(CreateFirstUser)
  .handler(({ data }) => readable(() => createFirstUser(data)));
