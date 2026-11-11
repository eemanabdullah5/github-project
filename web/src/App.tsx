// The top of the web app. It holds:
//  - which view is showing (the repo browser or the chat)
//  - the selected repo, its chat messages, and which saved chat they belong to
//  - the light/dark theme, shown as a toggle in the header of both views
import { GitBranch, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getChat, listChats, type ChatMessage, type Repo } from "./api";
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
  const [conversationId, setConversationId] = useState<string | null>(null); // saved chat being shown (null = new chat)
  const openingRepo = useRef(""); // the repo whose saved chat is loading. Why: ignore a late reply after switching repo
  const [theme, setTheme] = useState<Theme>(initialTheme);

  // Apply the theme to the page (index.css reads data-theme) and remember the choice.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  /**
   * Opens the chat for a repo. Switching to a different repo replaces the chat with that repo's
   * most recent saved chat (or an empty one if it has none). Reopening the same repo keeps the chat as it is.
   */
  async function openChat(next: Repo) {
    setRepo(next);
    setView("chat");
    if (next.repoId === repo?.repoId) return;
    setMessages([]);
    setConversationId(null);
    openingRepo.current = next.repoId;
    try {
      const [latest] = await listChats(next.owner, next.name);
      if (!latest) return;
      const chat = await getChat(next.owner, next.name, latest.id);
      if (openingRepo.current !== next.repoId) return; // the user already opened another repo
      setMessages(chat.messages);
      setConversationId(chat.id);
    } catch {
      // Couldn't load saved chats: start with an empty chat. Asking a question still works.
    }
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
        <Chat
          repo={repo}
          messages={messages}
          setMessages={setMessages}
          conversationId={conversationId}
          setConversationId={setConversationId}
          onBack={() => setView("browser")}
        />
      ) : (
        <RepoBrowser onOpenChat={openChat} />
      )}
    </>
  );
}
