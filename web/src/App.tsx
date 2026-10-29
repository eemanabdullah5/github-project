import { useEffect, useState } from "react";
import { getHealth } from "./api";

type ServerState = "checking" | "ok" | "down";

export default function App() {
  const [server, setServer] = useState<ServerState>("checking");

  useEffect(() => {
    getHealth()
      .then((h) => setServer(h.ok ? "ok" : "down"))
      .catch(() => setServer("down"));
  }, []);

  return (
    <main className="container">
      <h1>GitHub Repository AI Assistant</h1>
      <p>
        Server:{" "}
        {server === "checking" && "checking…"}
        {server === "ok" && <strong className="ok">connected</strong>}
        {server === "down" && <strong className="down">not reachable — is the server running?</strong>}
      </p>
    </main>
  );
}
