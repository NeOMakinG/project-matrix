import { setupServer } from "msw/node";
import { restHandlers as handlers } from "@/mocks/handlers";

export const server = setupServer(...handlers);
