const core = await import("./packages/core/dist/index.js");
const { DeepbridFinderClient } = await import("./packages/core/dist/builtins/deepbrid-usenet/client.js");

// Read api key from sqlite or test
await core.initDb("sqlite::memory:");
const apiKey = process.env.DEEPBRID_API_KEY;
if (!apiKey) {
  console.log("No local DEEPBRID_API_KEY env");
}
