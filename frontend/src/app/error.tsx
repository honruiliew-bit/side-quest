"use client";

import { useEffect } from "react";

const RELOADED = "sidequest.reloaded-after-deploy";

/** A new deploy replaces the page's script files. A tab opened before it asks for files that are gone,
 *  so reload once to pick up the new version. Anything else shows a plain message with a retry. */
function isStaleBuild(error: Error) {
  return /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(
    `${error.name} ${error.message}`,
  );
}

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
    if (!isStaleBuild(error)) return;
    try {
      // Once a minute at most, so a real bug can't cause a reload loop.
      if (Date.now() - Number(sessionStorage.getItem(RELOADED) || 0) < 60_000) return;
      sessionStorage.setItem(RELOADED, String(Date.now()));
    } catch {
      /* private mode: reload anyway, once per page load */
    }
    window.location.reload();
  }, [error]);

  return (
    <main className="mx-auto flex max-w-page flex-col gap-4 px-4 py-16 sm:px-10">
      <h1 className="display text-[44px]">Something broke on this page</h1>
      <p className="max-w-[560px] text-[17px]">
        {isStaleBuild(error) ? "Sidequest was just updated. Reloading should fix it." : "Try again. If it keeps happening, reload the page."}
      </p>
      <div className="flex gap-3">
        <button className="btn btn-ink" onClick={() => reset()}>Try again</button>
        <button className="btn btn-ghost" onClick={() => window.location.reload()}>Reload</button>
      </div>
    </main>
  );
}
