import { expect, test } from "bun:test";
import * as packageRoot from "../src/public";
import * as browserApi from "../src/public/browser";
import * as advancedApi from "../src/public/advanced";

test("published root stays limited to the function-first AVR facade", () => {
  expect(Object.keys(packageRoot).sort()).toEqual(["AVR"]);
});

test("browser and advanced APIs require explicit subpaths", () => {
  expect(typeof browserApi.createAVRWorkerRuntime).toBe("function");
  expect(typeof advancedApi.CPU).toBe("function");
  expect(advancedApi.AVR).toBe(packageRoot.AVR);
  expect(advancedApi.AVR_SNAPSHOT_VERSION).toBe(packageRoot.AVR().snapshot().version!);
});
