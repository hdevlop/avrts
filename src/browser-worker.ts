import { installAVRWorker } from "./browser-runtime";
import type { WorkerScopeLike } from "./browser-runtime";

installAVRWorker(self as unknown as WorkerScopeLike);
