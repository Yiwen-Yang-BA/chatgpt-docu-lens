import { createApp } from "./lib/server.mjs";
import { run } from "./project.mjs";
import { fileURLToPath } from "node:url";
const server = createApp({
  project: {
    id: "chatgpt-docu-lens",
    title: "Docu Lens",
    root: fileURLToPath(new URL(".", import.meta.url)),
  },
  run,
});
const port = Number(process.env.PORT || 3103);
server.listen(port, process.env.HOST || "127.0.0.1", () =>
  console.log(
    "Docu Lens" + " → http://" + (process.env.HOST || "127.0.0.1") + ":" + port,
  ),
);
