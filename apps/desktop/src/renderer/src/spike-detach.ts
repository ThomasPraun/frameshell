import { useEffect, useRef, useState } from "react";

/**
 * SPIKE (ADR 0012): open an auxiliary window scripted by this renderer and
 * return a host element in it for a React portal. `name` null closes it.
 * `onClosed` runs when the user closes the window.
 */
export function useDetachedWindow(name: string | null, onClosed: () => void): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const closed = useRef(onClosed);
  closed.current = onClosed;
  useEffect(() => {
    if (!name) return;
    const child = window.open("about:blank", `frameshell-panel:${name}`, "width=960,height=600");
    if (!child) return;
    const doc = child.document;
    doc.title = `Frameshell — ${name}`;
    for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) doc.head.appendChild(node.cloneNode(true));
    doc.documentElement.className = document.documentElement.className;
    doc.body.className = document.body.className;
    const root = doc.createElement("div");
    root.className = "detached-root";
    root.setAttribute("data-testid", `detached-${name}`);
    root.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
    doc.body.appendChild(root);
    let disposing = false;
    child.addEventListener("pagehide", () => {
      if (!disposing) closed.current();
    });
    setHost(root);
    return () => {
      disposing = true;
      setHost(null);
      child.close();
    };
  }, [name]);
  return host;
}
