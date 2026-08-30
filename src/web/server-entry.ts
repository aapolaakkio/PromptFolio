import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

import { register } from "./instrumentation.ts";

register();

export default { fetch: createStartHandler(defaultStreamHandler) };
