"use client";

/** Last resort when the root layout itself fails. Plain HTML, no app styles. */
export default function GlobalError({ error }: { error: Error }) {
  const stale = /ChunkLoadError|Loading chunk|dynamically imported module|module script failed/i.test(`${error?.name} ${error?.message}`);
  if (stale && typeof window !== "undefined") {
    try {
      if (Date.now() - Number(sessionStorage.getItem("sidequest.reloaded-after-deploy") || 0) > 60_000) {
        sessionStorage.setItem("sidequest.reloaded-after-deploy", String(Date.now()));
        window.location.reload();
      }
    } catch {
      /* ignore */
    }
  }
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#e9ede4", color: "#1a2130", padding: 40 }}>
        <h1>Sidequest hit an error</h1>
        <p>{stale ? "The site was just updated. Reload the page." : "Reload the page to try again."}</p>
        <button onClick={() => window.location.reload()} style={{ padding: "10px 16px", fontWeight: 700 }}>Reload</button>
      </body>
    </html>
  );
}
