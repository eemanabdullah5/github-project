// The top of the web app. It holds:
//  - which view is showing (the repo browser or the chat)
//  - the selected repo and its chat messages
//  - the light/dark theme, shown as a toggle in the header of both views
import { useEffect, useState } from "react";
import type { ChatMessage, Repo } from "./api";
import Chat from "./views/Chat";
import RepoBrowser from "./views/RepoBrowser";

type Theme = "light" | "dark";

/** The saved theme choice, or the operating system's setting if the user hasn't chosen yet. */
function initialTheme(): Theme {
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const [view, setView] = useState<"browser" | "chat">("browser");
  const [repo, setRepo] = useState<Repo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [theme, setTheme] = useState<Theme>(initialTheme);

  // Apply the theme to the page (index.css reads data-theme) and remember the choice.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  /** Opens the chat for a repo. Switching to a different repo clears the previous chat. */
  function openChat(next: Repo) {
    if (next.repoId !== repo?.repoId) setMessages([]);
    setRepo(next);
    setView("chat");
  }

  return (
    <div className="container">
      <header className="app-header">
        <h1>GitHub Repository AI Assistant</h1>
        <button
          className="secondary"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          aria-label="Toggle light and dark theme"
        >
          {theme === "light" ? "🌙 Dark" : "☀️ Light"}
        </button>
      </header>

      {view === "chat" && repo ? (
        <Chat repo={repo} messages={messages} setMessages={setMessages} onBack={() => setView("browser")} />
      ) : (
        <RepoBrowser onOpenChat={openChat} />
      )}
    </div>
  );
}
