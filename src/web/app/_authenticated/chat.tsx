import { createFileRoute } from "@tanstack/react-router";

import { ChatPage } from "../../routes/chat.tsx";

export const Route = createFileRoute("/_authenticated/chat")({ component: ChatPage });
