// Server entry point: checks settings, then starts the app on 127.0.0.1.
import { config } from "./config.js";
import { createApp } from "./app.js";

if (!config.githubToken) {
  console.error(
    "GITHUB_TOKEN is missing. Copy .env.example to .env in the project root " +
      "and set GITHUB_TOKEN to a fine-grained, read-only GitHub token.",
  );
  process.exit(1);
}

createApp().listen(config.port, config.host, () => {
  console.log(`Server running at http://${config.host}:${config.port}`);
});
