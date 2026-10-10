// PROTOTYPE, throwaway. No page background: empty pixels must stay transparent.
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Panel } from "../../web/src/Panel";

export const Card = ({ title }: { title: string }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const fade = interpolate(frame, [0, fps / 2, durationInFrames - fps / 2, durationInFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // Scale the 2560x1440 design to whatever size the render asks for.
  const k = width / 2560;
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 2560, height: 1440, transform: `scale(${k}, ${height / 1440})`, transformOrigin: "0 0" }}>
        <Panel title={title} />
        <div style={{ position: "absolute", left: 2080, top: 290, width: 100, height: 100, borderRadius: 50, background: "rgb(255, 80, 40)" }} />
      </div>
    </AbsoluteFill>
  );
};
