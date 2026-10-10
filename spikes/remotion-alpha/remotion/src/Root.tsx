// PROTOTYPE, throwaway. Same geometry as spikes/hyperframes-alpha: 8 s, 2560x1440, 30 fps.
import { Composition } from "remotion";
import { Card } from "./Card";

export const Root = () => (
  <Composition id="Card" component={Card} durationInFrames={240} fps={30} width={2560} height={1440} defaultProps={{ title: "Frameshell" }} />
);
