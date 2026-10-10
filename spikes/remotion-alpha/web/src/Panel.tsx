// PROTOTYPE, throwaway. A "web app" component: uses hooks, so a second React copy would break it.
import { useMemo, useState } from "react";

export function Panel({ title }: { title: string }) {
  const [label] = useState(title);
  const upper = useMemo(() => label.toUpperCase(), [label]);
  return (
    <div
      style={{
        position: "absolute",
        left: 1100,
        top: 700,
        width: 900,
        height: 400,
        background: "rgba(30, 90, 200, 0.6)",
        borderRadius: 24,
        color: "white",
        fontSize: 72,
        fontFamily: "sans-serif",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {upper}
    </div>
  );
}
