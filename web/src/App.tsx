// The top of the web app. It holds:
//  - which view is showing (the repo browser or the chat)
//  - the selected repo and its chat messages
//  - the light/dark theme, shown as a toggle in the header of both views
import { GitBranch, Moon, Sun } from "lucide-react";
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
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <GitBranch size={16} strokeWidth={2} />
            </span>
            <div className="brand-text">
              <h1 className="brand-name">Repo Assistant</h1>
              <span className="brand-sub">GitHub Repository AI Assistant</span>
            </div>
          </div>
          <button
            className="icon-button"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
            title={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
          >
            {theme === "light" ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}
          </button>
        </div>
      </header>

      {view === "chat" && repo ? (
        <Chat repo={repo} messages={messages} setMessages={setMessages} onBack={() => setView("browser")} />
      ) : (
        <RepoBrowser onOpenChat={openChat} />
      )}
    </>
  );
}
