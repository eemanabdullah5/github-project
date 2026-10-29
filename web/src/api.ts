// Typed calls to the server API (ARCHITECTURE §4.2). The UI talks to the server only through here.

export async function getHealth(): Promise<{ ok: boolean }> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}
