import { startApplication } from "./startup-error";

// Dynamic import lets recovery run even when the application module graph cannot load.
void startApplication(() => import("./main"));
